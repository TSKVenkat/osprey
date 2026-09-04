import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StagedConnector, type Publisher } from './staged.ts';
import { runConformanceSuite } from './conformance.ts';

/**
 * Stands in for Cloudinary or ImageKit: a provider that only takes whole files.
 * The staging machinery is the part worth testing, and it is identical whichever
 * provider sits behind it.
 */
class FakePublisher implements Publisher {
  readonly kind = 'cloudinary' as const;
  readonly delivery = {
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: true,
    adaptiveStreaming: true,
    immediatelyConsistent: true,
    maxObjectBytes: 10 * 1024 * 1024 * 1024,
  };

  readonly files = new Map<string, { bytes: Buffer; contentType: string }>();
  publishCount = 0;

  async publish(input: { localPath: string; objectKey: string; contentType: string }) {
    this.publishCount++;
    const bytes = await readFile(input.localPath);
    this.files.set(input.objectKey, { bytes, contentType: input.contentType });
    return { bytes: bytes.byteLength };
  }

  async stat(objectKey: string) {
    const file = this.files.get(objectKey);
    return file ? { bytes: file.bytes.byteLength, contentType: file.contentType } : null;
  }

  async remove(objectKey: string) {
    this.files.delete(objectKey);
  }

  async playbackUrl(objectKey: string, options: { ttlSeconds: number }) {
    const bucket = Math.floor(Date.now() / 1000 / options.ttlSeconds);
    const expiresAtSeconds = (bucket + 2) * options.ttlSeconds;
    return {
      url: `https://cdn.example.test/${objectKey}?expires=${expiresAtSeconds}`,
      kind: 'progressive' as const,
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  async openRead(objectKey: string, range?: { start: number; end?: number }) {
    const file = this.files.get(objectKey);
    if (!file) throw new Error(`No object at ${objectKey}.`);
    const slice = range ? file.bytes.subarray(range.start, (range.end ?? file.bytes.length - 1) + 1) : file.bytes;
    return Readable.from(slice);
  }
}

runConformanceSuite('staged (whole-file provider)', async () => {
  const publisher = new FakePublisher();
  // A directory of its own, so one test cannot see another's leftovers — and the
  // same one for every connector, because sharing it is the whole point.
  const stagingRoot = await mkdtemp(join(tmpdir(), 'bilby-staged-test-'));
  const build = () => new StagedConnector({ publisher, stagingRoot });
  return {
    connector: build(),
    fresh: build,
    cleanup: async () => {
      await rm(stagingRoot, { recursive: true, force: true });
    },
  };
});

describe('staging behaviour', () => {
  let stagingRoot: string;

  beforeEach(async () => {
    stagingRoot = await mkdtemp(join(tmpdir(), 'bilby-staged-test-'));
  });

  afterEach(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
  });

  function make() {
    const publisher = new FakePublisher();
    return { publisher, connector: new StagedConnector({ publisher, stagingRoot }) };
  }

  it('uses one staging area by default, not a fresh one per connector', async () => {
    // The bug this guards against lived in the default: every other test passes an
    // explicit directory, so none of them would have noticed. The API builds a
    // connector per request, so a default of "a new temp directory" means each
    // part lands somewhere nobody else looks and the upload completes empty.
    const publisher = new FakePublisher();
    const build = () => new StagedConnector({ publisher });
    const objectKey = `r/default-staging-${Date.now()}/original.mp4`;

    try {
      const session = await build().createUpload({ objectKey, contentType: 'video/mp4' });
      const part = await build().putPart(session, 1, Buffer.alloc(1024, 3));
      await build().completeUpload(session, [part]);

      expect(publisher.files.get(objectKey)?.bytes.byteLength).toBe(1024);
    } finally {
      // Written under the shared default, so it is tidied explicitly.
      await build().abortUpload({
        providerRef: objectKey,
        objectKey,
        contentType: 'video/mp4',
        expiresAt: new Date(),
      });
    }
  });

  it('shares its staging area with every connector built for it', async () => {
    // The API builds a connector per request, so the parts of one upload arrive
    // through different instances. A staging directory chosen per instance means
    // each part lands somewhere nobody else looks, and the upload completes empty.
    const publisher = new FakePublisher();
    const build = () => new StagedConnector({ publisher, stagingRoot });

    const session = await build().createUpload({
      objectKey: 'r/rebuilt/original.mp4',
      contentType: 'video/mp4',
    });
    const part = await build().putPart(session, 1, Buffer.alloc(2048, 5));
    await build().completeUpload(session, [part]);

    expect(publisher.files.get('r/rebuilt/original.mp4')?.bytes.byteLength).toBe(2048);
  });

  it('sends the provider one file, not one per part', async () => {
    const { publisher, connector } = make();
    const session = await connector.createUpload({
      objectKey: 'r/1/original.mp4',
      contentType: 'video/mp4',
    });

    const parts = [];
    for (let n = 1; n <= 4; n++) {
      parts.push(await connector.putPart(session, n, Buffer.alloc(1024, n)));
    }
    await connector.completeUpload(session, parts);

    // These providers have no concept of a part, so they must see exactly one
    // upload however many pieces the browser sent.
    expect(publisher.publishCount).toBe(1);
    expect(publisher.files.get('r/1/original.mp4')?.bytes.byteLength).toBe(4096);
  });

  it('says plainly that a browser cannot upload straight to it', async () => {
    const { connector } = make();
    expect(connector.capabilities.directUpload).toBe(false);
    // Parts still arrive in parallel; they just land in staging first.
    expect(connector.capabilities.multipart).toBe(true);
  });

  it('inherits what the provider can do on delivery', async () => {
    const { connector } = make();
    expect(connector.capabilities.adaptiveStreaming).toBe(true);
    expect(connector.capabilities.serverSideTranscode).toBe(true);
  });

  it('clears the staged parts once the file has been handed over', async () => {
    const { connector } = make();
    const session = await connector.createUpload({
      objectKey: 'r/2/original.mp4',
      contentType: 'video/mp4',
    });
    const part = await connector.putPart(session, 1, Buffer.alloc(2048, 7));
    await connector.completeUpload(session, [part]);

    const leftovers = await connector.listAbandonedStaging();
    expect(leftovers).toEqual([]);
  });

  it('clears the staged parts when the upload is abandoned', async () => {
    const { connector } = make();
    const session = await connector.createUpload({
      objectKey: 'r/3/original.mp4',
      contentType: 'video/mp4',
    });
    await connector.putPart(session, 1, Buffer.alloc(2048, 7));

    await connector.abortUpload(session);

    expect(await connector.listAbandonedStaging()).toEqual([]);
  });

  it('leaves nothing behind when the provider rejects the file', async () => {
    const publisher = new FakePublisher();
    publisher.publish = async () => {
      throw new Error('provider is unreachable');
    };
    const connector = new StagedConnector({ publisher, stagingRoot });

    const session = await connector.createUpload({
      objectKey: 'r/4/original.mp4',
      contentType: 'video/mp4',
    });
    const part = await connector.putPart(session, 1, Buffer.alloc(1024, 1));

    await expect(connector.completeUpload(session, [part])).rejects.toThrow(/unreachable/);
    // A failed publish must not leave the assembled copy or the parts sitting on
    // disk, or a busy instance fills up with recordings that never arrived.
    expect(await connector.listAbandonedStaging()).toEqual([]);
  });

  it('refuses to stage a key that climbs out of the staging area', async () => {
    const { connector } = make();
    await expect(
      connector.createUpload({ objectKey: '../escape.mp4', contentType: 'video/mp4' }),
    ).rejects.toThrow(/Object key/);
  });
});
