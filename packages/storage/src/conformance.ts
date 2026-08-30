import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { StorageError } from './errors.ts';
import type { PartRef, StorageConnector } from './types.ts';

export interface ConformanceSetup {
  connector: StorageConnector;
  /** Called after every test. Removes whatever the test left behind. */
  cleanup: () => Promise<void>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * One suite, run against every connector. It is what makes "pluggable storage" a
 * property of the system rather than an intention: a new backend is finished when
 * this passes against it, and the declared capabilities are checked against what the
 * backend actually did.
 */
export function runConformanceSuite(name: string, setup: () => Promise<ConformanceSetup>): void {
  describe(`storage conformance: ${name}`, () => {
    async function withConnector<T>(
      body: (connector: StorageConnector) => Promise<T>,
    ): Promise<T> {
      const { connector, cleanup } = await setup();
      try {
        return await body(connector);
      } finally {
        await cleanup();
      }
    }

    /** Big enough to be a legal part for this backend; 5 MiB on S3, tiny on local. */
    function partSize(connector: StorageConnector): number {
      return Math.max(connector.capabilities.minPartBytes, 4096);
    }

    async function upload(
      connector: StorageConnector,
      objectKey: string,
      parts: Buffer[],
      contentType = 'video/mp4',
    ): Promise<PartRef[]> {
      const session = await connector.createUpload({ objectKey, contentType });
      const refs: PartRef[] = [];
      for (const [index, body] of parts.entries()) {
        refs.push(await connector.putPart(session, index + 1, body));
      }
      await connector.completeUpload(session, refs);
      return refs;
    }

    it('round-trips a single-part object', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/single.mp4`;
        const body = randomBytes(partSize(connector));

        await upload(connector, key, [body]);

        const info = await connector.stat(key);
        expect(info?.bytes).toBe(body.byteLength);
        expect(info?.contentType).toBe('video/mp4');
        expect(await readAll(await connector.openRead(key))).toEqual(body);
      });
    });

    it('reassembles a multipart upload byte-identically', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/multi.mp4`;
        const size = partSize(connector);
        // The last part is deliberately short: every backend allows that, and only
        // that, below the minimum part size.
        const parts = [randomBytes(size), randomBytes(size), randomBytes(1024)];

        await upload(connector, key, parts);

        expect(await readAll(await connector.openRead(key))).toEqual(Buffer.concat(parts));
      });
    });

    it('is idempotent when the same part is sent twice', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/retry.mp4`;
        const body = randomBytes(partSize(connector));
        const session = await connector.createUpload({ objectKey: key, contentType: 'video/mp4' });

        const first = await connector.putPart(session, 1, body);
        const second = await connector.putPart(session, 1, body);
        expect(second.etag).toBe(first.etag);

        await connector.completeUpload(session, [second]);
        expect(await readAll(await connector.openRead(key))).toEqual(body);
      });
    });

    it('serves a byte range matching the same slice of the source', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/range.mp4`;
        const body = randomBytes(partSize(connector));
        await upload(connector, key, [body]);

        // Inclusive end, following HTTP range semantics.
        const slice = await readAll(await connector.openRead(key, { start: 100, end: 199 }));
        expect(slice).toEqual(body.subarray(100, 200));

        const tail = await readAll(await connector.openRead(key, { start: body.length - 10 }));
        expect(tail).toEqual(body.subarray(body.length - 10));
      });
    });

    it('leaves nothing behind when an upload is aborted', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/abandoned.mp4`;
        const session = await connector.createUpload({ objectKey: key, contentType: 'video/mp4' });
        await connector.putPart(session, 1, randomBytes(partSize(connector)));

        await connector.abortUpload(session);

        expect(await connector.stat(key)).toBeNull();
      });
    });

    it('returns null from stat for a key that does not exist', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/nope.mp4`;
        expect(await connector.stat(key)).toBeNull();
      });
    });

    it('treats deleting a missing object as success', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/gone.mp4`;
        await expect(connector.delete(key)).resolves.toBeUndefined();

        await upload(connector, key, [randomBytes(partSize(connector))]);
        await connector.delete(key);
        await connector.delete(key);
        expect(await connector.stat(key)).toBeNull();
      });
    });

    it('rejects object keys that try to escape the storage root', async () => {
      await withConnector(async (connector) => {
        for (const key of ['../escape.mp4', 'a/../../escape.mp4', '/absolute.mp4', 'trailing/']) {
          await expect(connector.stat(key)).rejects.toBeInstanceOf(StorageError);
        }
      });
    });

    it('refuses to complete an upload whose parts have gaps', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/gappy.mp4`;
        const session = await connector.createUpload({ objectKey: key, contentType: 'video/mp4' });
        const part = await connector.putPart(session, 2, randomBytes(partSize(connector)));

        await expect(connector.completeUpload(session, [part])).rejects.toMatchObject({
          code: 'PARTS_NOT_DENSE',
        });
      });
    });

    it('returns a playback target that expires at least a full TTL out', async () => {
      await withConnector(async (connector) => {
        const key = `conformance/${randomBytes(8).toString('hex')}/play.mp4`;
        await upload(connector, key, [randomBytes(partSize(connector))]);

        const ttlSeconds = 3600;
        const target = await connector.getPlaybackTarget(key, { ttlSeconds });

        expect(target.url).toMatch(/^https?:\/\//);
        expect(target.kind).toBe('progressive');
        // TTL bucketing signs two buckets ahead, so even a URL minted at the very end
        // of a bucket is good for a full TTL rather than expiring a second later.
        expect(target.expiresAt!.getTime() - Date.now()).toBeGreaterThan(ttlSeconds * 1000);
      });
    });

    it('reports capabilities that match what it actually did', async () => {
      await withConnector(async (connector) => {
        const caps = connector.capabilities;
        expect(caps.minPartBytes).toBeGreaterThan(0);
        expect(caps.maxPartBytes).toBeGreaterThanOrEqual(caps.minPartBytes);
        expect(caps.maxObjectBytes).toBeGreaterThanOrEqual(caps.maxPartBytes);

        const key = `conformance/${randomBytes(8).toString('hex')}/caps.mp4`;
        const session = await connector.createUpload({ objectKey: key, contentType: 'video/mp4' });
        const target = await connector.getPartTarget(session, 1, partSize(connector));
        // A backend claiming direct upload has to actually hand back a URL the
        // browser can use, and one that does not has to say so.
        expect(target.mode).toBe(caps.directUpload ? 'direct' : 'proxy');
        await connector.abortUpload(session);

        if (caps.signedRead) {
          const played = await connector.getPlaybackTarget(key);
          expect(played.expiresAt).toBeInstanceOf(Date);
        }
      });
    });
  });
}
