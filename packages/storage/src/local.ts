import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { StorageError } from './errors.ts';
import { assertDenseParts, assertSafeKey } from './keys.ts';
import type {
  ByteRange,
  Capabilities,
  ObjectStat,
  PartRef,
  PlaybackTarget,
  StorageConnector,
  StoredObject,
  UploadSession,
  UploadTarget,
} from './types.ts';

export interface LocalConnectorOptions {
  /** Directory everything is stored under. Nothing may be written outside it. */
  root: string;
  /** Base URL the API serves files from, e.g. http://localhost:3000/files */
  baseUrl: string;
  /** Key used to sign read URLs. */
  signingSecret: string;
}

const CONTENT_TYPE_SUFFIX = '.content-type';

/**
 * Files on local disk. This is the development default, and it doubles as the
 * reference the other connectors are compared against in the conformance suite:
 * the simplest implementation that is still correct.
 */
export class LocalConnector implements StorageConnector {
  readonly kind = 'local' as const;

  readonly capabilities: Capabilities = {
    // The browser cannot write to our disk; bytes come through the API.
    directUpload: false,
    multipart: true,
    resumable: true,
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: false,
    adaptiveStreaming: false,
    immediatelyConsistent: true,
    minPartBytes: 1,
    maxPartBytes: 512 * 1024 * 1024,
    maxObjectBytes: 32 * 1024 * 1024 * 1024,
  };

  private readonly root: string;
  private readonly baseUrl: string;
  private readonly signingSecret: string;

  constructor(options: LocalConnectorOptions) {
    this.root = resolve(options.root);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.signingSecret = options.signingSecret;
  }

  async createUpload(input: {
    objectKey: string;
    contentType: string;
    expectedBytes?: number;
  }): Promise<UploadSession> {
    assertSafeKey(input.objectKey);
    await mkdir(this.partsDir(input.objectKey), { recursive: true });
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
    if (partNumber < 1) {
      throw new StorageError('PARTS_NOT_DENSE', 'Part numbers start at 1.');
    }
    const dir = this.partsDir(session.objectKey);
    await mkdir(dir, { recursive: true });
    // Written to a temporary name first so an interrupted write cannot leave a
    // half-part that later looks complete.
    const target = join(dir, partName(partNumber));
    const temp = `${target}.tmp`;
    await writeFile(temp, body);
    await rename(temp, target);

    return {
      partNumber,
      etag: createHash('md5').update(body).digest('hex'),
      bytes: body.byteLength,
    };
  }

  async completeUpload(session: UploadSession, parts: PartRef[]): Promise<StoredObject> {
    assertSafeKey(session.objectKey);
    assertDenseParts(parts);

    const dir = this.partsDir(session.objectKey);
    const finalPath = this.pathFor(session.objectKey);
    await mkdir(dirname(finalPath), { recursive: true });

    // Streamed one part at a time, so memory stays flat whether the recording is
    // 8 MiB or 8 GiB. Reading the parts into a buffer first is the usual way this
    // breaks in production.
    const temp = `${finalPath}.assembling`;
    const out = createWriteStream(temp);
    let bytes = 0;
    try {
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        const partPath = join(dir, partName(part.partNumber));
        const info = await stat(partPath).catch(() => null);
        if (!info) {
          throw new StorageError('NOT_FOUND', `Part ${part.partNumber} is missing.`);
        }
        await pipeline(createReadStream(partPath), out, { end: false });
        bytes += info.size;
      }
      await new Promise<void>((done, fail) => {
        out.end((error?: Error | null) => (error ? fail(error) : done()));
      });
      await rename(temp, finalPath);
    } catch (error) {
      out.destroy();
      await rm(temp, { force: true });
      throw error;
    }

    await writeFile(`${finalPath}${CONTENT_TYPE_SUFFIX}`, session.contentType);
    await rm(dir, { recursive: true, force: true });

    return { objectKey: session.objectKey, bytes, contentType: session.contentType };
  }

  async abortUpload(session: UploadSession): Promise<void> {
    assertSafeKey(session.objectKey);
    await rm(this.partsDir(session.objectKey), { recursive: true, force: true });
  }

  async getPlaybackTarget(
    objectKey: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<PlaybackTarget> {
    assertSafeKey(objectKey);
    const ttl = options.ttlSeconds ?? 3600;
    // Bucketed so every request inside the same window produces a byte-identical
    // URL, which is what lets a cache in front of us do anything useful. Signed two
    // buckets ahead so a URL minted at the end of a window is still valid for a
    // full TTL afterwards.
    const bucket = Math.floor(Date.now() / 1000 / ttl);
    const expiresAtSeconds = (bucket + 2) * ttl;
    const signature = this.sign(objectKey, expiresAtSeconds);
    const url = `${this.baseUrl}/${objectKey}?expires=${expiresAtSeconds}&signature=${signature}`;
    return { url, kind: 'progressive', expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  /** Used by the API route that serves local files. */
  verifyReadSignature(objectKey: string, expiresAtSeconds: number, signature: string): boolean {
    if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(objectKey, expiresAtSeconds));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    assertSafeKey(objectKey);
    const path = this.pathFor(objectKey);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) return null;
    const contentType = await readContentType(path);
    return { bytes: info.size, contentType };
  }

  async delete(objectKey: string): Promise<void> {
    assertSafeKey(objectKey);
    const path = this.pathFor(objectKey);
    // Deleting something that is already gone is a success, not an error: callers
    // retry, and cleanup jobs run more than once.
    await unlink(path).catch(() => undefined);
    await unlink(`${path}${CONTENT_TYPE_SUFFIX}`).catch(() => undefined);
  }

  async openRead(objectKey: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(objectKey);
    const path = this.pathFor(objectKey);
    if (!(await stat(path).catch(() => null))) {
      throw new StorageError('NOT_FOUND', `No object at ${objectKey}.`);
    }
    return createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  }

  /** Parts left behind by uploads that were never completed or aborted. */
  async listAbandonedPartDirs(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = join(dir, entry.name);
        if (entry.name.endsWith('.parts')) found.push(full);
        else await walk(full);
      }
    };
    await walk(this.root);
    return found;
  }

  private sign(objectKey: string, expiresAtSeconds: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${objectKey}:${expiresAtSeconds}`)
      .digest('hex');
  }

  private pathFor(objectKey: string): string {
    const path = resolve(this.root, objectKey);
    // assertSafeKey already rejects traversal; this is the belt to its braces,
    // because a path escaping the root is the one bug here that is unrecoverable.
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new StorageError('INVALID_KEY', 'Object key resolves outside the storage root.');
    }
    return path;
  }

  private partsDir(objectKey: string): string {
    return `${this.pathFor(objectKey)}.parts`;
  }
}

function partName(partNumber: number): string {
  // Zero-padded so a plain directory listing sorts in part order.
  return String(partNumber).padStart(6, '0');
}

async function readContentType(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const value = await readFile(`${path}${CONTENT_TYPE_SUFFIX}`, 'utf8').catch(() => null);
  return value?.trim() || 'application/octet-stream';
}
