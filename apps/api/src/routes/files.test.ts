import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storageConfigs } from '@bilby/db';

import {
  TEST_ADMIN,
  type Harness,
  configureLocalStorage,
  createHarness,
  login,
} from '../testing/harness.ts';
import { connectorFromRow } from '../storage/resolve.ts';
import { loadEnv } from '../env.ts';
import { parseRange } from './files.ts';

describe('parseRange', () => {
  it('reads a closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('reads an open-ended range as "to the end"', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('reads a suffix range as "the last N bytes"', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('falls back to the whole file for anything it cannot use', () => {
    // Multi-range is legal HTTP that no video player asks for.
    expect(parseRange('bytes=0-10,20-30', 1000)).toBeNull();
    expect(parseRange('bytes=1000-1100', 1000)).toBeNull();
    expect(parseRange('bytes=800-700', 1000)).toBeNull();
    expect(parseRange('items=0-10', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe('serving local files', () => {
  let harness: Harness;
  let cookie: string;
  let objectKey: string;
  let body: Buffer;
  let url: string;

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  });

  beforeEach(async () => {
    harness = await createHarness();
    cookie = await login(harness.app, TEST_ADMIN);
    const configId = await configureLocalStorage(harness, cookie);

    // Put a file in place through the connector, then ask it for the URL a viewer
    // would be given.
    body = randomBytes(4096);
    objectKey = 'r/test-recording/original.webm';
    const row = (
      await harness.db.select().from(storageConfigs).where(eq(storageConfigs.id, configId))
    )[0]!;
    const connector = connectorFromRow(row, env);
    const session = await connector.createUpload({ objectKey, contentType: 'video/webm' });
    const part = await connector.putPart(session, 1, body);
    await connector.completeUpload(session, [part]);

    url = (await connector.getPlaybackTarget(objectKey)).url.replace('http://localhost:3000', '');
  });

  afterEach(async () => {
    await harness.close();
  });

  it('serves the whole file to a signed request', async () => {
    const response = await harness.app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('video/webm');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.rawPayload).toEqual(body);
  });

  it('serves a byte range, which is what makes seeking work', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url,
      headers: { range: 'bytes=1000-1999' },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 1000-1999/${body.length}`);
    expect(response.headers['content-length']).toBe('1000');
    expect(response.rawPayload).toEqual(body.subarray(1000, 2000));
  });

  it('refuses a request with no signature', async () => {
    const response = await harness.app.inject({ method: 'GET', url: url.split('?')[0] });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a tampered signature', async () => {
    const tampered = url.replace(/signature=(.)/, (_m, c: string) => `signature=${c === 'a' ? 'b' : 'a'}`);
    const response = await harness.app.inject({ method: 'GET', url: tampered });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a request for a different file with the same signature', async () => {
    const swapped = url.replace('original.webm', 'somebody-elses.webm');
    const response = await harness.app.inject({ method: 'GET', url: swapped });
    // The signature covers the object key, so it cannot be moved to another file.
    expect(response.statusCode).toBe(403);
  });

  it('refuses an expired link', async () => {
    const expired = url.replace(/expires=\d+/, 'expires=1');
    const response = await harness.app.inject({ method: 'GET', url: expired });
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for a signed link to a file that does not exist', async () => {
    const row = (await harness.db.select().from(storageConfigs))[0]!;
    const connector = connectorFromRow(row, env);
    const missing = (await connector.getPlaybackTarget('r/nope/original.webm')).url.replace(
      'http://localhost:3000',
      '',
    );

    const response = await harness.app.inject({ method: 'GET', url: missing });
    expect(response.statusCode).toBe(404);
  });
});
