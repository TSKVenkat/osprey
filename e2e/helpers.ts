import { expect, test, type Locator, type Page } from '@playwright/test';

export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'local-admin-password',
};

/**
 * Signs in, unless the session restored from storage already has us there.
 */
export async function signIn(page: Page) {
  await page.goto('/');
  if (await page.getByRole('heading', { name: 'Recordings' }).isVisible().catch(() => false)) {
    return;
  }
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible();
}

/**
 * Makes sure the instance has somewhere to put recordings.
 *
 * It will configure one when there is none — a fresh instance, which is what CI
 * has — and otherwise leaves whatever is there alone. It used to re-test the
 * existing default and replace it on failure, which quietly repointed the storage
 * of an instance somebody was actually using: a blip during a test run was enough
 * to move their recordings somewhere else without telling them.
 *
 * A default that is configured but broken now fails the test, loudly, rather than
 * being fixed behind their back.
 */
export async function ensureStorage(page: Page) {
  const outcome = await page.evaluate(async () => {
    const existing = await fetch('/v1/admin/storage').then((r) => r.json());
    const current = existing.storage.find((s: { isDefault: boolean }) => s.isDefault) as
      | { id: string; label: string }
      | undefined;

    if (current) {
      const tested = await fetch(`/v1/admin/storage/${current.id}/test`, {
        method: 'POST',
      }).then((r) => r.json());
      return tested.ok
        ? 'ok'
        : `the configured storage "${current.label}" is not working: ${tested.reason ?? 'no reason given'}`;
    }

    const created = await fetch('/v1/admin/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'local',
        label: 'End-to-end disk',
        config: { root: './data/e2e-storage' },
        makeDefault: true,
      }),
    }).then((r) => r.json());

    return created.storage ? 'ok' : `could not configure storage: ${JSON.stringify(created)}`;
  });

  expect(outcome, 'the instance needs working storage before recording').toBe('ok');
}

/**
 * Some specs reach into the application's own modules to drive them directly.
 * That only works behind the dev server, which serves source; a production build
 * has no such paths, and those specs skip rather than fail against one.
 */
export async function requireDevServer(page: Page) {
  const response = await page.request.get('/src/lib/capture.ts');
  // A production build answers every unknown path with index.html so that deep
  // links work, which means a 200 proves nothing. What proves it is getting back
  // the module rather than the page.
  const body = response.ok() ? await response.text() : '';
  const isModule = body.startsWith('import') || body.includes('export ');
  test.skip(
    !isModule,
    'needs the Vite dev server: this spec imports application modules directly',
  );
}

/**
 * Waits until the recorder has actually taken in some video.
 *
 * MediaRecorder hands over a chunk every few seconds, so a fixed sleep is a race:
 * too short and the tab is killed before anything was recorded, and the test then
 * fails for a reason that has nothing to do with what it is testing.
 *
 * The signal is how many bytes the recorder has taken in, which works against a
 * production build too — and a chunk arriving is what causes the write to disk, so
 * waiting on it waits for the write.
 */
export async function waitForRecordedBytes(page: Page) {
  await expect
    .poll(
      async () =>
        Number(
          (await page.locator('[data-recording]').first().getAttribute('data-recorded-bytes')) ?? 0,
        ),
      { timeout: 40_000, message: 'the recorder never took in any video' },
    )
    .toBeGreaterThan(0);
}

/**
 * Waits until the recorder is actually running.
 *
 * Keyed off a marker attribute rather than the wording of the progress line. That
 * wording has now changed twice, and both times it broke several specs across
 * several files for reasons that had nothing to do with recording.
 */
export async function waitUntilRecording(page: Page) {
  await expect(page.locator('[data-recording]').first()).toBeVisible({ timeout: 30_000 });
}

export interface PlaybackState {
  readyState: number;
  duration: number;
  currentTime: number;
  width: number;
  error: string | null;
}

/**
 * Waits for a video to be genuinely playable, then reports what it is doing.
 *
 * Deliberately not a race against a timeout that resolves anyway: falling through
 * with an unloaded element turns "the recording did not load" into "the duration
 * is NaN", which reads as a product bug and passes or fails depending on how busy
 * the machine is.
 */
export async function playbackState(
  video: Locator,
  { play = true }: { play?: boolean } = {},
): Promise<PlaybackState> {
  await expect
    .poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState), {
      timeout: 30_000,
      message: 'the recording never became playable',
    })
    .toBeGreaterThanOrEqual(2);

  return video.evaluate(async (element: HTMLVideoElement, shouldPlay: boolean) => {
    if (shouldPlay) {
      await element.play().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return {
      readyState: element.readyState,
      duration: element.duration,
      currentTime: element.currentTime,
      width: element.videoWidth,
      error: element.error?.message ?? null,
    };
  }, play);
}

/** Records a short clip and leaves the page on the watch view. */
export async function recordSomething(page: Page, title: string): Promise<string> {
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: /Choose a screen and start/ }).click();
  await waitUntilRecording(page);
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Ready to share')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Watch it' }).click();
  await expect(page.locator('video.player')).toBeVisible();

  // Recordings are named after the fact now, which is when somebody knows what is
  // in them.
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('textbox').first().fill(title);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return page.url();
}
