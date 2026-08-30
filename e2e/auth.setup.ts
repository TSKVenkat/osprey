import { test as setup } from '@playwright/test';

import { ADMIN, ensureStorage, signIn } from './helpers.ts';

export const ADMIN_STATE = 'e2e/.auth/admin.json';

/**
 * Signs in once for the whole run.
 *
 * Every spec used to sign in for itself, which meant a dozen logins a minute from
 * one address for one account — enough to trip the login rate limit and fail a
 * test for a reason that had nothing to do with what it was testing. Reusing the
 * session is also how a person actually uses the thing.
 */
setup('sign in once', async ({ page }) => {
  await signIn(page);
  await ensureStorage(page);
  await page.context().storageState({ path: ADMIN_STATE });
  // Referenced so an unused import cannot creep in as the file changes.
  void ADMIN;
});
