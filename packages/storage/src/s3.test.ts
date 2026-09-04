import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { S3Connector } from './s3.ts';
import { runConformanceSuite } from './conformance.ts';

// Runs against MinIO (`pnpm up`) or any S3-compatible endpoint. Skipped rather than
// failed when there is nothing to talk to, so the suite still means something on a
// machine without Docker.
const endpoint = process.env.S3_TEST_ENDPOINT ?? process.env.S3_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET ?? process.env.S3_BUCKET;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_ACCESS_KEY;

if (endpoint && bucket && accessKeyId && secretAccessKey) {
  runConformanceSuite('s3', async () => {
    const connector = new S3Connector({
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
    });
    const written: string[] = [];
    return {
      connector,
      cleanup: async () => {
        await Promise.all(written.map((key) => connector.delete(key).catch(() => undefined)));
      },
    };
  });
} else {
  describe.skip(`storage conformance: s3 (set S3_TEST_ENDPOINT to run, run id ${randomBytes(2).toString('hex')})`, () => {});
}

describe('signing for a browser that reaches the bucket elsewhere', () => {
  it('signs browser URLs with the public endpoint and server calls with ours', async () => {
    // In containers these are two addresses for one server: the API reaches MinIO
    // on the compose network, the browser reaches it on localhost. Signing is
    // per-host, so a URL signed for one is invalid at the other.
    const connector = new S3Connector({
      bucket: 'bilby',
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });

    const target = await connector.getPartTarget(
      {
        providerRef: 'upload-1',
        objectKey: 'r/abc/original.mp4',
        contentType: 'video/mp4',
        expiresAt: new Date(Date.now() + 3600_000),
      },
      1,
      1024,
    );
    const playback = await connector.getPlaybackTarget('r/abc/original.mp4');

    expect(target.mode).toBe('direct');
    if (target.mode === 'direct') expect(target.url).toContain('http://localhost:9000');
    expect(playback.url).toContain('http://localhost:9000');
  });

  it('uses the one endpoint when no public one is given', async () => {
    const connector = new S3Connector({
      bucket: 'bilby',
      endpoint: 'http://minio:9000',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });

    const playback = await connector.getPlaybackTarget('r/abc/original.mp4');
    expect(playback.url).toContain('http://minio:9000');
  });
});
