import { expect, test } from '@playwright/test';

import { requireDevServer, signIn } from './helpers.ts';

/**
 * The compositor, driven directly with synthetic video.
 *
 * This is the path taken whenever a floating camera window would not be in the
 * recording — sharing one window or one tab, or a browser without
 * picture-in-picture. Chrome cannot be pushed into those capture modes without a
 * real picker, so the compositor is exercised on its own with a known screen and
 * a known camera, which also makes the assertions exact rather than statistical.
 */

/** A stream of one flat colour, standing in for a screen or a camera. */
const SOURCE = `(colour, width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const paint = () => {
    context.fillStyle = colour;
    context.fillRect(0, 0, width, height);
  };
  paint();
  setInterval(paint, 100);
  return canvas.captureStream(30);
}`;

test('draws the camera into the picture where it is told to', async ({ page }) => {
  await signIn(page);
  await requireDevServer(page);

  const result = await page.evaluate(async (sourceFactory) => {
    const { Composite } = await import('/src/lib/composite.ts');
    const makeSource = eval(sourceFactory) as (c: string, w: number, h: number) => MediaStream;

    const screen = makeSource('#101010', 640, 360);
    const camera = makeSource('#ff0000', 320, 240);

    const composite = await Composite.start({
      screen,
      camera,
      position: { x: 0.25, y: 0.75 },
      size: 'medium',
    });

    /** Reads one frame of the composed picture. */
    const sample = async () => {
      const video = document.createElement('video');
      video.srcObject = composite.stream;
      video.muted = true;
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(video, 0, 0);

      const at = (x: number, y: number) => {
        const [r, g, b] = context.getImageData(
          Math.round(x * canvas.width),
          Math.round(y * canvas.height),
          1,
          1,
        ).data;
        return { r: r!, g: g!, b: b! };
      };
      video.remove();
      return { at, width: canvas.width, height: canvas.height };
    };

    const first = await sample();
    const onBubble = first.at(0.25, 0.75);
    const away = first.at(0.8, 0.2);

    // Drag it across the picture and look again.
    composite.moveTo({ x: 0.75, y: 0.25 });
    const second = await sample();
    const oldSpot = second.at(0.25, 0.75);
    const newSpot = second.at(0.75, 0.25);

    composite.stop();
    return {
      size: { width: first.width, height: first.height },
      onBubble,
      away,
      oldSpot,
      newSpot,
    };
  }, SOURCE);

  // The recording keeps the screen's own dimensions.
  expect(result.size).toEqual({ width: 640, height: 360 });

  // Red where the camera was placed, dark screen everywhere else.
  expect(result.onBubble.r).toBeGreaterThan(150);
  expect(result.away.r).toBeLessThan(60);

  // After moving it, the camera is in the new place and gone from the old one.
  expect(result.newSpot.r).toBeGreaterThan(150);
  expect(result.oldSpot.r).toBeLessThan(60);
});

test('draws nothing extra when there is no camera', async ({ page }) => {
  await signIn(page);
  await requireDevServer(page);

  const corners = await page.evaluate(async (sourceFactory) => {
    const { Composite } = await import('/src/lib/composite.ts');
    const makeSource = eval(sourceFactory) as (c: string, w: number, h: number) => MediaStream;

    const composite = await Composite.start({
      screen: makeSource('#101010', 640, 360),
      camera: null,
    });

    const video = document.createElement('video');
    video.srcObject = composite.stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    const [r] = context.getImageData(Math.round(canvas.width * 0.12), Math.round(canvas.height * 0.82), 1, 1).data;

    composite.stop();
    video.remove();
    return { red: r! };
  }, SOURCE);

  // Where the bubble would have gone is plain screen.
  expect(corners.red).toBeLessThan(60);
});
