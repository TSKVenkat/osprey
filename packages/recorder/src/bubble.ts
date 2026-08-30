/**
 * Geometry for the camera bubble.
 *
 * Kept apart from the drawing so it can be reasoned about and tested: where the
 * circle sits, how big it is, and which part of the camera feed to take. Getting
 * the crop wrong is what makes a face look stretched, and that is not something a
 * screenshot review reliably catches.
 */

export type BubbleCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export type BubbleSize = 'small' | 'medium' | 'large';

/** As a fraction of the shorter side of the recording, so it scales with it. */
const SIZE_FRACTION: Record<BubbleSize, number> = {
  small: 0.14,
  medium: 0.2,
  large: 0.28,
};

export interface BubblePlacement {
  /** Centre of the circle, in recording pixels. */
  centreX: number;
  centreY: number;
  radius: number;
}

export function placeBubble(
  canvas: { width: number; height: number },
  corner: BubbleCorner,
  size: BubbleSize,
): BubblePlacement {
  const radius = (Math.min(canvas.width, canvas.height) * SIZE_FRACTION[size]) / 2;
  // A margin proportional to the bubble keeps it clear of the edge at any size.
  const margin = radius * 0.35;

  const left = radius + margin;
  const right = canvas.width - radius - margin;
  const top = radius + margin;
  const bottom = canvas.height - radius - margin;

  switch (corner) {
    case 'bottom-left':
      return { centreX: left, centreY: bottom, radius };
    case 'bottom-right':
      return { centreX: right, centreY: bottom, radius };
    case 'top-left':
      return { centreX: left, centreY: top, radius };
    case 'top-right':
      return { centreX: right, centreY: top, radius };
  }
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
