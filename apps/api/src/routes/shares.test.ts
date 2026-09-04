import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TEST_ADMIN,
  type Harness,
  configureLocalStorage,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

describe('share links', () => {
  let harness: Harness;
  let cookie: string;
  let recordingId: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
    await configureLocalStorage(harness, cookie);
    recordingId = await record();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function record(): Promise<string> {
    const started = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie },
      payload: { title: 'Shared recording', mimeType: 'video/mp4' },
    });
    const { recordingId: id, uploadSessionId } = started.json();
    await harness.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadSessionId}/parts/1`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: randomBytes(2048),
    });
    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/complete`,
      headers: { cookie },
    });
    return id;
  }

  async function createShare(payload: Record<string, unknown> = {}) {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/recordings/${recordingId}/shares`,
      headers: { cookie },
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json().share as { id: string; token: string };
  }

  function open(token: string, headers: Record<string, string> = {}) {
    return harness.app.inject({ method: 'GET', url: `/v1/shares/${token}`, headers });
  }

  it('opens a shared recording with no account at all', async () => {
    const share = await createShare();

    const response = await open(share.token);

    expect(response.statusCode).toBe(200);
    expect(response.json().recording).toMatchObject({ title: 'Shared recording' });
    expect(response.json().playback.url).toMatch(/^https?:\/\//);
  });

  it('mints a token long enough that guessing is not a strategy', async () => {
    const share = await createShare();
    // 32 random bytes, base64url.
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never stores the token in a form the database alone can replay', async () => {
    const share = await createShare();
    const rows = await harness.db.query.shareLinks.findMany();

    expect(rows[0]!.tokenHash).not.toBe(share.token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The ciphertext exists so the owner can be shown the link again, but it is
    // useless without the instance key.
    expect(rows[0]!.tokenCt).not.toContain(share.token);
  });

  it('shows the owner their own link again later', async () => {
    const share = await createShare();

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${recordingId}/shares`,
      headers: { cookie },
    });

    expect(listed.json().shares[0].token).toBe(share.token);
  });

  it('never returns the hash or the ciphertext', async () => {
    await createShare();
    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/recordings/${recordingId}/shares`,
      headers: { cookie },
    });

    for (const field of ['tokenHash', 'tokenCt', 'tokenIv', 'tokenTag', 'passwordHash']) {
      expect(listed.body).not.toContain(field);
    }
  });

  it('stops working once revoked', async () => {
    const share = await createShare();
    expect((await open(share.token)).statusCode).toBe(200);

    await harness.app.inject({
      method: 'DELETE',
      url: `/v1/shares/${share.id}`,
      headers: { cookie },
    });

    expect((await open(share.token)).statusCode).toBe(404);
  });

  it('stops working once expired', async () => {
    const share = await createShare({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await open(share.token)).statusCode).toBe(404);
  });

  it('stops working when the recording is deleted', async () => {
    const share = await createShare();
    await harness.app.inject({
      method: 'DELETE',
      url: `/v1/recordings/${recordingId}`,
      headers: { cookie },
    });

    expect((await open(share.token)).statusCode).toBe(404);
  });

  it('answers an unknown token the same way as a revoked one', async () => {
    const share = await createShare();
    await harness.app.inject({
      method: 'DELETE',
      url: `/v1/shares/${share.id}`,
      headers: { cookie },
    });

    const revoked = await open(share.token);
    const nonsense = await open('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    // Revoked, expired and never-existed must be indistinguishable from outside.
    expect(revoked.statusCode).toBe(404);
    expect(nonsense.json()).toEqual(revoked.json());
  });

  describe('password protected', () => {
    it('refuses until the password is given', async () => {
      const share = await createShare({ visibility: 'password', password: 'let-me-in-please' });

      const response = await open(share.token);

      // A distinct code, so the page can ask for a password rather than showing a
      // dead link.
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toMatch(/password protected/i);
    });

    it('opens after unlocking, and remembers it', async () => {
      const share = await createShare({ visibility: 'password', password: 'let-me-in-please' });

      const unlocked = await harness.app.inject({
        method: 'POST',
        url: `/v1/shares/${share.token}/unlock`,
        payload: { password: 'let-me-in-please' },
      });
      expect(unlocked.statusCode).toBe(200);

      const unlockCookie = unlocked.cookies[0]!;
      const response = await open(share.token, {
        cookie: `${unlockCookie.name}=${unlockCookie.value}`,
      });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a wrong password', async () => {
      const share = await createShare({ visibility: 'password', password: 'let-me-in-please' });

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/shares/${share.token}/unlock`,
        payload: { password: 'wrong' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('rejects a forged unlock cookie', async () => {
      const share = await createShare({ visibility: 'password', password: 'let-me-in-please' });
      const name = `osprey_share_${share.id.replace(/-/g, '')}`;

      const response = await open(share.token, {
        cookie: `${name}=${Date.now() + 100000}.deadbeef`,
      });

      // The cookie is signed, so inventing one does not work.
      expect(response.statusCode).toBe(403);
    });

    it('requires a password when one is asked for', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/recordings/${recordingId}/shares`,
        headers: { cookie },
        payload: { visibility: 'password' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('PASSWORD_REQUIRED');
    });
  });

  describe('sign-in required', () => {
    it('refuses an anonymous viewer', async () => {
      const share = await createShare({ visibility: 'authenticated' });
      expect((await open(share.token)).statusCode).toBe(401);
    });

    it('lets any signed-in person watch', async () => {
      const share = await createShare({ visibility: 'authenticated' });
      const member = await createUserAndLogin(harness.app, cookie, {
        email: 'member@test.local',
        password: 'member-password-1',
      });

      const response = await open(share.token, { cookie: member.cookie });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('who can create and revoke', () => {
    it('refuses to share someone else\'s recording', async () => {
      const member = await createUserAndLogin(harness.app, cookie, {
        email: 'member@test.local',
        password: 'member-password-1',
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/recordings/${recordingId}/shares`,
        headers: { cookie: member.cookie },
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });

    it('refuses to revoke someone else\'s link', async () => {
      const share = await createShare();
      const member = await createUserAndLogin(harness.app, cookie, {
        email: 'member@test.local',
        password: 'member-password-1',
      });

      const response = await harness.app.inject({
        method: 'DELETE',
        url: `/v1/shares/${share.id}`,
        headers: { cookie: member.cookie },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('view counting', () => {
    // Asserts success, so a rejected payload cannot quietly look like "no views".
    async function report(token: string, body: Record<string, unknown>) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/shares/${token}/views`,
        payload: { watchedMs: 0, maxPositionMs: 0, ...body },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response;
    }

    it('counts one viewing once, however often it reports progress', async () => {
      const share = await createShare();

      await report(share.token, { sessionKey: 'viewer-one', watchedMs: 1000, maxPositionMs: 1000 });
      await report(share.token, { sessionKey: 'viewer-one', watchedMs: 5000, maxPositionMs: 5000 });
      await report(share.token, { sessionKey: 'viewer-one', watchedMs: 9000, maxPositionMs: 9000 });

      const stats = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/${recordingId}/views`,
        headers: { cookie },
      });

      expect(stats.json()).toMatchObject({ views: 1, totalWatchedMs: 9000 });
    });

    it('counts separate viewers separately', async () => {
      const share = await createShare();
      await report(share.token, { sessionKey: 'viewer-one', watchedMs: 1000 });
      await report(share.token, { sessionKey: 'viewer-two', watchedMs: 2000 });

      const stats = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/${recordingId}/views`,
        headers: { cookie },
      });

      expect(stats.json().views).toBe(2);
    });

    it('never moves progress backwards', async () => {
      const share = await createShare();
      await report(share.token, { sessionKey: 'viewer-session', watchedMs: 8000, maxPositionMs: 8000 });
      // A viewer who seeks back to the start has still watched eight seconds.
      await report(share.token, { sessionKey: 'viewer-session', watchedMs: 500, maxPositionMs: 500 });

      const stats = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/${recordingId}/views`,
        headers: { cookie },
      });

      expect(stats.json().totalWatchedMs).toBe(8000);
    });

    it('remembers a completion even if a later report is not one', async () => {
      const share = await createShare();
      await report(share.token, { sessionKey: 'viewer-session', watchedMs: 9000, completed: true });
      await report(share.token, { sessionKey: 'viewer-session', watchedMs: 9000, completed: false });

      const stats = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/${recordingId}/views`,
        headers: { cookie },
      });

      expect(stats.json().completions).toBe(1);
    });

    it('keeps view counts away from people who do not own the recording', async () => {
      const member = await createUserAndLogin(harness.app, cookie, {
        email: 'member@test.local',
        password: 'member-password-1',
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/recordings/${recordingId}/views`,
        headers: { cookie: member.cookie },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
