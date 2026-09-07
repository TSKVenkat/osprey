import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TEST_ADMIN, type Harness, configureLocalStorage, createHarness, createUserAndLogin, login } from '../testing/harness.ts';

describe('viewer permissions', () => {
  let harness: Harness;
  let adminCookie: string;
  let viewerCookie: string;
  let recordingId: string;
  let uploadSessionId: string;

  beforeEach(async () => {
    harness = await createHarness();
    adminCookie = await login(harness.app, TEST_ADMIN);
    await configureLocalStorage(harness, adminCookie);
    const viewer = await createUserAndLogin(harness.app, adminCookie, {
      email: 'viewer@test.local',
      password: 'viewer-password-1',
      role: 'viewer',
    });
    viewerCookie = viewer.cookie;

    const started = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie: adminCookie },
      payload: { title: 'Viewer test', mimeType: 'video/webm' },
    });
    expect(started.statusCode).toBe(201);
    recordingId = started.json().recordingId;
    uploadSessionId = started.json().uploadSessionId;
  });

  afterEach(async () => {
    await harness.close();
  });

  it('refuses viewers from creating recordings', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie: viewerCookie },
      payload: { title: 'Nope', mimeType: 'video/webm' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from requesting upload targets', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/parts/1/target`,
      headers: { cookie: viewerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from proxy uploading parts', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadSessionId}/parts/1`,
      headers: { cookie: viewerCookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('viewer cannot upload'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from acknowledging upload parts', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/parts/1/ack`,
      headers: { cookie: viewerCookie },
      payload: { etag: 'etag', bytes: 10, sha256: '0'.repeat(64) },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from completing uploads', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/complete`,
      headers: { cookie: viewerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from aborting uploads', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadSessionId}/abort`,
      headers: { cookie: viewerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from reading upload sessions', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/uploads/${uploadSessionId}`,
      headers: { cookie: viewerCookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses viewers from creating shares', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/recordings/${recordingId}/shares`,
      headers: { cookie: viewerCookie },
      payload: { visibility: 'link' },
    });
    expect(response.statusCode).toBe(403);
  });
});
