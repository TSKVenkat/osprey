/**
 * Where the camera bubble sits, and how big it is.
 *
 * The position is a fraction of the frame rather than a corner, because a corner
 * is a setting somebody has to decide before they start and a fraction is
 * something they can drag while recording. Kept apart from the drawing so it can
 * be reasoned about and tested: getting the crop wrong is what makes a face look
 * stretched, and that is not something a screenshot review reliably catches.
 */

/** Centre of the bubble, as a fraction of the frame. `{x: 0, y: 0}` is top left. */
export interface BubblePosition {
  x: number;
  y: number;
}

export type BubbleSize = 'small' | 'medium' | 'large';

/** As a fraction of the shorter side of the recording, so it scales with it. */
const SIZE_FRACTION: Record<BubbleSize, number> = {
  small: 0.13,
  medium: 0.19,
  large: 0.27,
};

/** Out of the way of most content, and where a presenter is usually expected. */
export const DEFAULT_POSITION: BubblePosition = { x: 0.12, y: 0.82 };

export interface BubblePlacement {
  centreX: number;
  centreY: number;
  radius: number;
}

export function radiusFor(canvas: { width: number; height: number }, size: BubbleSize): number {
  return (Math.min(canvas.width, canvas.height) * SIZE_FRACTION[size]) / 2;
}

/**
 * Turns a fractional position into pixels, keeping the whole circle in frame.
 *
 * Clamping here rather than while dragging means a bubble dragged to the edge at
 * one size does not end up half outside when it is made larger.
 */
export function placeBubble(
  canvas: { width: number; height: number },
  position: BubblePosition,
  size: BubbleSize,
): BubblePlacement {
  const radius = radiusFor(canvas, size);
  const margin = radius * 0.15;

  return {
    centreX: clamp(position.x * canvas.width, radius + margin, canvas.width - radius - margin),
    centreY: clamp(position.y * canvas.height, radius + margin, canvas.height - radius - margin),
    radius,
  };
}

/** Keeps a dragged position inside the frame, in fractional terms. */
export function clampPosition(position: BubblePosition): BubblePosition {
  return { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) };
}

/** Where a pointer landed, as a fraction of the surface it landed on. */
export function positionFromPointer(
  pointer: { clientX: number; clientY: number },
  surface: { left: number; top: number; width: number; height: number },
): BubblePosition {
  if (surface.width <= 0 || surface.height <= 0) return { x: 0.5, y: 0.5 };
  return clampPosition({
    x: (pointer.clientX - surface.left) / surface.width,
    y: (pointer.clientY - surface.top) / surface.height,
  });
}

/** Whether a pointer is on the bubble, so a drag can start from it. */
export function isOnBubble(
  pointer: BubblePosition,
  bubble: BubblePosition,
  surface: { width: number; height: number },
  size: BubbleSize,
): boolean {
  const radius = radiusFor(surface, size);
  const dx = (pointer.x - bubble.x) * surface.width;
  const dy = (pointer.y - bubble.y) * surface.height;
  return Math.hypot(dx, dy) <= radius;
}

export interface SourceCrop {
  sx: number;
  sy: number;
  sWidth: number;
  sHeight: number;
}

/**
 * The largest centred square of the camera frame.
 *
 * A webcam is 16:9 and the bubble is round. Drawing the whole frame into a circle
 * squashes the picture horizontally; taking a square from the middle first is what
 * keeps a face the right shape.
 */
export function squareCrop(source: { width: number; height: number }): SourceCrop {
  const side = Math.min(source.width, source.height);
  return {
    sx: (source.width - side) / 2,
    sy: (source.height - side) / 2,
    sWidth: side,
    sHeight: side,
  };
}

/** Recording dimensions, rounded to even numbers because H.264 requires it. */
export function evenDimensions(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.floor(width / 2) * 2),
    height: Math.max(2, Math.floor(height / 2) * 2),
  };
}

function clamp(value: number, low: number, high: number): number {
  // A bubble larger than the frame would give an inverted range; centring it is
  // the only sensible answer.
  if (low > high) return (low + high) / 2;
  return Math.min(Math.max(value, low), high);
}
