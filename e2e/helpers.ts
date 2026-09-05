import { expect, test, type Locator, type Page } from '@playwright/test';

export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'local-admin-password',
};

/**
 * The library's own heading.
 *
 * Exact, because an empty library also has a heading saying "No recordings yet",
 * and a substring match finds both — which fails only on a fresh instance, the one
 * case nobody runs the suite against until the day they do.
 */
function libraryHeading(page: Page) {
  return page.getByRole('heading', { name: 'Recordings', exact: true });
}

/**
 * Signs in, unless the session restored from storage already has us there.
 */
export async function signIn(page: Page) {
  await page.goto('/');
  if (await libraryHeading(page).isVisible().catch(() => false)) {
    return;
  }
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(libraryHeading(page)).toBeVisible();
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
 * being fixed behind their back — but only after several tries. A full run uploads
 * a dozen recordings to a remote provider while ffmpeg and five containers compete
 * for the same machine, and a single `fetch failed` in the middle of that says
 * nothing about whether the credentials are right. Failing the suite on one of them
 * is the same mistake as replacing the backend on one of them, pointed the other
 * way.
 */
const STORAGE_TEST_ATTEMPTS = 3;

export async function ensureStorage(page: Page) {
  const outcome = await page.evaluate(async (attempts: number) => {
    const existing = await fetch('/v1/admin/storage').then((r) => r.json());
    const current = existing.storage.find((s: { isDefault: boolean }) => s.isDefault) as
      | { id: string; label: string }
      | undefined;

    if (current) {
      let reason = 'no reason given';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const tested = await fetch(`/v1/admin/storage/${current.id}/test`, {
          method: 'POST',
        }).then((r) => r.json());
        if (tested.ok) return 'ok';
        reason = tested.reason ?? reason;
        // Seconds apart, not milliseconds. The failures being retried here are
        // caused by the machine being busy, and three tries inside three seconds is
        // three samples of the same congested moment rather than three chances.
        await new Promise((resolve) => setTimeout(resolve, attempt * 4000));
      }
      return `the configured storage "${current.label}" failed ${attempts} times: ${reason}`;
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
  }, STORAGE_TEST_ATTEMPTS);

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
 * Waits until something is actually on disk in the browser.
 *
 * Not the same thing as waiting on the byte counter, and the difference is the
 * whole race. The recorder counts a chunk the moment `ondataavailable` fires, but the
 * write that follows is fire-and-forget — so bytes are reported before any of them
 * are durable. A crash test that kills the tab on the counter can kill it before
 * the first write lands, and then there is genuinely nothing to recover: no part,
 * no tail, nothing acknowledged, and `planRecovery` correctly discards.
 *
 * That made the crash-recovery specs fail perhaps one run in ten, on a real
 * property of the system rather than a bug — which is the worst kind of flake,
 * because the code it points at is right.
 *
 * A whole part needs 8 MiB and a synthetic screen never gets there, so the thing to
 * wait for is the tail. Read straight out of the origin private file system rather
 * than through the application, so this works against a production build too.
 */
export async function waitForSpilledBytes(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const root = await navigator.storage.getDirectory();
            const recordings = await root.getDirectoryHandle('recordings');
            for await (const [, handle] of (
              recordings as unknown as {
                entries(): AsyncIterable<[string, FileSystemDirectoryHandle]>;
              }
            ).entries()) {
              try {
                const tail = await (await handle.getFileHandle('tail.bin')).getFile();
                if (tail.size > 0) return true;
              } catch {
                // No tail in this recording's directory yet; try the next.
              }
            }
          } catch {
            // No origin private file system, or nothing written yet.
          }
          return false;
        }),
      { timeout: 40_000, message: 'nothing was ever written to the origin private file system' },
    )
    .toBe(true);
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
