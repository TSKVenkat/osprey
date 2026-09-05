import { expect, test } from '@playwright/test';

import {
  ensureStorage,
  signIn,
  waitForSpilledBytes,
  waitUntilRecording,
} from './helpers.ts';

/**
 * Crash recovery, by actually crashing.
 *
 * This is the failure the part store exists for: a tab that dies partway through a
 * recording. Nothing short of killing the page really tests it, because the whole
 * mechanism is about what survives when the JavaScript stops running.
 */

test('offers to finish a recording the browser was killed during', async ({ browser }) => {
  // A fresh context, but carrying the session saved once at the start of the run:
  // a new browser profile is the point here, not a new sign-in.
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await context.newPage();

  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);

  await waitForSpilledBytes(page);

  // The tab dies. No stop, no flush, no commit — the recorder gets no chance to
  // clean up after itself, which is exactly the situation being tested.
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto('/record');

  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeVisible({ timeout: 20_000 });
  await reopened.getByRole('button', { name: 'Finish it' }).click();

  // Recovery ends where an ordinary recording ends: on the watch page.
  await expect(reopened.locator('video.player')).toBeVisible({ timeout: 60_000 });

  // Playback is deliberately not asserted here. A recording whose tab was killed
  // ends mid-fragment, so the file as recovered can be unplayable until the worker
  // rebuilds it — which is why finishing a recovered upload marks it interrupted.
  // That repair is covered where it can be tested deterministically, in
  // apps/worker/src/process-recording.test.ts.

  // What matters here is that the recording exists and belongs to the library.
  await reopened.goto('/');
  await expect(reopened.getByRole('link', { name: 'Untitled recording' }).first()).toBeVisible();

  // The leftovers are cleared once they have been dealt with, so the offer does
  // not come back on the next visit.
  await reopened.goto('/record');
  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeHidden();

  await context.close();
});

test('lets an unfinished recording be thrown away', async ({ browser }) => {
  // A fresh context, but carrying the session saved once at the start of the run:
  // a new browser profile is the point here, not a new sign-in.
  const context = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const page = await context.newPage();

  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);
  await waitForSpilledBytes(page);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto('/record');
  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeVisible({ timeout: 20_000 });

  await reopened.getByRole('button', { name: 'Discard' }).click();

  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeHidden();
  await reopened.reload();
  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeHidden();

  await context.close();
});

test('says nothing when there is nothing to recover', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Record', exact: true }).click();

  await expect(page.getByRole('button', { name: /Choose a screen and start/ })).toBeVisible();
  await expect(page.getByText('Unfinished recording', { exact: true })).toBeHidden();
});
