import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { StorageError } from './errors.ts';
import { assertDenseParts, assertSafeKey } from './keys.ts';
import type {
  ByteRange,
  Capabilities,
  ConnectorKind,
  ObjectStat,
  PartRef,
  PlaybackTarget,
  StorageConnector,
  StoredObject,
  UploadSession,
  UploadTarget,
} from './types.ts';

/**
 * A backend that takes a whole file at once.
 *
 * Cloudinary and ImageKit both work this way: they have no concept of a part that
 * arrives while a recording is still going, and no way to accept bytes whose total
 * length is not yet known. Neither can be driven by the upload path directly.
 */
export interface Publisher {
  readonly kind: ConnectorKind;
  /** What the provider can do once a file has reached it. */
  readonly delivery: Pick<
    Capabilities,
    | 'signedRead'
    | 'rangeRequests'
    | 'serverSideTranscode'
    | 'adaptiveStreaming'
    | 'immediatelyConsistent'
    | 'maxObjectBytes'
  >;

  publish(input: {
    localPath: string;
    objectKey: string;
    contentType: string;
  }): Promise<{ bytes: number }>;

  stat(objectKey: string): Promise<ObjectStat | null>;
  remove(objectKey: string): Promise<void>;
  playbackUrl(objectKey: string, options: { ttlSeconds: number }): Promise<PlaybackTarget>;
  openRead(objectKey: string, range?: ByteRange): Promise<Readable>;
}

export interface StagedConnectorOptions {
  publisher: Publisher;
  /** Where parts wait until the recording is finished. Defaults to a temp directory. */
  stagingRoot?: string;
}

/**
 * Collects parts locally and hands the finished file to a provider that only takes
 * whole files.
 *
 * The cost is honest and worth stating: for these backends the recording is not at
 * the provider until it is complete, so time to link is bound by assembly rather
 * than by the last part. Parts still upload while recording, they just land here
 * first.
 */
export class StagedConnector implements StorageConnector {
  readonly kind: ConnectorKind;
  readonly capabilities: Capabilities;

  private readonly publisher: Publisher;
  private readonly stagingRootOption: string | undefined;
  private stagingRoot: string | null = null;

  constructor(options: StagedConnectorOptions) {
    this.publisher = options.publisher;
    this.stagingRootOption = options.stagingRoot;
    this.kind = options.publisher.kind;
    this.capabilities = {
      // Bytes go to our staging area, never straight to the provider.
      directUpload: false,
      // Parts land as separate files here, so order and parallelism do not matter.
      multipart: true,
      resumable: true,
      minPartBytes: 1,
      maxPartBytes: 512 * 1024 * 1024,
      ...options.publisher.delivery,
    };
  }

  private async staging(): Promise<string> {
    if (this.stagingRoot) return this.stagingRoot;
    this.stagingRoot = this.stagingRootOption
      ? resolve(this.stagingRootOption)
      : await mkdtemp(join(tmpdir(), 'openloom-staging-'));
    await mkdir(this.stagingRoot, { recursive: true });
    return this.stagingRoot;
  }

  private async partsDir(objectKey: string): Promise<string> {
    const root = await this.staging();
    const path = resolve(root, `${objectKey}.parts`);
    if (!path.startsWith(root + sep)) {
      throw new StorageError('INVALID_KEY', 'Object key resolves outside the staging area.');
    }
    return path;
  }

  async createUpload(input: {
    objectKey: string;
    contentType: string;
  }): Promise<UploadSession> {
    assertSafeKey(input.objectKey);
    await mkdir(await this.partsDir(input.objectKey), { recursive: true });
    return {
      providerRef: input.objectKey,
      objectKey: input.objectKey,
      contentType: input.contentType,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  async getPartTarget(): Promise<UploadTarget> {
    return { mode: 'proxy' };
  }

  async putPart(session: UploadSession, partNumber: number, body: Buffer): Promise<PartRef> {
    assertSafeKey(session.objectKey);
    if (partNumber < 1) throw new StorageError('PARTS_NOT_DENSE', 'Part numbers start at 1.');

    const dir = await this.partsDir(session.objectKey);
    await mkdir(dir, { recursive: true });
    const target = join(dir, String(partNumber).padStart(6, '0'));
    // Written under a temporary name first, so an interrupted write cannot leave a
    // half part that later looks whole.
    await writeFile(`${target}.tmp`, body);
    await rename(`${target}.tmp`, target);

    return {
      partNumber,
      etag: createHash('md5').update(body).digest('hex'),
      bytes: body.byteLength,
    };
  }

  async completeUpload(session: UploadSession, parts: PartRef[]): Promise<StoredObject> {
    assertSafeKey(session.objectKey);
    assertDenseParts(parts);

    const dir = await this.partsDir(session.objectKey);
    // Assembled files live in one flat directory named by a hash of the key, so a
    // key containing slashes cannot climb out of the staging area.
    const assembling = join(await this.staging(), '.assembling');
    await mkdir(assembling, { recursive: true });
    const assembled = join(
      assembling,
      `${createHash('sha256').update(session.objectKey).digest('hex')}.bin`,
    );

    const out = createWriteStream(assembled);
    try {
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        const partPath = join(dir, String(part.partNumber).padStart(6, '0'));
        if (!(await stat(partPath).catch(() => null))) {
          throw new StorageError('NOT_FOUND', `Part ${part.partNumber} is missing.`);
        }
        // One part at a time, so memory stays flat however long the recording is.
        await pipeline(createReadStream(partPath), out, { end: false });
      }
      await new Promise<void>((done, fail) => {
        out.end((error?: Error | null) => (error ? fail(error) : done()));
      });

      const { bytes } = await this.publisher.publish({
        localPath: assembled,
        objectKey: session.objectKey,
        contentType: session.contentType,
      });
      return { objectKey: session.objectKey, bytes, contentType: session.contentType };
    } catch (error) {
      out.destroy();
      throw error;
    } finally {
      // The provider has it now, or the upload failed. Either way the local copies
      // have done their job.
      await rm(assembled, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }

  async abortUpload(session: UploadSession): Promise<void> {
    assertSafeKey(session.objectKey);
    await rm(await this.partsDir(session.objectKey), { recursive: true, force: true });
  }

  async getPlaybackTarget(
    objectKey: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<PlaybackTarget> {
    assertSafeKey(objectKey);
    return this.publisher.playbackUrl(objectKey, { ttlSeconds: options.ttlSeconds ?? 3600 });
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    assertSafeKey(objectKey);
    return this.publisher.stat(objectKey);
  }

  async delete(objectKey: string): Promise<void> {
    assertSafeKey(objectKey);
    await this.publisher.remove(objectKey);
  }

  async openRead(objectKey: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(objectKey);
    return this.publisher.openRead(objectKey, range);
  }

  /** Staging directories left by uploads that were never completed or aborted. */
  async listAbandonedStaging(): Promise<string[]> {
    const root = await this.staging();
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const full = join(dir, entry.name);
        if (entry.name.endsWith('.parts')) found.push(full);
        else await walk(full);
      }
    };
    await walk(root);
    return found;
  }
}
