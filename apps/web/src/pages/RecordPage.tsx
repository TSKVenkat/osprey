import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';

import { DEFAULT_POSITION, type BubblePosition, type BubbleSize } from '@bilby/recorder';

import {
  Capture,
  type CaptureDevice,
  type CaptureProgress,
  cameraAvailable,
  canRecord,
  listDevices,
  systemAudioAvailable,
} from '../lib/capture.ts';
import { formatBytes } from '../lib/format.ts';
import { CheckIcon, LinkIcon, RecordIcon } from '../components/icons.tsx';
import { CameraPreview } from '../components/CameraPreview.tsx';
import { FloatingCamera } from '../components/FloatingCamera.tsx';
import { RecordingControls } from '../components/RecordingControls.tsx';
import { floatingControlsAvailable, openFloatingControls, type FloatingWindow } from '../lib/pip.ts';
import {
  discard as discardRecovery,
  findRecoverable,
  resume,
  type PendingRecovery,
} from '../lib/recovery.ts';

type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'finalizing' | 'done' | 'failed';

export function RecordPage() {
  const navigate = useNavigate();
  const capture = useRef<Capture | null>(null);
  const elapsed = useRef(0);
  const floating = useRef<FloatingWindow | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(systemAudioAvailable());
  const [camera, setCamera] = useState(cameraAvailable());
  const [showDevices, setShowDevices] = useState(false);
  const [devices, setDevices] = useState<{ cameras: CaptureDevice[]; microphones: CaptureDevice[] }>(
    { cameras: [], microphones: [] },
  );
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');

  const [bubble, setBubble] = useState<{ position: BubblePosition; size: BubbleSize }>({
    position: DEFAULT_POSITION,
    size: 'medium',
  });
  const [stageStream, setStageStream] = useState<MediaStream | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraMode, setCameraMode] = useState<'on-screen' | 'composited' | 'none'>('none');
  const [floatingContainer, setFloatingContainer] = useState<HTMLElement | null>(null);

  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [warnNoDurableStorage, setWarnNoDurableStorage] = useState(false);
  const [recoverable, setRecoverable] = useState<PendingRecovery[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [copied, setCopied] = useState(false);

  const supported = canRecord();
  const audioAvailable = systemAudioAvailable();

  useEffect(() => {
    findRecoverable()
      .then(setRecoverable)
      .catch(() => {
        // Nothing to recover, or storage is unavailable. Not worth interrupting
        // someone who came here to record something new.
      });
  }, []);

  // Device names are blank until permission has been granted once, so this is
  // only worth doing when somebody opens the picker.
  useEffect(() => {
    if (!showDevices || !cameraAvailable()) return;
    listDevices()
      .then(setDevices)
      .catch(() => {});
  }, [showDevices]);

  useEffect(() => {
    const busy = phase === 'recording' || phase === 'paused' || phase === 'finalizing';
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const base = elapsed.current;
    const from = Date.now();
    const timer = setInterval(() => {
      elapsed.current = base + (Date.now() - from);
      setElapsedMs(elapsed.current);
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const closeFloating = useCallback(() => {
    floating.current?.close();
    floating.current = null;
    setFloatingContainer(null);
  }, []);

  useEffect(() => closeFloating, [closeFloating]);

  async function copyLink(id: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/watch/${id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function clearRecordingState() {
    capture.current = null;
    setStageStream(null);
    setCameraStream(null);
    setCameraMode('none');
    closeFloating();
  }

  async function start() {
    setError(null);
    setPhase('starting');
    try {
      const started = await Capture.start(
        {
          microphone,
          systemAudio: systemAudio && audioAvailable,
          camera,
          cameraDeviceId: cameraId || undefined,
          microphoneDeviceId: micId || undefined,
          position: bubble.position,
          size: bubble.size,
          // Known before the screen is shared, and part of deciding whether the
          // camera can be a window on it.
          canFloat: floatingControlsAvailable(),
        },
        {
          onProgress: setProgress,
          // The browser's own "Stop sharing" ends capture without telling the page
          // anything else, so it is treated as pressing stop.
          onEndedByBrowser: () => void finish(),
        },
      );
      capture.current = started;
      setWarnNoDurableStorage(!started.durableStorage);
      setStageStream(started.composite?.stream ?? null);
      setCameraStream(started.cameraStream);
      setCameraMode(started.cameraMode);
      elapsed.current = 0;
      setElapsedMs(0);
      setPhase('recording');

      // Controls that float above everything else. While recording a whole screen
      // the page is behind whatever is being demonstrated, so controls on it
      // cannot be reached without switching away from the thing being recorded.
      if (floatingControlsAvailable()) {
        const onScreen = started.cameraMode === 'on-screen';
        const opened = await openFloatingControls({
          // The on-screen bubble is a window somebody looks at and drags, so it
          // gets room for a real circle; the other shapes are informational.
          width: onScreen ? 240 : 300,
          height: onScreen ? 330 : started.composite ? 420 : 180,
          onClose: () => setFloatingContainer(null),
        }).catch(() => null);
        if (opened) {
          floating.current = opened;
          setFloatingContainer(opened.container);
        }
      }
    } catch (caught) {
      // Refusing the screen-share prompt lands here, and is a decision rather
      // than a failure.
      const message = caught instanceof Error ? caught.message : 'Could not start recording.';
      setError(/denied|dismissed|not allowed/i.test(message) ? null : message);
      setPhase('idle');
    }
  }

  async function finish() {
    const active = capture.current;
    if (!active || phase === 'finalizing' || phase === 'done') return;

    setPhase('finalizing');
    try {
      const { recordingId: id } = await active.stop();
      clearRecordingState();
      setRecordingId(id);
      setPhase('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The upload did not finish.');
      clearRecordingState();
      setPhase('failed');
    }
  }

  function pauseRecording() {
    capture.current?.pause();
    setPhase('paused');
  }

  function resumeRecording() {
    capture.current?.resume();
    setPhase('recording');
  }

  function moveBubble(position: BubblePosition) {
    setBubble((current) => ({ ...current, position }));
    capture.current?.composite?.moveTo(position);
  }

  function resizeBubble(size: BubbleSize) {
    setBubble((current) => ({ ...current, size }));
    capture.current?.composite?.resize(size);
  }

  async function discard() {
    await capture.current?.cancel();
    clearRecordingState();
    setPhase('idle');
    setProgress(null);
    elapsed.current = 0;
    setElapsedMs(0);
  }

  if (!supported) {
    return (
      <main className="page">
        <h1>Record</h1>
        <p className="error">
          This browser cannot record video. Chrome, Edge, or a recent Firefox or Safari will work.
        </p>
      </main>
    );
  }

  const floatingContent =
    cameraMode === 'on-screen' ? (
      <FloatingCamera
        stream={cameraStream}
        elapsedMs={elapsedMs}
        paused={phase === 'paused'}
        onPause={pauseRecording}
        onResume={resumeRecording}
        onStop={() => void finish()}
        onDiscard={() => void discard()}
      />
    ) : null;

  const controls = (
    <RecordingControls
      elapsedMs={elapsedMs}
      recordedBytes={progress?.recordedBytes ?? 0}
      uploadedBytes={progress?.uploadedBytes ?? 0}
      paused={phase === 'paused'}
      stageStream={stageStream}
      bubble={stageStream ? bubble : null}
      onMoveBubble={moveBubble}
      onResizeBubble={resizeBubble}
      onPause={pauseRecording}
      onResume={resumeRecording}
      onStop={() => void finish()}
      onDiscard={() => void discard()}
    />
  );

  return (
    <main className="page narrow">
      {phase === 'idle' &&
        recoverable.map((pending) => (
          <div className="card notice" key={pending.manifest.recordingId}>
            <div>
              <p className="title">Unfinished recording</p>
              <p className="muted small">{pending.description}</p>
            </div>
            <div className="actions">
              <button
                disabled={recovering}
                onClick={() => {
                  setRecovering(true);
                  resume(pending)
                    .then(({ recordingId: id }) => navigate(`/watch/${id}`))
                    .catch((caught: unknown) =>
                      setError(caught instanceof Error ? caught.message : 'Could not finish it.'),
                    )
                    .finally(() => setRecovering(false));
                }}
              >
                {recovering ? 'Finishing…' : 'Finish it'}
              </button>
              <button
                className="quiet danger"
                disabled={recovering}
                onClick={() =>
                  void discardRecovery(pending.manifest).then(() =>
                    setRecoverable((current) =>
                      current.filter(
                        (item) => item.manifest.recordingId !== pending.manifest.recordingId,
                      ),
                    ),
                  )
                }
              >
                Discard
              </button>
            </div>
          </div>
        ))}

      {phase === 'idle' && (
        <div className="launcher">
          <div className="centre">
            <h1>Record your screen</h1>
            <p className="muted small" style={{ margin: '0.2rem 0 0' }}>
              You will be asked which screen or window to share.
            </p>
          </div>

          <CameraPreview enabled={camera} deviceId={cameraId || undefined} />

          <div className="toggles">
            <Toggle on={camera} disabled={!cameraAvailable()} onChange={setCamera} label="Camera" />
            <Toggle on={microphone} onChange={setMicrophone} label="Microphone" />
            <Toggle
              on={systemAudio && audioAvailable}
              disabled={!audioAvailable}
              onChange={setSystemAudio}
              label="Screen audio"
              note={audioAvailable ? undefined : 'Chrome and Edge only'}
            />
          </div>

          {error && <p className="banner bad">{error}</p>}

          <button className="record" onClick={() => void start()}>
            <RecordIcon size={18} />
            Choose a screen and start
          </button>

          <button className="link" onClick={() => setShowDevices((open) => !open)}>
            {showDevices ? 'Hide devices' : 'Choose devices'}
          </button>

          {showDevices && (
            <div className="devices">
              <label>
                Camera
                <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                  <option value="">Default</option>
                  {devices.cameras.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Microphone
                <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                  <option value="">Default</option>
                  {devices.microphones.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <p className="muted small centre">You can name it after recording.</p>
        </div>
      )}

      {(phase === 'recording' || phase === 'paused') && (
        <div className="card">
          {warnNoDurableStorage && (
            <p className="warn small">
              This browser cannot save parts to disk, so a crash would lose the recording.
            </p>
          )}
          {cameraMode === 'on-screen' && (
            <p className="muted small">
              Your camera is a floating window on your screen. Drag it wherever you want it —
              it is recorded where you put it.
            </p>
          )}
          {cameraMode === 'composited' && capture.current?.surface !== 'monitor' && stageStream && (
            <p className="muted small">
              You are sharing one window, which would not include a floating camera, so the
              camera is drawn into the recording. Drag it on the picture below.
            </p>
          )}

          {/* Kept here as well as in the floating window: closing that window must
              not leave a recording with no way to stop it. */}
          {controls}
          {floatingControlsAvailable() && !floatingContainer && (
            <p className="muted small centre">The floating controls were closed. These still work.</p>
          )}
        </div>
      )}

      {floatingContainer && createPortal(floatingContent ?? controls, floatingContainer)}

      {phase === 'starting' && (
        <div className="card centre waiting">
          <span className="spinner" />
          <p className="muted" style={{ margin: 0 }}>
            Waiting for you to pick a screen…
          </p>
        </div>
      )}

      {phase === 'finalizing' && (
        <div className="card centre waiting">
          <span className="spinner" />
          {/* Everything before the tail is already uploaded, so this is short and
              says what it is waiting for rather than sitting at 99%. */}
          <p style={{ margin: 0 }}>
            Finishing the last{' '}
            {formatBytes(
              Math.max(0, (progress?.recordedBytes ?? 0) - (progress?.uploadedBytes ?? 0)),
            )}
            …
          </p>
        </div>
      )}

      {phase === 'done' && recordingId && (
        <div className="card card-lg centre done">
          <span className="done-mark">
            <CheckIcon size={24} />
          </span>
          <p className="title" style={{ fontSize: '1.15rem' }}>
            Ready to share
          </p>
          {/* The link is the product. It goes on screen at full size, next to the
              one button that puts it on the clipboard. */}
          <p className="mono done-link">
            {window.location.origin}/watch/{recordingId}
          </p>
          <div className="actions centre">
            <button onClick={() => void copyLink(recordingId)}>
              {copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button className="quiet" onClick={() => navigate(`/watch/${recordingId}`)}>
              Watch it
            </button>
            <button
              className="ghost"
              onClick={() => {
                setPhase('idle');
                setRecordingId(null);
                setProgress(null);
                setCopied(false);
              }}
            >
              Record another
            </button>
          </div>
        </div>
      )}

      {phase === 'failed' && (
        <div className="card">
          <p className="banner bad">{error}</p>
          <p className="muted small">
            The parts that did upload are still on the server, so the recording may be recoverable.
          </p>
          <Link to="/">Back to recordings</Link>
        </div>
      )}
    </main>
  );
}

function Toggle({
  on,
  onChange,
  label,
  note,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={on ? 'toggle on' : 'toggle'}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={note}
    >
      <span className="toggle-dot" aria-hidden="true" />
      {label}
    </button>
  );
}
