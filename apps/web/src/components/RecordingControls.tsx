import type { BubblePosition, BubbleSize } from '@osprey/recorder';

import { formatBytes, formatDuration } from '../lib/format.ts';
import { BubbleStage } from './BubbleStage.tsx';

export interface RecordingControlsProps {
  elapsedMs: number;
  recordedBytes: number;
  uploadedBytes: number;
  paused: boolean;
  /** The composed picture, when a camera is being recorded. */
  stageStream: MediaStream | null;
  bubble: { position: BubblePosition; size: BubbleSize } | null;
  onMoveBubble: (position: BubblePosition) => void;
  onResizeBubble: (size: BubbleSize) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
}

const SIZES: BubbleSize[] = ['small', 'medium', 'large'];

/**
 * Everything needed while recording, in one component.
 *
 * The same one renders on the page and inside the small always-on-top window, so
 * there is one set of behaviour rather than two that drift apart.
 */
export function RecordingControls({
  elapsedMs,
  recordedBytes,
  uploadedBytes,
  paused,
  stageStream,
  bubble,
  onMoveBubble,
  onResizeBubble,
  onPause,
  onResume,
  onStop,
  onDiscard,
}: RecordingControlsProps) {
  const remaining = Math.max(0, recordedBytes - uploadedBytes);

  return (
    // The byte count is exposed deliberately. Tests used to wait on the wording of
    // the progress line, which broke every time the wording improved; this is a
    // small, stable seam that says the same thing.
    <div className="controls" data-recording data-recorded-bytes={recordedBytes}>
      <div className="controls-head">
        <span className={paused ? 'dot paused' : 'dot recording'} aria-hidden="true" />
        <span className="timer">{formatDuration(elapsedMs)}</span>
        <span className="muted small controls-progress">
          {remaining > 0 ? `${formatBytes(remaining)} to send` : 'Up to date'}
        </span>
      </div>

      {stageStream && bubble && (
        <>
          <BubbleStage
            stream={stageStream}
            position={bubble.position}
            size={bubble.size}
            onMove={onMoveBubble}
          />
          <div className="sizes" role="group" aria-label="Camera size">
            {SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className={size === bubble.size ? 'chip on' : 'chip'}
                aria-pressed={size === bubble.size}
                onClick={() => onResizeBubble(size)}
              >
                {size[0]!.toUpperCase() + size.slice(1)}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="controls-buttons">
        <button type="button" onClick={paused ? onResume : onPause} className="quiet">
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="stop" onClick={onStop}>
          Stop
        </button>
        <button type="button" className="quiet danger" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
