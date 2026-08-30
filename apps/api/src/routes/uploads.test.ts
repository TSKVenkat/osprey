import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TEST_ADMIN,
  type Harness,
  configureLocalStorage,
  createHarness,
  createUserAndLogin,
  login,
} from '../testing/harness.ts';

const MIME = 'video/webm';

describe('uploads', () => {
  let harness: Harness;
  let cookie: string;

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
    await configureLocalStorage(harness, cookie);
  });

  afterEach(async () => {
    await harness.close();
  });

  async function startRecording(as = cookie) {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/recordings',
      headers: { cookie: as },
      payload: { title: 'Test recording', mimeType: MIME },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as {
      recordingId: string;
      uploadSessionId: string;
      partSize: number;
      capabilities: { multipart: boolean; directUpload: boolean };
    };
  }

  async function sendPart(sessionId: string, partNumber: number, body: Buffer, as = cookie) {
    return harness.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${sessionId}/parts/${partNumber}`,
      headers: { cookie: as, 'content-type': 'application/octet-stream' },
      payload: body,
    });
  }

  it('carries a recording from creation through to playable bytes on disk', async () => {
    const started = await startRecording();
    const parts = [randomBytes(4096), randomBytes(4096), randomBytes(517)];

    for (const [index, part] of parts.entries()) {
      const response = await sendPart(started.uploadSessionId, index + 1, part);
      expect(response.statusCode).toBe(200);
      expect(response.json().sha256).toBe(createHash('sha256').update(part).digest('hex'));
    }

    const completed = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/complete`,
      headers: { cookie },
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ state: 'ready' });

    // The bytes on disk have to be exactly what was sent, in order. This is the
    // assertion the whole upload path exists to satisfy.
    const stored = await readFile(
      join(harness.storageRoot, 'r', started.recordingId, 'original.webm'),
    );
    expect(stored).toEqual(Buffer.concat(parts));
  });

  it('tells the client how to send parts', async () => {
    const started = await startRecording();

    // Eight MiB, above the S3 floor and unaffected by the local backend's tiny one.
    expect(started.partSize).toBe(8 * 1024 * 1024);
    // The local backend cannot take uploads straight from a browser, and says so.
    expect(started.capabilities.directUpload).toBe(false);

    const target = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/parts/1/target`,
      headers: { cookie },
    });
    expect(target.json()).toMatchObject({ mode: 'proxy' });
  });

  it('accepts the same part twice without duplicating it', async () => {
    const started = await startRecording();
    const body = randomBytes(2048);

    const first = await sendPart(started.uploadSessionId, 1, body);
    const second = await sendPart(started.uploadSessionId, 1, body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().etag).toBe(first.json().etag);

    const parts = await harness.db.query.uploadParts.findMany();
    expect(parts).toHaveLength(1);
  });

  it('refuses a part number that arrives with different bytes', async () => {
    const started = await startRecording();

    await sendPart(started.uploadSessionId, 1, randomBytes(2048));
    const conflicting = await sendPart(started.uploadSessionId, 1, randomBytes(2048));

    // Two different byte sequences claiming one slot is corruption, not a retry.
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe('UPLOAD_PART_MISMATCH');
  });

  it('reassembles parts that arrive out of order', async () => {
    const started = await startRecording();
    const parts = [randomBytes(1024), randomBytes(1024), randomBytes(1024)];

    await sendPart(started.uploadSessionId, 3, parts[2]!);
    await sendPart(started.uploadSessionId, 1, parts[0]!);
    await sendPart(started.uploadSessionId, 2, parts[1]!);

    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/complete`,
      headers: { cookie },
    });

    const stored = await readFile(
      join(harness.storageRoot, 'r', started.recordingId, 'original.webm'),
    );
    expect(stored).toEqual(Buffer.concat(parts));
  });

  it('refuses to complete when a part is missing', async () => {
    const started = await startRecording();
    await sendPart(started.uploadSessionId, 1, randomBytes(1024));
    await sendPart(started.uploadSessionId, 3, randomBytes(1024));

    const completed = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/complete`,
      headers: { cookie },
    });

    expect(completed.statusCode).toBe(400);
    expect(completed.json().error.code).toBe('PARTS_NOT_DENSE');
  });

  it('refuses to complete an upload with no parts at all', async () => {
    const started = await startRecording();

    const completed = await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/complete`,
      headers: { cookie },
    });

    expect(completed.statusCode).toBe(400);
  });

  it('treats a repeated complete as success', async () => {
    const started = await startRecording();
    await sendPart(started.uploadSessionId, 1, randomBytes(1024));

    const url = `/v1/uploads/${started.uploadSessionId}/complete`;
    const first = await harness.app.inject({ method: 'POST', url, headers: { cookie } });
    const second = await harness.app.inject({ method: 'POST', url, headers: { cookie } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().state).toBe('ready');
  });

  it('stops accepting parts once the upload is complete', async () => {
    const started = await startRecording();
    await sendPart(started.uploadSessionId, 1, randomBytes(1024));
    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/complete`,
      headers: { cookie },
    });

    const late = await sendPart(started.uploadSessionId, 2, randomBytes(1024));

    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('UPLOAD_CLOSED');
  });

  it('reports what has landed, for a client resuming after a crash', async () => {
    const started = await startRecording();
    await sendPart(started.uploadSessionId, 1, randomBytes(1024));
    await sendPart(started.uploadSessionId, 2, randomBytes(2048));

    const state = await harness.app.inject({
      method: 'GET',
      url: `/v1/uploads/${started.uploadSessionId}`,
      headers: { cookie },
    });

    // The server's part table is the truth a recovering client reconciles against.
    expect(state.json().parts).toEqual([
      { partNumber: 1, bytes: 1024 },
      { partNumber: 2, bytes: 2048 },
    ]);
  });

  it('abandons a recording when the upload is aborted', async () => {
    const started = await startRecording();
    await sendPart(started.uploadSessionId, 1, randomBytes(1024));

    await harness.app.inject({
      method: 'POST',
      url: `/v1/uploads/${started.uploadSessionId}/abort`,
      headers: { cookie },
    });

    const recording = await harness.db.query.recordings.findFirst();
    expect(recording?.state).toBe('abandoned');

    const late = await sendPart(started.uploadSessionId, 2, randomBytes(1024));
    expect(late.statusCode).toBe(409);
  });

  describe('who can touch an upload', () => {
    it('hides one user\'s upload from another', async () => {
      const started = await startRecording();
      const other = await createUserAndLogin(harness.app, cookie, {
        email: 'other@test.local',
        password: 'other-password-1',
      });

      const peek = await harness.app.inject({
        method: 'GET',
        url: `/v1/uploads/${started.uploadSessionId}`,
        headers: { cookie: other.cookie },
      });
      const write = await sendPart(started.uploadSessionId, 1, randomBytes(64), other.cookie);

      // 404 rather than 403: a 403 would confirm the id is real.
      expect(peek.statusCode).toBe(404);
      expect(write.statusCode).toBe(404);
    });

    it('refuses anonymous callers', async () => {
      const started = await startRecording();

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/uploads/${started.uploadSessionId}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  it('will not start a recording before storage is configured', async () => {
    const fresh = await createHarness();
    try {
      const freshCookie = await login(fresh.app, TEST_ADMIN);
      const response = await fresh.app.inject({
        method: 'POST',
        url: '/v1/recordings',
        headers: { cookie: freshCookie },
        payload: { mimeType: MIME },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('NO_STORAGE_CONFIGURED');
    } finally {
      await fresh.close();
    }
  });
});
