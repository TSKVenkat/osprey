import { defineConfig } from '@playwright/test';

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
