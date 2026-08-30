import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

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

export interface S3ConnectorOptions {
  bucket: string;
  region?: string;
  /** Set for MinIO, R2, B2 and anything else that is S3-compatible but not S3. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO needs path-style addressing; real S3 does not. */
  forcePathStyle?: boolean;
}

const FIVE_MIB = 5 * 1024 * 1024;

/**
 * S3 and everything that speaks its API: MinIO, Cloudflare R2, Backblaze B2, Wasabi.
 * The reference backend, and the only one that does true parallel multipart.
 */
export class S3Connector implements StorageConnector {
  readonly kind = 's3' as const;

  readonly capabilities: Capabilities = {
    directUpload: true,
    multipart: true,
    resumable: true,
    signedRead: true,
    rangeRequests: true,
    serverSideTranscode: false,
    adaptiveStreaming: false,
    immediatelyConsistent: true,
    // S3 requires every part except the last to be at least 5 MiB.
    minPartBytes: FIVE_MIB,
    maxPartBytes: 5 * 1024 * 1024 * 1024,
    // 10 000 parts is the S3 limit, which is far more than any recording needs.
    maxObjectBytes: 5 * 1024 * 1024 * 1024 * 1024,
  };

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3ConnectorOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region ?? 'us-east-1',
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async createUpload(input: {
    objectKey: string;
    contentType: string;
  }): Promise<UploadSession> {
    assertSafeKey(input.objectKey);
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
    );
    if (!result.UploadId) {
      throw new StorageError('PROVIDER_ERROR', 'S3 did not return an upload id.', {
        retryable: true,
      });
    }
    return {
      providerRef: result.UploadId,
      objectKey: input.objectKey,
      contentType: input.contentType,
      // S3 multipart uploads do not expire on their own; this is our own deadline,
      // after which the sweeper aborts them.
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  async getPartTarget(
    session: UploadSession,
    partNumber: number,
    _byteLength: number,
  ): Promise<UploadTarget> {
    const ttlSeconds = 3600;
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: session.objectKey,
        UploadId: session.providerRef,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
    return {
      mode: 'direct',
      url,
      method: 'PUT',
      headers: {},
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async putPart(session: UploadSession, partNumber: number, body: Buffer): Promise<PartRef> {
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: session.objectKey,
        UploadId: session.providerRef,
        PartNumber: partNumber,
        Body: body,
      }),
    );
    return {
      partNumber,
      etag: normalizeEtag(result.ETag),
      bytes: body.byteLength,
    };
  }

  async completeUpload(session: UploadSession, parts: PartRef[]): Promise<StoredObject> {
    assertDenseParts(parts);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: session.objectKey,
        UploadId: session.providerRef,
        MultipartUpload: {
          // S3 requires ascending part numbers, and quoted ETags exactly as it gave
          // them back to us.
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: `"${normalizeEtag(p.etag)}"` })),
        },
      }),
    );

    const info = await this.stat(session.objectKey);
    return {
      objectKey: session.objectKey,
      bytes: info?.bytes ?? parts.reduce((sum, p) => sum + p.bytes, 0),
      contentType: info?.contentType ?? session.contentType,
    };
  }

  async abortUpload(session: UploadSession): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: session.objectKey,
        UploadId: session.providerRef,
      }),
    );
  }

  async getPlaybackTarget(
    objectKey: string,
    options: { ttlSeconds?: number } = {},
  ): Promise<PlaybackTarget> {
    assertSafeKey(objectKey);
    const ttl = options.ttlSeconds ?? 3600;
    // Bucketed for the same reason as the local connector: a URL that changes on
    // every request cannot be cached by anything in front of us.
    const bucket = Math.floor(Date.now() / 1000 / ttl);
    const expiresAtSeconds = (bucket + 2) * ttl;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: Math.max(1, expiresAtSeconds - Math.floor(Date.now() / 1000)) },
    );
    return { url, kind: 'progressive', expiresAt: new Date(expiresAtSeconds * 1000) };
  }

  async stat(objectKey: string): Promise<ObjectStat | null> {
    assertSafeKey(objectKey);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return {
        bytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    assertSafeKey(objectKey);
    // S3 deletes are already idempotent: removing a missing key succeeds.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async openRead(objectKey: string, range?: ByteRange): Promise<Readable> {
    assertSafeKey(objectKey);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
        }),
      );
      return result.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageError('NOT_FOUND', `No object at ${objectKey}.`);
      }
      throw error;
    }
  }
}

/**
 * MinIO and S3 both quote ETags, and multipart ETags carry a `-partCount` suffix.
 * Storing them unquoted keeps comparisons working across backends.
 */
function normalizeEtag(etag: string | undefined): string {
  return (etag ?? '').replaceAll('"', '');
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
