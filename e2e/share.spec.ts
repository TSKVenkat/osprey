import { expect, test } from '@playwright/test';

import { ensureStorage, recordSomething, signIn } from './helpers.ts';

/**
 * Sharing, from the owner creating a link to a stranger watching it. The viewer
 * runs in a separate browser context with no cookies, which is the only honest way
 * to test that a share link works without an account.
 */

test('a stranger can watch a shared recording', async ({ page, browser }) => {
  await signIn(page);
  await ensureStorage(page);
  const title = `Shared ${Date.now()}`;
  await recordSomething(page, title);

  await page.getByRole('button', { name: 'Create link' }).click();
  const link = page.locator('.mono').first();
  await expect(link).toContainText('/s/');
  const shareUrl = (await link.innerText()).trim();

  // A fresh context: no session cookie, no storage, nothing carried over.
  const stranger = await browser.newContext();
  const viewer = await stranger.newPage();
  await viewer.goto(shareUrl);

  await expect(viewer.getByRole('heading', { name: title })).toBeVisible();
  const played = await viewer.locator('video.player').evaluate(async (element: HTMLVideoElement) => {
    await new Promise<void>((resolve) => {
      if (element.readyState >= 2) return resolve();
      element.addEventListener('loadeddata', () => resolve(), { once: true });
      setTimeout(resolve, 20_000);
    });
    await element.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    return { currentTime: element.currentTime, duration: element.duration, error: element.error?.message ?? null };
  });

  expect(played.error).toBeNull();
  expect(played.currentTime).toBeGreaterThan(0);
  expect(Number.isFinite(played.duration)).toBe(true);

  await stranger.close();
});

test('a revoked link stops working', async ({ page, browser }) => {
  await signIn(page);
  await ensureStorage(page);
  await recordSomething(page, `Revoked ${Date.now()}`);

  await page.getByRole('button', { name: 'Create link' }).click();
  const shareUrl = (await page.locator('.mono').first().innerText()).trim();

  await page.getByRole('button', { name: 'Revoke' }).first().click();

  const stranger = await browser.newContext();
  const viewer = await stranger.newPage();
  await viewer.goto(shareUrl);

  // Deliberately vague, and identical to a link that never existed.
  await expect(viewer.getByText('Not available', { exact: true })).toBeVisible();
  await stranger.close();
});

test('a password-protected link asks before it plays', async ({ page, browser }) => {
  await signIn(page);
  await ensureStorage(page);
  await recordSomething(page, `Protected ${Date.now()}`);

  await page.getByLabel('Who can watch').selectOption('password');
  // Named by role: getByLabel('Password') also matches the select, whose options
  // mention a password.
  await page.getByRole('textbox', { name: 'Password' }).fill('open-sesame-please');
  await page.getByRole('button', { name: 'Create link' }).click();
  const shareUrl = (await page.locator('.mono').first().innerText()).trim();

  const stranger = await browser.newContext();
  const viewer = await stranger.newPage();
  await viewer.goto(shareUrl);

  await expect(viewer.getByRole('heading', { name: 'Password required' })).toBeVisible();

  await viewer.getByLabel('Password').fill('wrong-password');
  await viewer.getByRole('button', { name: 'Watch' }).click();
  await expect(viewer.getByText(/not correct/)).toBeVisible();

  await viewer.getByLabel('Password').fill('open-sesame-please');
  await viewer.getByRole('button', { name: 'Watch' }).click();
  await expect(viewer.locator('video.player')).toBeVisible();

  await stranger.close();
});
