import { expect, test, type Page } from '@playwright/test';

/**
 * Crash recovery, by actually crashing.
 *
 * This is the failure the part store exists for: a tab that dies partway through a
 * recording. Nothing short of killing the page really tests it, because the whole
 * mechanism is about what survives when the JavaScript stops running.
 */

const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'local-admin-password',
};

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible();
}

async function ensureStorage(page: Page) {
  await page.evaluate(async () => {
    const existing = await fetch('/v1/admin/storage').then((r) => r.json());
    if (existing.storage.some((s: { isDefault: boolean }) => s.isDefault)) return;
    const created = await fetch('/v1/admin/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'local',
        label: 'End-to-end disk',
        config: { root: './data/e2e-storage' },
      }),
    }).then((r) => r.json());
    await fetch(`/v1/admin/storage/${created.storage.id}/default`, { method: 'POST' });
  });
}

/**
 * Waits until something is actually on disk to recover.
 *
 * MediaRecorder hands over a chunk every few seconds, so a fixed sleep is a race:
 * too short and the tab is killed before anything was written, and the test fails
 * for a reason that has nothing to do with recovery.
 */
async function waitForSpilledBytes(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { chooseStore } = await import('/src/lib/capture.ts');
          const { store } = chooseStore();
          const manifests = await store.loadManifests();
          let bytes = 0;
          for (const manifest of manifests) {
            bytes += (await store.getTail(manifest.recordingId))?.size ?? 0;
            bytes += (await store.list(manifest.recordingId)).length;
          }
          return bytes;
        }),
      { timeout: 40_000, message: 'nothing was written to disk to recover' },
    )
    .toBeGreaterThan(0);
}

test('offers to finish a recording the browser was killed during', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  const title = `Interrupted ${Date.now()}`;
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await expect(page.getByText(/uploaded/)).toBeVisible({ timeout: 30_000 });

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
  await expect(reopened.getByRole('link', { name: title })).toBeVisible();

  // The leftovers are cleared once they have been dealt with, so the offer does
  // not come back on the next visit.
  await reopened.goto('/record');
  await expect(reopened.getByText('Unfinished recording', { exact: true })).toBeHidden();

  await context.close();
});

test('lets an unfinished recording be thrown away', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page);
  await ensureStorage(page);

  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByLabel('Title').fill(`Discarded ${Date.now()}`);
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await expect(page.getByText(/uploaded/)).toBeVisible({ timeout: 30_000 });
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
