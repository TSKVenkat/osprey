import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { PartRef, StorageConnector, StoredObject } from './types.ts';

/** Comfortably above the 5 MiB floor S3 imposes on every part but the last. */
const DEFAULT_PART_BYTES = 8 * 1024 * 1024;

/**
 * Uploads a file from disk through a connector.
 *
 * Used by the worker for renditions it has just produced. The file is read in parts
 * rather than loaded whole, so memory stays flat whether the recording is eight
 * megabytes or eight gigabytes.
 */
export async function uploadLocalFile(
  connector: StorageConnector,
  input: { path: string; objectKey: string; contentType: string },
): Promise<StoredObject> {
  const { size } = await stat(input.path);
  const partSize = Math.max(connector.capabilities.minPartBytes, DEFAULT_PART_BYTES);

  const session = await connector.createUpload({
    objectKey: input.objectKey,
    contentType: input.contentType,
    expectedBytes: size,
  });

  try {
    const parts: PartRef[] = [];
    let partNumber = 1;
    let buffered: Buffer[] = [];
    let bufferedBytes = 0;

    const flush = async () => {
      if (bufferedBytes === 0) return;
      parts.push(await connector.putPart(session, partNumber++, Buffer.concat(buffered)));
      buffered = [];
      bufferedBytes = 0;
    };

    for await (const chunk of createReadStream(input.path, { highWaterMark: 1024 * 1024 })) {
      buffered.push(chunk as Buffer);
      bufferedBytes += (chunk as Buffer).byteLength;
      // Held back until a part is worth sending, for the same reason the browser
      // does it: anything smaller is rejected by S3 unless it is the last one.
      if (bufferedBytes >= partSize) await flush();
    }
    await flush();

    return await connector.completeUpload(session, parts);
  } catch (error) {
    await connector.abortUpload(session).catch(() => undefined);
    throw error;
  }
}

/** Streams an object out of storage onto local disk, for ffmpeg to work on. */
export async function downloadToFile(
  connector: StorageConnector,
  objectKey: string,
  path: string,
): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(await connector.openRead(objectKey), createWriteStream(path));
}
