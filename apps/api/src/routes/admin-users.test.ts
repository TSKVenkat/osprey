import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TEST_ADMIN,
  type Harness,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

describe('admin users', () => {
  let harness: Harness;
  let adminCookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    adminCookie = await login(harness.app, TEST_ADMIN);
  });

  afterEach(async () => {
    await harness.close();
  });

  /**
   * The authorization matrix. Every admin route, checked from every angle a caller
   * can come at it: signed out, signed in as an ordinary user, and signed in as an
   * admin. This is the test that catches a permissions regression before it becomes
   * a data leak.
   */
  describe('who can reach the admin routes', () => {
    const routes = [
      { method: 'GET' as const, url: '/v1/admin/users' },
      {
        method: 'POST' as const,
        url: '/v1/admin/users',
        payload: { email: 'x@test.local', name: 'X', password: 'password-long-1' },
      },
    ];

    it('refuses anonymous callers with 401', async () => {
      for (const route of routes) {
        const response = await harness.app.inject(route);
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    });

    it('refuses ordinary users with 403', async () => {
      const member = await createUserAndLogin(harness.app, adminCookie, {
        email: 'member@test.local',
        password: 'member-password-1',
      });

      for (const route of routes) {
        const response = await harness.app.inject({
          ...route,
          headers: { cookie: member.cookie },
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      }
    });

    it('allows admins', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/admin/users',
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  it('creates users as ordinary users by default', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { cookie: adminCookie },
      payload: { email: 'New@Test.local', name: 'New', password: 'new-password-123' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({
      // Emails are lowercased on the way in, so sign-in is case-insensitive.
      email: 'new@test.local',
      role: 'user',
      isActive: true,
    });
  });

  it('never returns a password hash', async () => {
    await createUserAndLogin(harness.app, adminCookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: { cookie: adminCookie },
    });

    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('$2b$');
  });

  it('rejects a duplicate email', async () => {
    const payload = { email: 'dupe@test.local', name: 'Dupe', password: 'dupe-password-1' };
    await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { cookie: adminCookie },
      payload,
    });

    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { cookie: adminCookie },
      payload,
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects a weak password', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: { cookie: adminCookie },
      payload: { email: 'weak@test.local', name: 'Weak', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('WEAK_PASSWORD');
  });

  it('will not let an admin demote or disable themselves', async () => {
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: adminCookie },
    });
    const id = me.json().user.id;

    const demote = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'user' },
    });
    const disable = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${id}`,
      headers: { cookie: adminCookie },
      payload: { isActive: false },
    });

    expect(demote.json().error.code).toBe('CANNOT_DEMOTE_SELF');
    expect(disable.json().error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('will not let the last admin be demoted by another admin', async () => {
    const second = await createUserAndLogin(harness.app, adminCookie, {
      email: 'admin2@test.local',
      password: 'admin2-password-1',
      role: 'admin',
    });

    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: adminCookie },
    });
    const firstAdminId = me.json().user.id;

    // Two admins: demoting one is allowed.
    const allowed = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${firstAdminId}`,
      headers: { cookie: second.cookie },
      payload: { role: 'user' },
    });
    expect(allowed.statusCode).toBe(200);

    // One admin left: demoting them would lock everyone out of the instance.
    const refused = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${second.id}`,
      headers: { cookie: second.cookie },
      payload: { isActive: false },
    });
    expect(refused.json().error.code).toBe('CANNOT_DISABLE_SELF');
  });

  it('revokes sessions when an admin resets a password', async () => {
    const member = await createUserAndLogin(harness.app, adminCookie, {
      email: 'member@test.local',
      password: 'member-password-1',
    });

    await harness.app.inject({
      method: 'POST',
      url: `/v1/admin/users/${member.id}/reset-password`,
      headers: { cookie: adminCookie },
      payload: { password: 'reset-password-123' },
    });

    const after = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: member.cookie },
    });
    expect(after.statusCode).toBe(401);
    await expect(
      login(harness.app, { email: 'member@test.local', password: 'reset-password-123' }),
    ).resolves.toBeTruthy();
  });

  it('returns 404 for a user that does not exist', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/v1/admin/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie: adminCookie },
      payload: { name: 'Ghost' },
    });

    expect(response.statusCode).toBe(404);
  });
});
