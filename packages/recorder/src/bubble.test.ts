import { describe, expect, it } from 'vitest';
import { evenDimensions, placeBubble, squareCrop } from './bubble.ts';

const canvas = { width: 1920, height: 1080 };

describe('placeBubble', () => {
  it('scales with the shorter side, so it looks the same at any resolution', () => {
    const big = placeBubble({ width: 1920, height: 1080 }, 'bottom-left', 'medium');
    const small = placeBubble({ width: 960, height: 540 }, 'bottom-left', 'medium');
    expect(big.radius / small.radius).toBeCloseTo(2, 5);
  });

  it('puts each corner where its name says', () => {
    const bl = placeBubble(canvas, 'bottom-left', 'medium');
    const tr = placeBubble(canvas, 'top-right', 'medium');
    expect(bl.centreX).toBeLessThan(canvas.width / 2);
    expect(bl.centreY).toBeGreaterThan(canvas.height / 2);
    expect(tr.centreX).toBeGreaterThan(canvas.width / 2);
    expect(tr.centreY).toBeLessThan(canvas.height / 2);
  });

  it('keeps the whole circle inside the frame at every size and corner', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const corner of ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const) {
        const { centreX, centreY, radius } = placeBubble(canvas, corner, size);
        expect(centreX - radius).toBeGreaterThanOrEqual(0);
        expect(centreY - radius).toBeGreaterThanOrEqual(0);
        expect(centreX + radius).toBeLessThanOrEqual(canvas.width);
        expect(centreY + radius).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  it('grows from small to large', () => {
    const sizes = (['small', 'medium', 'large'] as const).map(
      (size) => placeBubble(canvas, 'bottom-left', size).radius,
    );
    expect(sizes[0]!).toBeLessThan(sizes[1]!);
    expect(sizes[1]!).toBeLessThan(sizes[2]!);
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

  it('leaves a square frame alone', () => {
    expect(squareCrop({ width: 500, height: 500 })).toEqual({
      sx: 0,
      sy: 0,
      sWidth: 500,
      sHeight: 500,
    });
  });
});

describe('evenDimensions', () => {
  it('rounds down to even numbers, which H.264 requires', () => {
    expect(evenDimensions(1921, 1081)).toEqual({ width: 1920, height: 1080 });
  });

  it('leaves even dimensions alone', () => {
    expect(evenDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('never returns zero', () => {
    expect(evenDimensions(1, 1)).toEqual({ width: 2, height: 2 });
  });
});
