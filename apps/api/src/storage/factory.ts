import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { LocalConnector, S3Connector, type StorageConnector } from '@openloom/storage';

import { badRequest } from '../errors.ts';

/**
 * Configuration is split in two on purpose: `config` holds settings that are safe to
 * show an admin back, `secret` holds credentials that have no read path at all.
 */
export const localConfig = z.object({ root: z.string().min(1) });
export const localSecret = z.object({});

export const s3Config = z.object({
  bucket: z.string().min(1),
  region: z.string().default('us-east-1'),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
});
export const s3Secret = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

export type ConnectorKind = 'local' | 's3';

export interface ConnectorRow {
  kind: string;
  config: unknown;
  secret: unknown;
}

export interface FactoryContext {
  /** Base URL the API serves local files from. */
  localBaseUrl: string;
  /** Used to sign local read URLs. */
  signingSecret: string;
}

/**
 * Turns a stored configuration into a working connector. Cloudinary, ImageKit and
 * Drive slot in here as extra cases; nothing else in the codebase changes.
 */
export function createConnector(row: ConnectorRow, context: FactoryContext): StorageConnector {
  switch (row.kind) {
    case 'local': {
      const config = localConfig.parse(row.config);
      return new LocalConnector({
        root: config.root,
        baseUrl: context.localBaseUrl,
        signingSecret: context.signingSecret,
      });
    }
    case 's3': {
      const config = s3Config.parse(row.config);
      const secret = s3Secret.parse(row.secret);
      return new S3Connector({ ...config, ...secret });
    }
    default:
      throw badRequest('UNSUPPORTED_CONNECTOR', `Storage backend "${row.kind}" is not built yet.`);
  }
}

export function parseConnectorInput(kind: string, config: unknown, secret: unknown) {
  switch (kind) {
    case 'local':
      return { config: localConfig.parse(config), secret: localSecret.parse(secret ?? {}) };
    case 's3':
      return { config: s3Config.parse(config), secret: s3Secret.parse(secret) };
    default:
      throw badRequest('UNSUPPORTED_CONNECTOR', `Storage backend "${kind}" is not built yet.`);
  }
}

/**
 * A real round trip against the backend: write an object, read it back, read a byte
 * range out of the middle, then delete it. Capabilities are recorded from what the
 * backend actually did, because a hand-declared matrix is only ever as true as the
 * configuration behind it — a MinIO without CORS still claims it accepts browser
 * uploads right up until a user tries one.
 */
export async function testConnector(
  connector: StorageConnector,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const key = `openloom-connection-test/${randomBytes(8).toString('hex')}.bin`;
  const body = randomBytes(Math.max(connector.capabilities.minPartBytes, 1024));

  try {
    const session = await connector.createUpload({
      objectKey: key,
      contentType: 'application/octet-stream',
    });
    const part = await connector.putPart(session, 1, body);
    await connector.completeUpload(session, [part]);

    const info = await connector.stat(key);
    if (info?.bytes !== body.byteLength) {
      return { ok: false, reason: 'The object read back at a different size than it was written.' };
    }

    const stream = await connector.openRead(key, { start: 10, end: 19 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    if (!Buffer.concat(chunks).equals(body.subarray(10, 20))) {
      return { ok: false, reason: 'Byte ranges did not match, so seeking would not work.' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Unknown failure.' };
  } finally {
    await connector.delete(key).catch(() => undefined);
  }
}
