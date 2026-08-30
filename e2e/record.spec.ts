import { expect, test, type Page } from '@playwright/test';

import { ADMIN, ensureStorage, signIn } from './helpers.ts';

/**
 * The whole product in one pass: sign in, capture a real screen through Chrome,
 * upload it, and play it back. Everything underneath is covered by unit and
 * integration tests; what only a browser can prove is that the pieces fit.
 *
 * Chrome is started with a synthetic screen and microphone, so nothing has to be
 * clicked by hand. See playwright.config.ts.
 */

/** How long to let the recorder run before stopping it. */
const RECORD_MS = 8000;

async function recordOnce(page: Page, title: string) {
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();

  // The status line only appears once capture is actually running.
  await expect(page.getByText(/uploaded/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(RECORD_MS);

  const stoppedAt = Date.now();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
  return { timeToLinkMs: Date.now() - stoppedAt };
}

test('records the screen, uploads it, and plays it back', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  const title = `End-to-end ${Date.now()}`;
  const { timeToLinkMs } = await recordOnce(page, title);

  // Parts go up while the recording is still running, so stopping only has to
  // flush the tail. If this ever creeps towards the length of the recording, the
  // upload has stopped overlapping with capture.
  expect(timeToLinkMs).toBeLessThan(15_000);

  await page.getByRole('button', { name: 'Watch it' }).click();
  const video = page.locator('video.player');
  await expect(video).toBeVisible();

  const played = await video.evaluate(async (element: HTMLVideoElement) => {
    await new Promise<void>((resolve) => {
      if (element.readyState >= 2) return resolve();
      element.addEventListener('loadeddata', () => resolve(), { once: true });
      setTimeout(resolve, 20_000);
    });
    await element.play().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      readyState: element.readyState,
      duration: element.duration,
      currentTime: element.currentTime,
      width: element.videoWidth,
      height: element.videoHeight,
      error: element.error?.message ?? null,
    };
  });

  expect(played.error).toBeNull();
  expect(played.readyState).toBeGreaterThanOrEqual(3);
  expect(played.width).toBeGreaterThan(0);
  expect(played.currentTime).toBeGreaterThan(0);

  // A finite duration is not a given. A WebM recording reports Infinity, which is
  // what leaves the scrubber broken; recording to MP4 is what fixes it, and this
  // is the assertion that keeps that fix honest.
  expect(Number.isFinite(played.duration)).toBe(true);
  expect(played.duration).toBeGreaterThan(RECORD_MS / 1000 - 3);

  const seeked = await video.evaluate(async (element: HTMLVideoElement) => {
    element.currentTime = 3;
    return new Promise<boolean>((resolve) => {
      element.addEventListener('seeked', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 10_000);
    });
  });
  expect(seeked).toBe(true);

  await page.getByRole('link', { name: 'Back to recordings' }).click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText(/do not match an active account/)).toBeVisible();
});

test('offers system audio only where the browser supports it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Record', exact: true }).click();

  // Chromium can capture system audio, so the control is available here. On
  // Firefox and Safari it is disabled with a note rather than silently producing
  // a silent recording.
  await expect(page.getByLabel('System audio')).toBeEnabled();
});
