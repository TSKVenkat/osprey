/**
 * A part, ready to be uploaded. Part numbers start at 1 because that is what S3
 * expects and there is no reason for the two to disagree.
 */
export interface Part {
  partNumber: number;
  blob: Blob;
  bytes: number;
  isLast: boolean;
}

/**
 * MediaRecorder hands us a chunk every few seconds — around a megabyte at 1080p —
 * but S3 will not accept a part below 5 MiB unless it is the last one. So chunks
 * are accumulated until they are worth sending.
 *
 * Blobs are combined by reference, so nothing is copied and the recording never
 * lands on the JavaScript heap.
 */
export class ChunkCoalescer {
  private buffer: Blob[] = [];
  private bufferedBytes = 0;
  private nextPartNumber = 1;
  private flushed = false;

  private readonly targetBytes: number;

  constructor(targetBytes: number) {
    if (targetBytes <= 0) throw new Error('Target part size must be positive.');
    this.targetBytes = targetBytes;
  }

  get pendingBytes(): number {
    return this.bufferedBytes;
  }

  /**
   * What is buffered but not yet a whole part.
   *
   * A recording is only durable in whole parts unless this is written to disk too:
   * at eight megabytes a part, a low-bitrate capture can run for many minutes with
   * nothing spilled at all, and a crash would take the lot.
   */
  get pending(): Blob | null {
    return this.bufferedBytes > 0 ? new Blob(this.buffer) : null;
  }

  /**
   * Adds a chunk and returns any parts it completed. A single very large chunk can
   * complete more than one, which is why this returns an array.
   */
  push(chunk: Blob): Part[] {
    if (this.flushed) throw new Error('Cannot push after flush.');
    if (chunk.size === 0) return [];

    this.buffer.push(chunk);
    this.bufferedBytes += chunk.size;

    const parts: Part[] = [];
    while (this.bufferedBytes >= this.targetBytes) {
      parts.push(this.take(this.targetBytes, false));
    }
    return parts;
  }

  /**
   * Called once, when recording stops. The final part is whatever is left, and it
   * is the only one allowed to be under the target size.
   */
  flush(): Part | null {
    if (this.flushed) throw new Error('Already flushed.');
    this.flushed = true;
    if (this.bufferedBytes === 0) return null;
    return this.take(this.bufferedBytes, true);
  }

  private take(bytes: number, isLast: boolean): Part {
    const combined = new Blob(this.buffer);
    const blob = bytes >= combined.size ? combined : combined.slice(0, bytes);
    const remainder = bytes >= combined.size ? null : combined.slice(bytes);

    this.buffer = remainder ? [remainder] : [];
    this.bufferedBytes = remainder ? remainder.size : 0;

    return { partNumber: this.nextPartNumber++, blob, bytes: blob.size, isLast };
  }
}
