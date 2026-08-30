import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Readable } from 'node:stream';

import { StorageError } from './errors.ts';
import type { Publisher } from './staged.ts';
import type { ByteRange, ObjectStat, PlaybackTarget } from './types.ts';

export interface CloudinaryOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Prefix for everything this instance stores, so one account can hold several. */
  folder?: string;
}

export type CloudinaryResourceType = 'video' | 'image' | 'raw';

/**
 * Cloudinary addresses assets by public id, and appends the format itself. Passing
 * a key with its extension still attached produces `original.mp4.mp4`.
 */
export function publicIdFor(objectKey: string, folder?: string): string {
  const withoutExtension = objectKey.replace(/\.[a-z0-9]{1,8}$/i, '');
  return folder ? `${folder.replace(/\/+$/, '')}/${withoutExtension}` : withoutExtension;
}

/**
 * Cloudinary keeps videos, images and everything else in separate namespaces, and
 * an asset uploaded as one cannot be read back as another.
 */
export function resourceTypeFor(contentType: string): CloudinaryResourceType {
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('image/')) return 'image';
  return 'raw';
}

/**
 * Cloudinary. Sits behind StagedConnector because it takes whole files: there is
 * no way to hand it parts of a recording that is still going.
 *
 * What it gives back in exchange is the delivery side — it can produce adaptive
 * streams and derived formats itself, so those stages never have to run here.
 */
export class CloudinaryPublisher implements Publisher {
  readonly kind = 'cloudinary' as const;

  readonly delivery = {
    signedRead: true,
    rangeRequests: true,
    // The reason to choose this backend: renditions and adaptive streaming are
    // the provider's job rather than the worker's.
    serverSideTranscode: true,
    adaptiveStreaming: true,
    maxObjectBytes: 4 * 1024 * 1024 * 1024,
  };

  private readonly options: CloudinaryOptions;

  constructor(options: CloudinaryOptions) {
    this.options = options;
  }

  /**
   * Credentials go with every call rather than into the SDK's global config. The
   * v2 client is a module singleton, so configuring it would mean two accounts on
   * one instance quietly overwriting each other.
   */
  private get credentials() {
    return {
      cloud_name: this.options.cloudName,
      api_key: this.options.apiKey,
      api_secret: this.options.apiSecret,
      secure: true,
    };
  }

  async publish(input: { localPath: string; objectKey: string; contentType: string }) {
    // upload_large is callback-shaped: it returns a stream, not a promise, and
    // chunks the file itself for anything over about a hundred megabytes.
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      cloudinary.uploader.upload_large(
        input.localPath,
        {
          ...this.credentials,
          public_id: publicIdFor(input.objectKey, this.options.folder),
          resource_type: resourceTypeFor(input.contentType),
          // Our key is already unique; letting Cloudinary rename the asset would
          // lose the only handle we have on it.
          use_filename: false,
          unique_filename: false,
          overwrite: true,
          invalidate: true,
        },
        (error, uploaded) => {
          if (error || !uploaded) reject(error ?? new Error('Cloudinary returned no result.'));
          else resolve(uploaded);
        },
      );
    });
    return { bytes: Number(result.bytes ?? 0) };
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    try {
      const resource = await cloudinary.api.resource(publicIdFor(objectKey, this.options.folder), {
        ...this.credentials,
        resource_type: this.resourceTypeForKey(objectKey),
      });
      return {
        bytes: Number(resource.bytes ?? 0),
        contentType: contentTypeFor(String(resource.resource_type), String(resource.format ?? '')),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(objectKey: string): Promise<void> {
    try {
      await cloudinary.uploader.destroy(publicIdFor(objectKey, this.options.folder), {
        ...this.credentials,
        resource_type: this.resourceTypeForKey(objectKey),
        invalidate: true,
      });
    } catch (error) {
      // Deleting something already gone is a success: callers retry, and the
      // sweeper runs more than once.
      if (!isNotFound(error)) throw error;
    }
  }

  async playbackUrl(objectKey: string, options: { ttlSeconds: number }): Promise<PlaybackTarget> {
    // Bucketed like every other backend, so repeated requests inside the window
    // produce the same URL and a cache in front of us can do its job.
    const bucket = Math.floor(Date.now() / 1000 / options.ttlSeconds);
    const expiresAtSeconds = (bucket + 2) * options.ttlSeconds;

    const url = cloudinary.url(publicIdFor(objectKey, this.options.folder), {
      ...this.credentials,
      resource_type: this.resourceTypeForKey(objectKey),
      secure: true,
      sign_url: true,
      type: 'upload',
      expires_at: expiresAtSeconds,
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
      throw new StorageError('PROVIDER_ERROR', `Cloudinary returned ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  private resourceTypeForKey(objectKey: string): CloudinaryResourceType {
    if (/\.(webp|jpe?g|png|gif|avif)$/i.test(objectKey)) return 'image';
    if (/\.(mp4|webm|mov|mkv|m4v)$/i.test(objectKey)) return 'video';
    return 'raw';
  }
}

function contentTypeFor(resourceType: string, format: string): string {
  if (resourceType === 'video') return `video/${format || 'mp4'}`;
  if (resourceType === 'image') return `image/${format || 'webp'}`;
  return 'application/octet-stream';
}

function isNotFound(error: unknown): boolean {
  const status = (error as { http_code?: number })?.http_code;
  const message = String((error as { message?: string })?.message ?? '');
  return status === 404 || /not found/i.test(message);
}
