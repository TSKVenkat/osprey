import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isOnBubble,
  positionFromPointer,
  radiusFor,
  type BubblePosition,
  type BubbleSize,
} from '@osprey/recorder';

export interface BubbleStageProps {
  /** The composed picture, exactly as it is being recorded. */
  stream: MediaStream;
  position: BubblePosition;
  size: BubbleSize;
  onMove: (position: BubblePosition) => void;
}

/**
 * The recording, shown live, with the camera bubble draggable on top of it.
 *
 * Dragging happens here rather than through a set of choices made beforehand,
 * because where the bubble should sit depends on what is on screen at the time —
 * and that changes while recording. Since this shows the composed picture, what
 * you drag is literally what is being stored.
 */
export function BubbleStage({ stream, position, size, onMove }: BubbleStageProps) {
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Measured into state rather than read during render: a ref does not re-render
  // when it changes, so the handle would sit at whatever size it was first drawn.
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play().catch(() => {
      // Autoplay refused. Dragging still works against a still frame.
    });
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  const positionOf = useCallback((event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return null;
    return positionFromPointer(event, box);
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    const pointer = positionOf(event);
    const box = surface.current?.getBoundingClientRect();
    if (!pointer || !box) return;

    // Picking it up anywhere but on the bubble would make an accidental click
    // teleport the presenter across the screen.
    if (!isOnBubble(pointer, position, box, size)) return;

    dragging.current = true;
    // Captured so the drag survives the pointer leaving this small surface, which
    // it will, because the surface is small.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragging.current) return;
    const next = positionOf(event);
    if (next) onMove(next);
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const radius = radiusFor(box, size);

  return (
    <div
      ref={surface}
      className="stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <video ref={video} muted playsInline />

      {/* A ring over the bubble's real position, so there is something obvious to
          take hold of. The bubble itself is already painted into the video. */}
      <span
        className="stage-handle"
        style={{
          left: `${position.x * 100}%`,
          top: `${position.y * 100}%`,
          width: radius * 2,
          height: radius * 2,
        }}
        aria-hidden="true"
      />
      <span className="stage-hint muted small">Drag the circle</span>
    </div>
  );
}
