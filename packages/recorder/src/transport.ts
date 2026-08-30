import type { Part } from './coalescer.ts';
import type { PartStore } from './store.ts';
import type { UploadTransport } from './scheduler.ts';

export type PartTarget =
  | { mode: 'direct'; url: string; method: 'PUT' | 'POST'; headers: Record<string, string> }
  | { mode: 'proxy'; url: string };

export interface UploadApi {
  getPartTarget(sessionId: string, partNumber: number): Promise<PartTarget>;
  /** Sends the bytes through our API, for backends a browser cannot reach directly. */
  putPart(sessionId: string, partNumber: number, blob: Blob): Promise<{ etag: string }>;
  /** Confirms a part that went straight to the provider. */
  ackPart(
    sessionId: string,
    partNumber: number,
    part: { etag: string; bytes: number; sha256: string },
  ): Promise<void>;
}

export interface TransportOptions {
  api: UploadApi;
  store: PartStore;
  recordingId: string;
  sessionId: string;
  fetchImpl?: typeof fetch;
  onProgress?: (partNumber: number, bytes: number) => void;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class UploadFailed extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = 'UploadFailed';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/**
 * A 4xx that is not a timeout or a rate limit will say the same thing next time, so
 * retrying only wastes the budget a genuinely flaky part might need.
 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

/**
 * Sends one part, then releases its local copy.
 *
 * The order matters and is the whole reason the local copy exists: bytes are only
 * dropped once the server has confirmed them. Releasing first would turn a failed
 * retry into lost video.
 */
export function createTransport(options: TransportOptions): UploadTransport {
  const { api, store, recordingId, sessionId } = options;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async send(part: Part): Promise<{ bytes: number }> {
      // Read from the store rather than trusting the part in hand, so a resumed
      // upload and a fresh one take exactly the same path.
      const blob = (await store.get(recordingId, part.partNumber)) ?? part.blob;

      // Signed one part at a time, and re-signed on every attempt. A signature
      // minted an hour ago for a part that is only now being retried is expired.
      const target = await api.getPartTarget(sessionId, part.partNumber);

      if (target.mode === 'proxy') {
        await api.putPart(sessionId, part.partNumber, blob);
      } else {
        const response = await doFetch(target.url, {
          method: target.method,
          headers: target.headers,
          body: blob,
        });
        if (!response.ok) {
          throw new UploadFailed(`Storage rejected part ${part.partNumber}.`, {
            retryable: isRetryableStatus(response.status),
            status: response.status,
          });
        }

        // Without ExposeHeaders: ETag in the bucket's CORS rules the browser cannot
        // read this, and the upload cannot be completed. Saying so plainly here
        // saves a long afternoon.
        const etag = response.headers.get('etag')?.replaceAll('"', '');
        if (!etag) {
          throw new UploadFailed(
            'Storage did not return a readable ETag. The bucket CORS rules need to expose the ETag header.',
            { retryable: false },
          );
        }

        await api.ackPart(sessionId, part.partNumber, {
          etag,
          bytes: blob.size,
          sha256: await sha256Hex(blob),
        });
      }

      await store.release(recordingId, part.partNumber);
      options.onProgress?.(part.partNumber, blob.size);
      return { bytes: blob.size };
    },
  };
}
