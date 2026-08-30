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

  /** ImageKit addresses everything else by file id, which has to be looked up. */
  private async fileIdFor(objectKey: string): Promise<string | null> {
    const filePath = filePathFor(objectKey, this.options.folder);
    const found = await this.client.listFiles({
      searchQuery: `filePath = "${filePath.replace(/"/g, '')}"`,
      limit: 1,
    });
    const first = found[0] as { fileId?: string } | undefined;
    return first?.fileId ?? null;
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    const fileId = await this.fileIdFor(objectKey);
    if (!fileId) return null;
    try {
      const details = (await this.client.getFileDetails(fileId)) as {
        size?: number;
        mime?: string;
      };
      return {
        bytes: Number(details.size ?? 0),
        contentType: details.mime ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    const fileId = await this.fileIdFor(objectKey);
    // Already gone is the outcome we wanted.
    if (!fileId) return;
    try {
      await this.client.deleteFile(fileId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

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
    const { url } = await this.playbackUrl(objectKey, { ttlSeconds: 600 });
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

function isNotFound(error: unknown): boolean {
  const status =
    (error as { httpStatusCode?: number })?.httpStatusCode ??
    (error as { $ResponseMetadata?: { statusCode?: number } })?.$ResponseMetadata?.statusCode;
  const message = String((error as { message?: string })?.message ?? '');
  return status === 404 || /does not exist|not found/i.test(message);
}
