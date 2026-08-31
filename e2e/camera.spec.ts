import { expect, test } from '@playwright/test';

import { ensureStorage, signIn, waitUntilRecording } from './helpers.ts';

/**
 * The camera during a recording.
 *
 * Chrome's fake capture always reports the whole screen, which is the case where
 * the camera can be a real window sitting on it. The other case — the camera
 * painted into the picture, for a shared window or tab — cannot be reached without
 * a real capture picker, so the compositor is exercised directly in
 * composite.spec.ts and the choice between the two in camera-mode.test.ts.
 */

test('puts the camera in a window that can be dragged around the screen', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);

  const bubble = await page.evaluate(() => {
    const pip = (window as unknown as { documentPictureInPicture?: { window: Window | null } })
      .documentPictureInPicture?.window;
    if (!pip) return null;
    return {
      mode: pip.document.querySelector('[data-camera-mode]')?.getAttribute('data-camera-mode'),
      hasVideo: Boolean(pip.document.querySelector('.bubble-circle video')),
      buttons: [...pip.document.querySelectorAll('button')].map((b) => b.textContent?.trim()),
    };
  });

  // The window is the bubble: the camera is in it, and so is everything needed to
  // end the recording without going back to the tab, which would itself be
  // recorded.
  expect(bubble).not.toBeNull();
  expect(bubble!.mode).toBe('on-screen');
  expect(bubble!.hasVideo).toBe(true);
  expect(bubble!.buttons).toEqual(expect.arrayContaining(['Pause', 'Stop', 'Discard']));

  // Nothing is painted into the picture here, or the presenter would appear twice:
  // once in the window that is genuinely on screen, once drawn on top.
  await expect(page.locator('.stage')).toHaveCount(0);
  await expect(page.getByText(/Drag it wherever you want/)).toBeVisible();

  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
});

test('records without a camera when it is turned off', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: 'Camera' }).click();
  await expect(page.getByRole('button', { name: 'Camera' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);

  // No camera means no bubble window; the floating window holds the plain
  // controls instead.
  const floating = await page.evaluate(() => {
    const pip = (window as unknown as { documentPictureInPicture?: { window: Window | null } })
      .documentPictureInPicture?.window;
    if (!pip) return null;
    return {
      hasBubble: Boolean(pip.document.querySelector('.bubble-circle')),
      hasControls: Boolean(pip.document.querySelector('.controls')),
    };
  });
  expect(floating?.hasBubble).toBe(false);
  expect(floating?.hasControls).toBe(true);

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
