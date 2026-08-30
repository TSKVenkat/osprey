import { useEffect, useRef } from 'react';

import { formatBytes, formatDuration } from '../lib/format.ts';

export interface RecordingControlsProps {
  elapsedMs: number;
  recordedBytes: number;
  uploadedBytes: number;
  paused: boolean;
  /** Shown as a live self-view, so the presenter can see what is being recorded. */
  cameraStream: MediaStream | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
}

/**
 * The controls shown while recording.
 *
 * The same component is rendered on the page and, where the browser allows it,
 * inside a small always-on-top window — so there is one set of behaviour to reason
 * about rather than two that drift.
 */
export function RecordingControls({
  elapsedMs,
  recordedBytes,
  uploadedBytes,
  paused,
  cameraStream,
  onPause,
  onResume,
  onStop,
  onDiscard,
}: RecordingControlsProps) {
  const preview = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = preview.current;
    if (!element || !cameraStream) return;
    element.srcObject = cameraStream;
    void element.play().catch(() => {
      // Autoplay refused. The controls still work; only the self-view is missing.
    });
    return () => {
      element.srcObject = null;
    };
  }, [cameraStream]);

  const remaining = Math.max(0, recordedBytes - uploadedBytes);

  return (
    <div className="controls">
      {cameraStream && (
        // Mirrored, to match the bubble in the recording and because a self-view
        // that moves the wrong way is disconcerting.
        <video ref={preview} className="controls-camera" muted playsInline />
      )}

      <div className="controls-timer">
        <span className={paused ? 'dot paused' : 'dot recording'} aria-hidden="true" />
        <span className="timer">{formatDuration(elapsedMs)}</span>
      </div>

      <p className="muted small controls-progress">
        {remaining > 0 ? `${formatBytes(remaining)} left to send` : 'Everything sent so far'}
      </p>

      <div className="controls-buttons">
        <button type="button" onClick={paused ? onResume : onPause} className="quiet">
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={onStop}>
          Stop
        </button>
      </div>

      <button type="button" className="quiet danger controls-discard" onClick={onDiscard}>
        Discard
      </button>
    </div>
  );
}
