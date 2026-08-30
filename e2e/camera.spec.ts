import { expect, test } from '@playwright/test';

import { ensureStorage, signIn, waitUntilRecording } from './helpers.ts';

/**
 * The camera bubble, checked where it matters: in the file.
 *
 * An overlay drawn on the page would look right while recording and be missing
 * from what gets shared. The only way to tell the difference is to record with the
 * camera on and look at the pixels that were actually stored.
 */
test('records the camera into the video, not just onto the page', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByLabel('Title').fill(`Camera ${Date.now()}`);
  await expect(page.getByLabel('Camera bubble')).toBeChecked();

  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Watch it' }).click();
  const video = page.locator('video.player');
  await expect(video).toBeVisible();

  // Read a frame out of the stored recording and look at the corner the bubble
  // was told to occupy. Chrome's fake screen is a flat test pattern, so a circle
  // of camera on top of it is a measurable difference.
  const corners = await video.evaluate(async (onPage: HTMLVideoElement) => {
    // Read through a second element that asks for the file cross-origin. The
    // recording may be served from object storage on another origin, and drawing
    // that into a canvas without permission taints it — which says nothing about
    // the recording, only about where it is stored.
    const element = document.createElement('video');
    element.crossOrigin = 'anonymous';
    element.muted = true;
    element.src = onPage.currentSrc;
    await new Promise<void>((resolve, reject) => {
      element.addEventListener('loadeddata', () => resolve(), { once: true });
      element.addEventListener('error', () => reject(new Error('could not load the recording')), {
        once: true,
      });
      setTimeout(resolve, 20_000);
    });

    element.currentTime = Math.min(2, element.duration / 2 || 1);
    await new Promise<void>((resolve) => {
      element.addEventListener('seeked', () => resolve(), { once: true });
      setTimeout(resolve, 8000);
    });

    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);

    /** Rough measure of how much is going on in a patch of the frame. */
    const variance = (x: number, y: number, size: number) => {
      const { data } = context.getImageData(x, y, size, size);
      let sum = 0;
      let sumSquares = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        sum += luma;
        sumSquares += luma * luma;
        count++;
      }
      const mean = sum / count;
      return sumSquares / count - mean * mean;
    };

    const patch = Math.floor(Math.min(canvas.width, canvas.height) * 0.12);
    return {
      width: canvas.width,
      height: canvas.height,
      // Where the bubble was asked to go.
      bottomLeft: variance(Math.floor(patch * 0.4), canvas.height - patch - 4, patch),
      // The opposite corner, which should be untouched screen.
      topRight: variance(canvas.width - patch - 4, 4, patch),
    };
  });

  expect(corners.width).toBeGreaterThan(0);
  // The bubble is drawn over the screen with a white ring around it, so the corner
  // it occupies cannot look identical to the corner it does not.
  expect(corners.bottomLeft).not.toBeCloseTo(corners.topRight, 1);
});

test('records without a camera when it is turned off', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByLabel('Camera bubble').uncheck();
  // With the camera off there is nothing to compose, and no canvas work per frame.
  await expect(page.getByText(/recorded into the video as a circle/)).toBeHidden();

  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
});

test('floats the controls above everything while recording', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);

  // Chromium supports document picture-in-picture, so a second window should be
  // holding a copy of the controls.
  const supportsFloating = await page.evaluate(() => 'documentPictureInPicture' in window);
  expect(supportsFloating).toBe(true);

  const floating = await page.evaluate(() => {
    const pip = (window as unknown as { documentPictureInPicture?: { window: Window | null } })
      .documentPictureInPicture?.window;
    if (!pip) return null;
    return {
      hasStop: Boolean(pip.document.querySelector('.controls')),
      buttons: [...pip.document.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    };
  });

  expect(floating, 'a floating control window should be open').not.toBeNull();
  expect(floating!.hasStop).toBe(true);
  // Everything needed to end a recording, without switching back to this tab.
  expect(floating!.buttons).toEqual(expect.arrayContaining(['Pause', 'Stop', 'Discard']));

  // The page keeps its own copy, so closing the floating window cannot strand a
  // recording with no way to stop it.
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
});

test('pauses and resumes from the controls', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Pause' }).first().click();
  await expect(page.getByRole('button', { name: 'Resume' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).first().click();
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
});
