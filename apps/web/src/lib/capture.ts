import {
  ChunkCoalescer,
  MemoryPartStore,
  OpfsPartStore,
  UploadScheduler,
  type PartStore,
  type UploadSessionInfo,
  browserSupportCheck,
  concurrencyFor,
  createTransport,
  pickMimeType,
  supportsSystemAudio,
} from '@openloom/recorder';

import { api, uploadApiFor } from './api.ts';

export interface CaptureOptions {
  title: string;
  microphone: boolean;
  systemAudio: boolean;
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
  private running: Promise<{ failures: unknown[] }> = Promise.resolve({ failures: [] });

  readonly stream: MediaStream;
  readonly session: UploadSessionInfo;
  readonly durableStorage: boolean;
  private readonly recorder: MediaRecorder;
  private readonly coalescer: ChunkCoalescer;
  private readonly scheduler: UploadScheduler;
  private readonly store: PartStore;
  private readonly handlers: CaptureHandlers;

  private constructor(parts: {
    stream: MediaStream;
    session: UploadSessionInfo;
    durableStorage: boolean;
    recorder: MediaRecorder;
    coalescer: ChunkCoalescer;
    scheduler: UploadScheduler;
    store: PartStore;
    handlers: CaptureHandlers;
  }) {
    this.stream = parts.stream;
    this.session = parts.session;
    this.durableStorage = parts.durableStorage;
    this.recorder = parts.recorder;
    this.coalescer = parts.coalescer;
    this.scheduler = parts.scheduler;
    this.store = parts.store;
    this.handlers = parts.handlers;
  }

  static async start(options: CaptureOptions, handlers: CaptureHandlers = {}): Promise<Capture> {
    const mimeType = pickMimeType(browserSupportCheck());
    if (!mimeType) throw new Error('This browser cannot record video.');

    const stream = await buildStream(options);
    const session = await api.startRecording({
      title: options.title,
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
    this.recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.recordedBytes += event.data.size;
      for (const part of this.coalescer.push(event.data)) {
        // On disk before it is sent, and only released once the server confirms it.
        void this.store.put(this.session.recordingId, part).then(() => {
          this.scheduler.enqueue(part);
        });
      }
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
    for (const track of this.stream.getTracks()) track.stop();

    const last = this.coalescer.flush();
    if (last) {
      await this.store.put(this.session.recordingId, last);
      this.scheduler.enqueue(last);
    }
    this.scheduler.close();

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
    for (const track of this.stream.getTracks()) track.stop();
    this.scheduler.abort();
    await api.abortUpload(this.session.uploadSessionId).catch(() => undefined);
    await this.store.deleteRecording(this.session.recordingId);
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
async function buildStream(options: CaptureOptions): Promise<MediaStream> {
  const wantsSystemAudio = options.systemAudio && systemAudioAvailable();

  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 } },
    audio: wantsSystemAudio ? ({ systemAudio: 'include' } as MediaTrackConstraints) : false,
  });

  if (!options.microphone) return display;

  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });

  const systemTrack = display.getAudioTracks()[0];
  if (!systemTrack) {
    return new MediaStream([...display.getVideoTracks(), ...microphone.getAudioTracks()]);
  }

  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  context.createMediaStreamSource(new MediaStream([systemTrack])).connect(destination);
  context.createMediaStreamSource(microphone).connect(destination);

  return new MediaStream([...display.getVideoTracks(), ...destination.stream.getAudioTracks()]);
}
