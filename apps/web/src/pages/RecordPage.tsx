import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import type { BubbleCorner, BubbleSize } from '@openloom/recorder';

import {
  Capture,
  type CaptureDevice,
  type CaptureProgress,
  cameraAvailable,
  canRecord,
  listDevices,
  systemAudioAvailable,
} from '../lib/capture.ts';
import { formatBytes, formatDuration } from '../lib/format.ts';
import {
  discard as discardRecovery,
  findRecoverable,
  resume,
  type PendingRecovery,
} from '../lib/recovery.ts';

type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'finalizing' | 'done' | 'failed';

export function RecordPage() {
  const navigate = useNavigate();
  const preview = useRef<HTMLVideoElement>(null);
  const capture = useRef<Capture | null>(null);
  const elapsed = useRef(0);

  const [phase, setPhase] = useState<Phase>('idle');
  const [title, setTitle] = useState('Untitled recording');
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(systemAudioAvailable());
  const [camera, setCamera] = useState(cameraAvailable());
  const [devices, setDevices] = useState<{ cameras: CaptureDevice[]; microphones: CaptureDevice[] }>(
    { cameras: [], microphones: [] },
  );
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [corner, setCorner] = useState<BubbleCorner>('bottom-left');
  const [bubbleSize, setBubbleSize] = useState<BubbleSize>('medium');
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [warnNoDurableStorage, setWarnNoDurableStorage] = useState(false);
  const [recoverable, setRecoverable] = useState<PendingRecovery[]>([]);
  const [recovering, setRecovering] = useState(false);

  const supported = canRecord();
  const audioAvailable = systemAudioAvailable();

  // Device names are blank until permission has been granted once, so this asks
  // for it briefly and releases it again. Without that the picker can only offer
  // "Camera 1", which is no help when there are three.
  useEffect(() => {
    if (!cameraAvailable()) return;
    listDevices()
      .then(setDevices)
      .catch(() => {
        // Refused, or nothing attached. Recording the screen still works.
      });
  }, []);

  // Anything a previous tab left behind. Parts are written to disk before they are
  // sent, so a crash mid-recording is recoverable rather than lost.
  useEffect(() => {
    findRecoverable()
      .then(setRecoverable)
      .catch(() => {
        // Nothing to recover, or storage is unavailable. Not worth interrupting
        // someone who came here to record something new.
      });
  }, []);

  // Closing the tab mid-recording loses whatever has not been uploaded, so the
  // browser is asked to confirm first.
  useEffect(() => {
    const busy = phase === 'recording' || phase === 'paused' || phase === 'finalizing';
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  // The elapsed time is kept in a ref as well as state, so pausing and resuming
  // continues the count instead of restarting it, without the effect needing to
  // depend on the value it is updating.
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

  async function start() {
    setError(null);
    setPhase('starting');
    try {
      const started = await Capture.start(
        {
          title,
          microphone,
          systemAudio: systemAudio && audioAvailable,
          camera,
          cameraDeviceId: cameraId || undefined,
          microphoneDeviceId: micId || undefined,
          bubbleCorner: corner,
          bubbleSize,
        },
        {
          onProgress: setProgress,
          // The browser's own "Stop sharing" button ends the capture without
          // telling the page anything else, so it is treated as pressing stop.
          onEndedByBrowser: () => void finish(),
        },
      );
      capture.current = started;
      setWarnNoDurableStorage(!started.durableStorage);
      if (preview.current) {
        preview.current.srcObject = started.stream;
        void preview.current.play();
      }
      elapsed.current = 0;
      setElapsedMs(0);
      setPhase('recording');
    } catch (caught) {
      // Refusing the screen-share prompt lands here, and is not an error worth
      // shouting about.
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
      capture.current = null;
      setRecordingId(id);
      setPhase('done');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The upload did not finish.');
      setPhase('failed');
    }
  }

  async function discard() {
    await capture.current?.cancel();
    capture.current = null;
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

  return (
    <main className="page">
      <h1>Record</h1>

      {phase === 'idle' &&
        recoverable.map((pending) => (
          <div className="card" key={pending.manifest.recordingId}>
            <p className="title">Unfinished recording</p>
            <p className="muted small">{pending.description}</p>
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
                onClick={() => {
                  void discardRecovery(pending.manifest).then(() =>
                    setRecoverable((current) =>
                      current.filter((c) => c.manifest.recordingId !== pending.manifest.recordingId),
                    ),
                  );
                }}
              >
                Discard
              </button>
            </div>
          </div>
        ))}

      {phase === 'idle' && (
        <div className="card form">
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label className="inline">
            <input
              type="checkbox"
              checked={microphone}
              onChange={(e) => setMicrophone(e.target.checked)}
            />
            Microphone
          </label>
          {microphone && devices.microphones.length > 1 && (
            <label>
              Which microphone
              <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                <option value="">Default</option>
                {devices.microphones.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="inline">
            <input
              type="checkbox"
              checked={camera}
              disabled={!cameraAvailable()}
              onChange={(e) => setCamera(e.target.checked)}
            />
            Camera bubble
          </label>
          {camera && (
            <>
              {devices.cameras.length > 1 && (
                <label>
                  Which camera
                  <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                    <option value="">Default</option>
                    {devices.cameras.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Where it sits
                <select
                  value={corner}
                  onChange={(e) => setCorner(e.target.value as BubbleCorner)}
                >
                  <option value="bottom-left">Bottom left</option>
                  <option value="bottom-right">Bottom right</option>
                  <option value="top-left">Top left</option>
                  <option value="top-right">Top right</option>
                </select>
              </label>
              <label>
                How big
                <select
                  value={bubbleSize}
                  onChange={(e) => setBubbleSize(e.target.value as BubbleSize)}
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </label>
              {/* The bubble is drawn into the video, not laid over the page, so
                  what is recorded is what gets shared. */}
              <p className="muted small">
                The camera is recorded into the video as a circle in that corner.
              </p>
            </>
          )}

          <label className="inline">
            <input
              type="checkbox"
              checked={systemAudio && audioAvailable}
              disabled={!audioAvailable}
              onChange={(e) => setSystemAudio(e.target.checked)}
            />
            System audio
          </label>
          {!audioAvailable && (
            <p className="muted small">
              This browser cannot capture system audio. Chrome and Edge can.
            </p>
          )}

          {error && <p className="error">{error}</p>}
          <button onClick={() => void start()}>Choose a screen and start</button>
        </div>
      )}

      {(phase === 'recording' || phase === 'paused') && (
        <div className="card">
          <video ref={preview} className="preview" muted playsInline />

          <div className="row">
            <span className="timer">{formatDuration(elapsedMs)}</span>
            <span className="muted small">
              {formatBytes(progress?.uploadedBytes ?? 0)} of{' '}
              {formatBytes(progress?.recordedBytes ?? 0)} uploaded
            </span>
          </div>

          {warnNoDurableStorage && (
            <p className="warn small">
              This browser cannot save parts to disk, so a crash would lose the recording.
            </p>
          )}

          {capture.current?.composite && (
            <div className="inline" style={{ marginTop: '0.6rem' }}>
              <span className="muted small">Bubble</span>
              <select
                value={corner}
                onChange={(e) => {
                  const next = e.target.value as BubbleCorner;
                  setCorner(next);
                  // Free to change mid-recording: the next frame is simply drawn
                  // somewhere else.
                  capture.current?.composite?.moveTo(next, bubbleSize);
                }}
              >
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
              </select>
              <select
                value={bubbleSize}
                onChange={(e) => {
                  const next = e.target.value as BubbleSize;
                  setBubbleSize(next);
                  capture.current?.composite?.moveTo(corner, next);
                }}
              >
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
              </select>
            </div>
          )}

          <div className="actions">
            {phase === 'recording' ? (
              <button
                className="quiet"
                onClick={() => {
                  capture.current?.pause();
                  setPhase('paused');
                }}
              >
                Pause
              </button>
            ) : (
              <button
                className="quiet"
                onClick={() => {
                  capture.current?.resume();
                  setPhase('recording');
                }}
              >
                Resume
              </button>
            )}
            <button onClick={() => void finish()}>Stop</button>
            <button className="quiet danger" onClick={() => void discard()}>
              Discard
            </button>
          </div>
        </div>
      )}

      {phase === 'finalizing' && (
        <div className="card">
          {/* Everything before the tail is already uploaded, so this is short and
              should say what it is actually waiting for rather than sit at 99%. */}
          <p>Finishing the last {formatBytes(
            Math.max(0, (progress?.recordedBytes ?? 0) - (progress?.uploadedBytes ?? 0)),
          )}…</p>
        </div>
      )}

      {phase === 'done' && recordingId && (
        <div className="card">
          <p className="title">Ready to share</p>
          <p className="muted small">{window.location.origin}/watch/{recordingId}</p>
          <div className="actions">
            <button onClick={() => navigate(`/watch/${recordingId}`)}>Watch it</button>
            <button
              className="quiet"
              onClick={() => {
                setPhase('idle');
                setRecordingId(null);
                setProgress(null);
              }}
            >
              Record another
            </button>
          </div>
        </div>
      )}

      {phase === 'failed' && (
        <div className="card">
          <p className="error">{error}</p>
          <p className="muted small">
            The parts that did upload are still on the server, so the recording may be
            recoverable.
          </p>
          <Link to="/">Back to recordings</Link>
        </div>
      )}
    </main>
  );
}
