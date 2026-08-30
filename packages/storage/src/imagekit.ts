import ImageKit from 'imagekit';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, dirname } from 'node:path';

import { StorageError } from './errors.ts';
import type { Publisher } from './staged.ts';
import type { ByteRange, ObjectStat, PlaybackTarget } from './types.ts';

export interface ImagekitOptions {
  publicKey: string;
  privateKey: string;
  /** e.g. https://ik.imagekit.io/your-id */
  urlEndpoint: string;
  /** Prefix for everything this instance stores. */
  folder?: string;
}

/** ImageKit stores a folder and a file name, not one opaque key. */
export function pathFor(objectKey: string, folder?: string): { folder: string; fileName: string } {
  const prefix = folder ? `/${folder.replace(/^\/+|\/+$/g, '')}` : '';
  const directory = dirname(objectKey);
  return {
    folder: `${prefix}${directory === '.' ? '' : `/${directory}`}` || '/',
    fileName: basename(objectKey),
  };
}

export function filePathFor(objectKey: string, folder?: string): string {
  const { folder: directory, fileName } = pathFor(objectKey, folder);
  return `${directory === '/' ? '' : directory}/${fileName}`;
}

/**
 * ImageKit. Like Cloudinary it takes whole files, so it sits behind
 * StagedConnector.
 *
 * Its distinguishing feature is that adaptive streaming is a URL parameter:
 * manifests and renditions are produced on first request, with no pre-encoding and
 * no pipeline to run. For this backend the HLS stage is a string transformation.
 */
export class ImagekitPublisher implements Publisher {
  readonly kind = 'imagekit' as const;

  readonly delivery = {
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: true,
    adaptiveStreaming: true,
    // Measured, not assumed: the file index returns nothing for a file that was
    // just uploaded, and still returns one that was just deleted.
    immediatelyConsistent: false,
    maxObjectBytes: 2 * 1024 * 1024 * 1024,
  };

  private readonly options: ImagekitOptions;
  private readonly client: ImageKit;

  constructor(options: ImagekitOptions) {
    this.options = options;
    this.client = new ImageKit({
      publicKey: options.publicKey,
      privateKey: options.privateKey,
      urlEndpoint: options.urlEndpoint,
    });
  }

  async publish(input: { localPath: string; objectKey: string; contentType: string }) {
    const { folder, fileName } = pathFor(input.objectKey, this.options.folder);
    const result = await this.client.upload({
      file: await readFile(input.localPath),
      fileName,
      folder,
      // Our key is already unique, and a renamed file is one we can no longer find.
      useUniqueFileName: false,
      overwriteFile: true,
    });
    return { bytes: Number(result.size ?? 0) };
  }

  /**
   * ImageKit addresses everything except delivery by file id, which has to be
   * looked up.
   *
   * The folder goes in `path` and the name in `searchQuery`. `filePath` is not a
   * searchable field — asking for one is rejected outright — which is the sort of
   * thing only a real account tells you.
   */
  private async fileIdFor(objectKey: string): Promise<string | null> {
    const { folder, fileName } = pathFor(objectKey, this.options.folder);
    const found = await this.client.listFiles({
      path: folder,
      searchQuery: `name = "${fileName.replace(/"/g, '')}"`,
      limit: 1,
    });
    const first = found[0] as { fileId?: string } | undefined;
    return first?.fileId ?? null;
  }

  /**
   * The file exactly as it was uploaded.
   *
   * ImageKit is a media CDN, not object storage: by default it delivers an
   * optimised rendition, and a 14 KB MP4 comes back as 5 KB of different bytes.
   * That is the point of it for playback, and completely wrong for anything that
   * needs the original — the worker reads this to process a recording, and
   * processing a re-encode of a re-encode is not what anybody wants.
   *
   * `orig-true` also bypasses the media validation that otherwise refuses to
   * serve anything whose contents do not match its extension.
   */
  private originalUrl(objectKey: string, ttlSeconds: number): string {
    return this.client.url({
      path: filePathFor(objectKey, this.options.folder),
      transformation: [{ raw: 'orig-true' }],
      signed: true,
      expireSeconds: ttlSeconds,
    });
  }

  /**
   * Asks the CDN rather than the file index.
   *
   * The index is not up to date immediately after an upload — it returned nothing
   * for a file that had just been written — so using it here would report a
   * recording missing seconds after it was stored. Fetching the headers of the
   * original is immediate and describes the same bytes `openRead` would return.
   */
  async stat(objectKey: string): Promise<ObjectStat | null> {
    const response = await fetch(this.originalUrl(objectKey, 600), { method: 'HEAD' });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) {
      throw new StorageError('PROVIDER_ERROR', `ImageKit returned ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    return {
      bytes: Number(response.headers.get('content-length') ?? 0),
      // Taken from the key we chose rather than what the provider sniffed: it
      // reports application/octet-stream for anything it does not recognise, and
      // we already know what we stored.
      contentType: contentTypeFor(objectKey, response.headers.get('content-type')),
    };
  }

  async remove(objectKey: string): Promise<void> {
    // Deleting needs the file id, and the index that supplies it lags behind
    // uploads. Without a retry, removing a recording shortly after it was stored
    // would quietly do nothing and leave the file behind for good.
    for (let attempt = 0; attempt < 3; attempt++) {
      const fileId = await this.fileIdFor(objectKey);
      if (fileId) {
        try {
          await this.client.deleteFile(fileId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Still not indexed, or genuinely absent. Deleting what is not there is a
    // success either way, and the sweeper will come past again.
  }

  /**
   * The optimised rendition, which is what a viewer should get: ImageKit re-encodes
   * on delivery and serves something smaller than what was uploaded.
   */
  async playbackUrl(objectKey: string, options: { ttlSeconds: number }): Promise<PlaybackTarget> {
    const bucket = Math.floor(Date.now() / 1000 / options.ttlSeconds);
    const expiresAtSeconds = (bucket + 2) * options.ttlSeconds;

    const url = this.client.url({
      path: filePathFor(objectKey, this.options.folder),
      signed: true,
      expireSeconds: Math.max(1, expiresAtSeconds - Math.floor(Date.now() / 1000)),
    });

    return { url, kind: 'progressive', expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  async openRead(objectKey: string, range?: ByteRange): Promise<Readable> {
    // Deliberately not the playback URL: that one is optimised for viewing.
    const url = this.originalUrl(objectKey, 600);
    const response = await fetch(url, {
      headers: range ? { range: `bytes=${range.start}-${range.end ?? ''}` } : undefined,
    });

    if (response.status === 404) {
      throw new StorageError('NOT_FOUND', `No object at ${objectKey}.`);
    }
    if (!response.ok || !response.body) {
      throw new StorageError('PROVIDER_ERROR', `ImageKit returned ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  }
}

/**
 * Adaptive streaming without a pipeline: ImageKit builds the manifest and the
 * renditions on first request. Nothing has to be encoded in advance.
 */
export function adaptiveUrlFor(
  objectKey: string,
  options: { urlEndpoint: string; folder?: string; ladder?: string },
): string {
  const path = filePathFor(objectKey, options.folder);
  const ladder = options.ladder ?? 'sr-240_360_480_720_1080';
  return `${options.urlEndpoint.replace(/\/+$/, '')}${path}/ik-master.m3u8?tr=${ladder}`;
}

/** ImageKit reports application/octet-stream for anything it cannot identify. */
function contentTypeFor(objectKey: string, reported: string | null): string {
  if (reported && reported !== 'application/octet-stream') return reported;
  const extension = objectKey.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    webp: 'image/webp',
    jpg: 'image/jpeg',
    png: 'image/png',
    m3u8: 'application/vnd.apple.mpegurl',
  };
  return known[extension] ?? reported ?? 'application/octet-stream';
}

function isNotFound(error: unknown): boolean {
  const status =
    (error as { httpStatusCode?: number })?.httpStatusCode ??
    (error as { $ResponseMetadata?: { statusCode?: number } })?.$ResponseMetadata?.statusCode;
  const message = String((error as { message?: string })?.message ?? '');
  return status === 404 || /does not exist|not found/i.test(message);
}
