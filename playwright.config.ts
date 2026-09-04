import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * The instance's own .env, so the suite signs in with the account that instance
 * actually has.
 *
 * Without this the credentials are compiled-in defaults, and the moment somebody
 * changes ADMIN_EMAIL the suite fails at sign-in with "heading not visible" — which
 * says nothing about the real problem. Node has no built-in .env reader that works
 * across the versions this supports, and the file is four lines of parsing, so it
 * is four lines of parsing rather than a dependency.
 *
 * Anything already in the environment wins, so `ADMIN_EMAIL=… pnpm test:e2e` still
 * overrides the file and CI, which sets no file at all, is unaffected.
 */
function loadDotEnv(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is normal: CI passes everything in the environment.
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = rawValue!.trim().replace(/^["']|["']$/g, '');
  }
}

loadDotEnv();

const webUrl = process.env.E2E_WEB_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  // Screen capture and upload are slow enough that the default is too tight.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: {
        channel: 'chrome',
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    {
      name: 'chrome',
      dependencies: ['setup'],
      use: {
        // Signed in once by the setup project, so the suite does not spend its
        // login budget proving it can log in.
        storageState: 'e2e/.auth/admin.json',
        // The Chrome already installed on the machine, rather than a downloaded
        // build: screen capture behaves like the real thing that way.
        channel: 'chrome',
        launchOptions: {
          args: [
            // Grant capture permission and feed it a synthetic screen and
            // microphone, so a run needs no human to click anything.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
});
