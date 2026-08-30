import type { Readable } from 'node:stream';

export type ConnectorKind = 'local' | 's3' | 'cloudinary' | 'imagekit' | 'gdrive';

/**
 * What a backend can actually do. Providers differ in ways that reach all the way out
 * to the browser, so the differences are declared here rather than discovered at
 * runtime by whichever caller hits them first.
 */
export interface Capabilities {
  /** The browser may send bytes straight to the provider with a signed target. */
  directUpload: boolean;
  /** Parts may be sent in parallel and out of order. */
  multipart: boolean;
  /** An interrupted upload can continue from where it stopped. */
  resumable: boolean;
  /** Reads can be granted with a time-limited URL. */
  signedRead: boolean;
  /** Byte-range reads work, which is what makes seeking work. */
  rangeRequests: boolean;
  /** The provider can produce renditions itself. */
  serverSideTranscode: boolean;
  /** The provider can serve HLS or DASH. */
  adaptiveStreaming: boolean;
  minPartBytes: number;
  maxPartBytes: number;
  maxObjectBytes: number;
  /** Some providers require part sizes to be a multiple of this. Google Drive: 262144. */
  partAlignmentBytes?: number;
}

export interface UploadSession {
  /** Whatever the provider gave us: an S3 upload id, a Drive session URI, and so on. */
  providerRef: string;
  objectKey: string;
  contentType: string;
  expiresAt: Date;
}

/**
 * Where the client should send one part. `direct` means straight to the provider;
 * `proxy` means through our API, for providers that cannot accept browser uploads.
 */
export type UploadTarget =
  | {
      mode: 'direct';
      url: string;
      method: 'PUT' | 'POST';
      headers: Record<string, string>;
      expiresAt: Date;
    }
  | { mode: 'proxy' };

export interface PartRef {
  partNumber: number;
  etag: string;
  bytes: number;
}

export interface StoredObject {
  objectKey: string;
  bytes: number;
  contentType: string;
}

export interface ObjectStat {
  bytes: number;
  contentType: string;
}

export interface PlaybackTarget {
  url: string;
  kind: 'progressive' | 'hls' | 'dash';
  expiresAt?: Date;
}

export interface ByteRange {
  start: number;
  /** Inclusive, following HTTP range semantics. Omit to read to the end. */
  end?: number;
}

export interface StorageConnector {
  readonly kind: ConnectorKind;
  readonly capabilities: Capabilities;

  createUpload(input: {
    objectKey: string;
    contentType: string;
    expectedBytes?: number;
  }): Promise<UploadSession>;

  /**
   * Minted one part at a time, on demand. Signing every part up front looks like a
   * saving until a slow upload outlives the signatures for its later parts.
   */
  getPartTarget(
    session: UploadSession,
    partNumber: number,
    byteLength: number,
  ): Promise<UploadTarget>;

  /** Used when bytes come through our API instead of going straight to the provider. */
  putPart(session: UploadSession, partNumber: number, body: Buffer): Promise<PartRef>;

  completeUpload(session: UploadSession, parts: PartRef[]): Promise<StoredObject>;
  abortUpload(session: UploadSession): Promise<void>;

  getPlaybackTarget(
    objectKey: string,
    options?: { ttlSeconds?: number },
  ): Promise<PlaybackTarget>;

  stat(objectKey: string): Promise<ObjectStat | null>;
  delete(objectKey: string): Promise<void>;

  /** Ranged so the worker can stream a large file to ffmpeg without holding it in memory. */
  openRead(objectKey: string, range?: ByteRange): Promise<Readable>;
}
