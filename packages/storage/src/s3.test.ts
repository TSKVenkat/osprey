import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';

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
