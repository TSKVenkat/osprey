import { useEffect, useRef } from 'react';

import { formatDuration } from '../lib/format.ts';

export interface FloatingCameraProps {
  stream: MediaStream | null;
  elapsedMs: number;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
}

/**
 * The camera bubble as a real window on the screen.
 *
 * When the whole screen is being shared, this window is *in* the recording
 * because it is genuinely on the screen — so dragging it with the window manager
 * moves the presenter in the video, and the thing being dragged is the bubble
 * itself rather than a proxy for it. That is the difference between this and
 * painting the camera into the picture at a position chosen elsewhere.
 *
 * The controls sit under the circle so that stopping never means going and
 * finding the tab, which would be recorded.
 */
export function FloatingCamera({
  stream,
  elapsedMs,
  paused,
  onPause,
  onResume,
  onStop,
  onDiscard,
}: FloatingCameraProps) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    void element.play().catch(() => {
      // Autoplay refused. The controls still work; only the self-view is missing.
    });
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="bubble-window" data-recording data-camera-mode="on-screen">
      <div className="bubble-circle">
        {stream ? (
          <video ref={video} muted playsInline />
        ) : (
          <span className="muted small">No camera</span>
        )}
        <span className={paused ? 'bubble-badge paused' : 'bubble-badge'}>
          <span className={paused ? 'dot paused' : 'dot recording'} aria-hidden="true" />
          {formatDuration(elapsedMs)}
        </span>
      </div>

      <div className="bubble-actions">
        <button
          type="button"
          className="quiet"
          onClick={paused ? onResume : onPause}
          title={paused ? 'Resume' : 'Pause'}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="stop" onClick={onStop}>
          Stop
        </button>
        <button type="button" className="quiet danger" onClick={onDiscard} title="Discard">
          Discard
        </button>
      </div>

      {/* Said once, in the place where it is useful: this window is part of the
          picture, so where it is put is where the presenter appears. */}
      <p className="bubble-hint muted small">Drag this window anywhere on your screen.</p>
    </div>
  );
}
