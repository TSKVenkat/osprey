import {
  ChunkCoalescer,
  type BubblePosition,
  type BubbleSize,
  MemoryPartStore,
  OpfsPartStore,
  UploadScheduler,
  type Part,
  type PartStore,
  type StoredManifest,
  type UploadSessionInfo,
  browserSupportCheck,
  concurrencyFor,
  createTransport,
  pickMimeType,
  supportsSystemAudio,
} from '@osprey/recorder';

import { api, uploadApiFor } from './api.ts';
import { Composite } from './composite.ts';

export interface CaptureOptions {
  /** Optional: a recording is named after the fact, not before. */
  title?: string;
  microphone: boolean;
  systemAudio: boolean;
  /** Show the presenter in a circle, burnt into the recording. */
  camera: boolean;
  cameraDeviceId?: string;
  microphoneDeviceId?: string;
  position?: BubblePosition;
  size?: BubbleSize;
  /**
   * Whether a floating window is available to hold the camera. Known before the
   * screen is shared, and part of deciding how the camera gets recorded.
   */
  canFloat?: boolean;
}

/**
 * How the camera reaches the recording.
 *
 * `on-screen` puts it in a small always-on-top window that is dragged around the
 * real screen and captured because it is genuinely there, which is how a desktop
 * recorder does it and the only way the thing being dragged is the bubble itself.
 * It needs the whole screen to be shared: a window or tab capture does not contain
 * that floating window, so the camera would simply be missing.
 *
 * `composited` paints the camera into the picture instead. It works whatever is
 * being shared, and the bubble is moved on a preview rather than in place.
 */
export type CameraMode = 'on-screen' | 'composited' | 'none';

export type CaptureSurface = 'monitor' | 'window' | 'browser' | 'unknown';

export interface CaptureDevice {
  deviceId: string;
  label: string;
}

/**
 * Cameras and microphones the browser will admit to.
 *
 * Labels are empty until permission has been granted at least once, so a picker
 * shown before then can only offer "Camera 1". Asking first, briefly, is what
 * makes the list readable — which is why this takes a stream and releases it.
 */
export async function listDevices(): Promise<{
  cameras: CaptureDevice[];
  microphones: CaptureDevice[];
}> {
  let probe: MediaStream | null = null;
  try {
    probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    // Denied or unavailable. The list still works, just without readable names.
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const track of probe?.getTracks() ?? []) track.stop();

  const named = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((device) => device.kind === kind)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }));

  return {
    cameras: named('videoinput', 'Camera'),
    microphones: named('audioinput', 'Microphone'),
  };
}

export interface CaptureProgress {
  /** Bytes handed to the recorder so far. */
  recordedBytes: number;
  /** Bytes the server has confirmed. */
  uploadedBytes: number;
  partsPending: number;
}

export interface CaptureHandlers {
  onProgress?: (progress: CaptureProgress) => void;
  /** Fires when the user stops sharing from the browser's own toolbar. */
  onEndedByBrowser?: () => void;
}

export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** How often MediaRecorder hands over a chunk. Short enough that little is at risk
 *  when a tab dies, long enough that the callback rate is irrelevant. */
const TIMESLICE_MS = 3000;

export function chooseStore(): { store: PartStore; durable: boolean } {
  // Without OPFS there is nowhere to survive a tab crash. The interface says so
  // rather than quietly recording with no safety net.
  return OpfsPartStore.isAvailable()
    ? { store: new OpfsPartStore(), durable: true }
    : { store: new MemoryPartStore(), durable: false };
}

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    typeof MediaRecorder !== 'undefined' &&
    pickMimeType(browserSupportCheck()) !== null
  );
}

export function systemAudioAvailable(): boolean {
  return typeof navigator !== 'undefined' && supportsSystemAudio(navigator.userAgent);
}

/**
 * One recording, from asking for the screen to holding a finished link.
 *
 * Parts are uploaded while the recording is still going, so stopping only has to
 * flush what is left rather than send the whole file.
 */
export class Capture {
  private recordedBytes = 0;
  private uploadedBytes = 0;
  private stopped = false;
  // Written next to the parts so a tab that dies leaves enough behind to work out
  // what happened. Without it the spilled parts are bytes with no context.
  private manifest: StoredManifest | null = null;
  private running: Promise<{ failures: unknown[] }> = Promise.resolve({ failures: [] });

  readonly stream: MediaStream;
  readonly session: UploadSessionInfo;
  readonly durableStorage: boolean;
  /** Null when recording without a camera; there is nothing to compose then. */
  readonly composite: Composite | null;
  /** The raw camera feed, for a self-view. Null when recording without one. */
  readonly cameraStream: MediaStream | null;
  /** How the camera reaches the recording: a window on screen, or painted in. */
  readonly cameraMode: CameraMode;
  /** What the person chose to share. */
  readonly surface: CaptureSurface;
  /** The screen, microphone and camera streams, so every one can be released. */
  private readonly sources: MediaStream[];
  private readonly recorder: MediaRecorder;
  private readonly coalescer: ChunkCoalescer;
  private readonly scheduler: UploadScheduler;
  private readonly store: PartStore;
  private readonly handlers: CaptureHandlers;

  private constructor(parts: {
    stream: MediaStream;
    session: UploadSessionInfo;
    durableStorage: boolean;
    composite: Composite | null;
    cameraStream: MediaStream | null;
    cameraMode: CameraMode;
    surface: CaptureSurface;
    sources: MediaStream[];
    recorder: MediaRecorder;
    coalescer: ChunkCoalescer;
    scheduler: UploadScheduler;
    store: PartStore;
    handlers: CaptureHandlers;
  }) {
    this.stream = parts.stream;
    this.session = parts.session;
    this.durableStorage = parts.durableStorage;
    this.composite = parts.composite;
    this.cameraStream = parts.cameraStream;
    this.cameraMode = parts.cameraMode;
    this.surface = parts.surface;
    this.sources = parts.sources;
    this.recorder = parts.recorder;
    this.coalescer = parts.coalescer;
    this.scheduler = parts.scheduler;
    this.store = parts.store;
    this.handlers = parts.handlers;
  }

  static async start(options: CaptureOptions, handlers: CaptureHandlers = {}): Promise<Capture> {
    const mimeType = pickMimeType(browserSupportCheck());
    if (!mimeType) throw new Error('This browser cannot record video.');

    const { stream, composite, camera, cameraMode, surface, sources } = await buildStream(options);
    const session = await api.startRecording({
      title: options.title ?? 'Untitled recording',
      mimeType,
      recordedWith: {
        userAgent: navigator.userAgent,
        mimeType,
        systemAudio: options.systemAudio && systemAudioAvailable(),
        microphone: options.microphone,
      },
    });

    const { store, durable } = chooseStore();

    // The transport reports progress to the capture, and the capture needs the
    // transport to exist first. This holder breaks the cycle without a forward
    // reference to a variable that is not assigned yet.
    const progress = { confirmed: (_bytes: number) => {} };
    const transport = createTransport({
      api: uploadApiFor(),
      store,
      recordingId: session.recordingId,
      sessionId: session.uploadSessionId,
      onProgress: (_partNumber, bytes) => progress.confirmed(bytes),
    });

    const capture = new Capture({
      stream,
      session,
      durableStorage: durable,
      recorder: new MediaRecorder(stream, { mimeType }),
      composite,
      cameraStream: camera,
      cameraMode,
      surface,
      sources,
      coalescer: new ChunkCoalescer(session.partSize),
      scheduler: new UploadScheduler({
        transport,
        concurrency: concurrencyFor(session.capabilities),
      }),
      store,
      handlers,
    });

    progress.confirmed = (bytes) => capture.countUploaded(bytes);
    return capture.begin();
  }

  private begin(): Capture {
    this.manifest = {
      recordingId: this.session.recordingId,
      uploadSessionId: this.session.uploadSessionId,
      mimeType: this.recorder.mimeType,
      partSize: this.session.partSize,
      startedAt: Date.now(),
      state: 'recording',
      parts: [],
    };
    void this.store.saveManifest(this.manifest);

    this.recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.recordedBytes += event.data.size;
      const completed = this.coalescer.push(event.data);
      for (const part of completed) {
        // On disk before it is sent, and only released once the server confirms it.
        void this.spill(part).then(() => this.scheduler.enqueue(part));
      }

      // Whatever is not yet a whole part is written too. Without this a crash
      // loses everything recorded since the last part, which for a low-bitrate
      // recording can be the entire thing.
      const pending = this.coalescer.pending;
      void (pending
        ? this.store.putTail(this.session.recordingId, pending)
        : this.store.clearTail(this.session.recordingId));

      this.report();
    };

    // The browser has its own "stop sharing" control, and using it ends the track
    // without telling the page anything else.
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.handlers.onEndedByBrowser?.();
    });

    this.recorder.start(TIMESLICE_MS);
    this.running = this.scheduler.run();
    return this;
  }

  get progress(): CaptureProgress {
    return {
      recordedBytes: this.recordedBytes,
      uploadedBytes: this.uploadedBytes,
      partsPending: this.scheduler.pending,
    };
  }

  pause(): void {
    if (this.recorder.state === 'recording') this.recorder.pause();
  }

  resume(): void {
    if (this.recorder.state === 'paused') this.recorder.resume();
  }

  /**
   * Stops recording and waits for the tail to land. Everything before the tail is
   * already uploaded, which is why this takes seconds rather than minutes.
   */
  async stop(): Promise<{ recordingId: string }> {
    if (this.stopped) return { recordingId: this.session.recordingId };
    this.stopped = true;

    await new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
      if (this.recorder.state === 'inactive') resolve();
      else this.recorder.stop();
    });
    this.releaseDevices();

    const last = this.coalescer.flush();
    if (last) {
      await this.spill(last);
      this.scheduler.enqueue(last);
    }
    // The tail is now a real part, so the copy of it is redundant.
    await this.store.clearTail(this.session.recordingId);
    this.scheduler.close();
    await this.updateManifest({ state: 'uploading' });

    const { failures } = await this.running;
    if (failures.length > 0) {
      throw new Error(`${failures.length} part(s) could not be uploaded.`);
    }

    await api.completeUpload(this.session.uploadSessionId);
    await this.store.deleteRecording(this.session.recordingId);
    return { recordingId: this.session.recordingId };
  }

  /** Gives up on the recording and asks the server to release what was stored. */
  async cancel(): Promise<void> {
    this.stopped = true;
    this.recorder.stop();
    this.releaseDevices();
    this.scheduler.abort();
    await api.abortUpload(this.session.uploadSessionId).catch(() => undefined);
    await this.store.deleteRecording(this.session.recordingId);
  }

  /**
   * Lets go of the screen, the microphone and the camera.
   *
   * Every source has to be stopped, not just the stream being recorded: with a
   * camera the recorded stream is the canvas, and stopping only that leaves the
   * camera light on afterwards.
   */
  private releaseDevices(): void {
    this.composite?.stop();
    for (const source of this.sources) {
      for (const track of source.getTracks()) track.stop();
    }
    for (const track of this.stream.getTracks()) track.stop();
  }

  /** Writes a part to disk and records it in the manifest, in that order. */
  private async spill(part: Part): Promise<void> {
    await this.store.put(this.session.recordingId, part);
    await this.updateManifest({
      parts: [
        ...(this.manifest?.parts ?? []),
        { partNumber: part.partNumber, bytes: part.bytes, uploaded: false },
      ],
    });
  }

  private async updateManifest(changes: Partial<StoredManifest>): Promise<void> {
    if (!this.manifest) return;
    this.manifest = { ...this.manifest, ...changes };
    await this.store.saveManifest(this.manifest);
  }

  /** Called by the transport as each part is confirmed. */
  countUploaded(bytes: number): void {
    this.uploadedBytes += bytes;
    this.report();
  }

  private report(): void {
    this.handlers.onProgress?.(this.progress);
  }
}

/**
 * Screen video, plus whichever audio sources were asked for. When both the screen
 * and a microphone are wanted they have to be mixed, because a MediaStream can only
 * carry one audio track into MediaRecorder.
 */
/**
 * The stream that actually gets recorded.
 *
 * With no camera this is the screen as the browser handed it over. With one, it is
 * a canvas the screen and the camera are drawn onto — the bubble has to be part of
 * the picture, because the picture is what gets stored.
 */
async function buildStream(options: CaptureOptions): Promise<{
  stream: MediaStream;
  composite: Composite | null;
  camera: MediaStream | null;
  cameraMode: CameraMode;
  surface: CaptureSurface;
  sources: MediaStream[];
}> {
  const wantsSystemAudio = options.systemAudio && systemAudioAvailable();

  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: wantsSystemAudio ? ({ systemAudio: 'include' } as MediaTrackConstraints) : false,
  });

  const sources: MediaStream[] = [display];
  const surface = surfaceOf(display);

  let microphone: MediaStream | null = null;
  if (options.microphone) {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : {}),
      },
    });
    sources.push(microphone);
  }

  let camera: MediaStream | null = null;
  if (options.camera) {
    try {
      camera = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          ...(options.cameraDeviceId ? { deviceId: { exact: options.cameraDeviceId } } : {}),
        },
      });
      sources.push(camera);
    } catch {
      // No camera, or it is in use elsewhere. Recording the screen without it is
      // far better than refusing to record at all.
      camera = null;
    }
  }

  const audio = mixAudio(wantsSystemAudio ? display.getAudioTracks()[0] : undefined, microphone);
  const cameraMode = chooseCameraMode({
    camera: Boolean(camera),
    surface,
    canFloat: options.canFloat ?? false,
  });

  // With the bubble living in a window on the screen, the screen already contains
  // it. Compositing as well would record the presenter twice.
  if (cameraMode !== 'composited') {
    return {
      stream: new MediaStream([...display.getVideoTracks(), ...audio]),
      composite: null,
      camera,
      cameraMode,
      surface,
      sources,
    };
  }

  const composite = await Composite.start({
    screen: display,
    camera,
    position: options.position,
    size: options.size,
  });

  return {
    stream: new MediaStream([...composite.stream.getVideoTracks(), ...audio]),
    composite,
    camera,
    cameraMode,
    surface,
    sources,
  };
}

export function surfaceOf(display: MediaStream): CaptureSurface {
  const setting = display.getVideoTracks()[0]?.getSettings() as
    | { displaySurface?: string }
    | undefined;
  const surface = setting?.displaySurface;
  return surface === 'monitor' || surface === 'window' || surface === 'browser'
    ? surface
    : 'unknown';
}

/**
 * Whether the camera can be a real window on the screen, or has to be painted in.
 *
 * A floating window is only in the recording when the whole screen is being
 * shared. Sharing one window or one tab captures exactly that, so a bubble
 * floating above it is not in the picture at all — and the presenter would find
 * out only when they watched it back.
 */
export function chooseCameraMode(input: {
  camera: boolean;
  surface: CaptureSurface;
  canFloat: boolean;
}): CameraMode {
  if (!input.camera) return 'none';
  if (input.surface === 'monitor' && input.canFloat) return 'on-screen';
  return 'composited';
}

/**
 * One audio track out of however many were asked for.
 *
 * A MediaStream carries a single audio track into MediaRecorder, so wanting both
 * the screen and a microphone means mixing them first.
 */
function mixAudio(
  systemTrack: MediaStreamTrack | undefined,
  microphone: MediaStream | null,
): MediaStreamTrack[] {
  const microphoneTrack = microphone?.getAudioTracks()[0];
  if (!systemTrack && !microphoneTrack) return [];
  if (!systemTrack) return microphoneTrack ? [microphoneTrack] : [];
  if (!microphoneTrack) return [systemTrack];

  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  context.createMediaStreamSource(new MediaStream([systemTrack])).connect(destination);
  context.createMediaStreamSource(new MediaStream([microphoneTrack])).connect(destination);
  return destination.stream.getAudioTracks();
}
