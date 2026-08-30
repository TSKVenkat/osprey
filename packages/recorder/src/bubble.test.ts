import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POSITION,
  clampPosition,
  evenDimensions,
  isOnBubble,
  placeBubble,
  positionFromPointer,
  radiusFor,
  squareCrop,
} from './bubble.ts';

const canvas = { width: 1920, height: 1080 };

describe('placeBubble', () => {
  it('puts the bubble where the fraction says', () => {
    const { centreX, centreY } = placeBubble(canvas, { x: 0.5, y: 0.5 }, 'medium');
    expect(centreX).toBeCloseTo(960, 0);
    expect(centreY).toBeCloseTo(540, 0);
  });

  it('scales with the shorter side, so it looks the same at any resolution', () => {
    const big = placeBubble({ width: 1920, height: 1080 }, DEFAULT_POSITION, 'medium');
    const small = placeBubble({ width: 960, height: 540 }, DEFAULT_POSITION, 'medium');
    expect(big.radius / small.radius).toBeCloseTo(2, 5);
  });

  it('keeps the whole circle in frame however far it is dragged', () => {
    // Dragging to the very corner must not leave half the face outside.
    for (const position of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: -5, y: 12 },
    ]) {
      for (const size of ['small', 'medium', 'large'] as const) {
        const { centreX, centreY, radius } = placeBubble(canvas, position, size);
        expect(centreX - radius).toBeGreaterThanOrEqual(0);
        expect(centreY - radius).toBeGreaterThanOrEqual(0);
        expect(centreX + radius).toBeLessThanOrEqual(canvas.width);
        expect(centreY + radius).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  it('keeps a bubble in frame when it is made larger at the edge', () => {
    // Clamping at draw time rather than at drag time is what makes this hold.
    const atEdge = { x: 0.99, y: 0.99 };
    const large = placeBubble(canvas, atEdge, 'large');
    expect(large.centreX + large.radius).toBeLessThanOrEqual(canvas.width);
    expect(large.centreY + large.radius).toBeLessThanOrEqual(canvas.height);
  });

  it('grows from small to large', () => {
    const sizes = (['small', 'medium', 'large'] as const).map((size) => radiusFor(canvas, size));
    expect(sizes[0]!).toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[2]!);
  });

  it('keeps the bubble in frame even on a very small one', () => {
    // The radius is a fraction of the shorter side, so it can never actually
    // exceed the frame; the guard against an inverted range is defensive only.
    const tiny = { width: 40, height: 40 };
    const { centreX, centreY, radius } = placeBubble(tiny, { x: 0, y: 0 }, 'large');
    expect(centreX - radius).toBeGreaterThanOrEqual(0);
    expect(centreY - radius).toBeGreaterThanOrEqual(0);
  });
});

describe('dragging', () => {
  const surface = { left: 100, top: 50, width: 400, height: 225 };

  it('turns a pointer into a fraction of the surface', () => {
    expect(positionFromPointer({ clientX: 300, clientY: 162.5 }, surface)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('clamps a pointer dragged off the edge', () => {
    expect(positionFromPointer({ clientX: -50, clientY: 999 }, surface)).toEqual({ x: 0, y: 1 });
  });

  it('survives a surface with no size', () => {
    expect(positionFromPointer({ clientX: 10, clientY: 10 }, { ...surface, width: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('clamps a position to the frame', () => {
    expect(clampPosition({ x: -1, y: 3 })).toEqual({ x: 0, y: 1 });
  });

  it('knows when a pointer is on the bubble', () => {
    const bubble = { x: 0.5, y: 0.5 };
    const size = { width: 400, height: 400 };
    // Dead centre is on it; the far corner is not.
    expect(isOnBubble({ x: 0.5, y: 0.5 }, bubble, size, 'medium')).toBe(true);
    expect(isOnBubble({ x: 0.05, y: 0.05 }, bubble, size, 'medium')).toBe(false);
  });
});

describe('squareCrop', () => {
  it('takes a centred square from a widescreen camera', () => {
    // Without this the face is squashed horizontally inside the circle.
    expect(squareCrop({ width: 1280, height: 720 })).toEqual({
      sx: 280,
      sy: 0,
      sWidth: 720,
      sHeight: 720,
    });
  });

  it('takes a centred square from a tall frame too', () => {
    expect(squareCrop({ width: 480, height: 640 })).toEqual({
      sx: 0,
      sy: 80,
      sWidth: 480,
      sHeight: 480,
    });
  });
});

describe('evenDimensions', () => {
  it('rounds down to even numbers, which H.264 requires', () => {
    expect(evenDimensions(1921, 1081)).toEqual({ width: 1920, height: 1080 });
  });

  it('never returns zero', () => {
    expect(evenDimensions(1, 1)).toEqual({ width: 2, height: 2 });
  });
});
