import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@osprey/db';

import {
  TEST_ADMIN,
  type Harness,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

describe('auth', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('signs in the bootstrapped admin and returns their identity', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);

    const me = await harness.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: TEST_ADMIN.email, role: 'admin' });
  });

  it('sets a session cookie that is httpOnly', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: TEST_ADMIN,
    });

    const cookie = response.cookies.find((c) => c.name === 'osprey_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('rejects a wrong password and an unknown email the same way', async () => {
    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: TEST_ADMIN.email, password: 'not-the-password' },
    });
    const unknownEmail = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test.local', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Identical responses: the API must not reveal which emails have accounts.
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('refuses a request with no session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('stops accepting a session after logout', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);

    await harness.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });

    const after = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('stops accepting a session as soon as the account is disabled', async () => {
    const adminCookie = await login(harness.app, TEST_ADMIN);
    const member = await createUserAndLogin(harness.app, adminCookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${member.id}`,
      headers: { cookie: adminCookie },
      payload: { isActive: false },
    });

    const after = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: member.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('never stores the session token itself', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);
    const token = cookie.split('=')[1]!;

    const stored = await harness.db.query.sessions.findMany();

    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(token);
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes a password and revokes every existing session', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);

    const changed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: TEST_ADMIN.password, newPassword: 'a-brand-new-password' },
    });
    expect(changed.statusCode).toBe(200);

    const oldSession = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    });
    expect(oldSession.statusCode).toBe(401);

    await expect(
      login(harness.app, { email: TEST_ADMIN.email, password: 'a-brand-new-password' }),
    ).resolves.toBeTruthy();
  });

  it('rejects a password change with the wrong current password', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'wrong', newPassword: 'a-brand-new-password' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a password that is too short', async () => {
    const cookie = await login(harness.app, TEST_ADMIN);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: TEST_ADMIN.password, newPassword: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('WEAK_PASSWORD');
  });

  it('limits guessing at one account without locking out the others', async () => {
    const adminCookie = await login(harness.app, TEST_ADMIN);
    await createUserAndLogin(harness.app, adminCookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    const attempt = (email: string) =>
      harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email, password: 'wrong-password' },
      });

    // Hammer one account until the limiter stops answering.
    let blocked = false;
    for (let i = 0; i < 15 && !blocked; i++) {
      blocked = (await attempt('member@test.local')).statusCode === 429;
    }
    expect(blocked, 'repeated guesses at one account should be throttled').toBe(true);

    // A different account from the same address is unaffected. Keyed on address
    // alone, everyone behind one office router would share a budget and could lock
    // each other out of their own accounts.
    const other = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: TEST_ADMIN,
    });
    expect(other.statusCode).toBe(200);
  });

  it('stores passwords as bcrypt hashes, not as text', async () => {
    const rows = await harness.db
      .select()
      .from(users)
      .where(eq(users.email, TEST_ADMIN.email));

    expect(rows[0]!.passwordHash).not.toContain(TEST_ADMIN.password);
    // Tests run bcrypt at its minimum cost for speed; production uses 12. Either
    // way what lands in the column is a bcrypt hash, never the password.
    expect(rows[0]!.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });
});
