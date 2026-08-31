import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildConnector, type StorageConnector } from '@openloom/storage';

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
  // Where a browser reaches the same bucket, when that differs from where we do.
  publicEndpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
});
export const s3Secret = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});

export type ConnectorKind = 'local' | 's3' | 'cloudinary' | 'imagekit';

export const cloudinaryConfig = z.object({
  cloudName: z.string().min(1),
  folder: z.string().optional(),
});
export const cloudinarySecret = z.object({
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
});

export const imagekitConfig = z.object({
  urlEndpoint: z.string().url(),
  publicKey: z.string().min(1),
  folder: z.string().optional(),
});
export const imagekitSecret = z.object({ privateKey: z.string().min(1) });

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
  return buildConnector(
    {
      kind: row.kind,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret: (row.secret ?? {}) as Record<string, unknown>,
    },
    context,
  );
}

export function parseConnectorInput(kind: string, config: unknown, secret: unknown) {
  switch (kind) {
    case 'local':
      return { config: localConfig.parse(config), secret: localSecret.parse(secret ?? {}) };
    case 's3':
      return { config: s3Config.parse(config), secret: s3Secret.parse(secret) };
    case 'cloudinary':
      return {
        config: cloudinaryConfig.parse(config),
        secret: cloudinarySecret.parse(secret),
      };
    case 'imagekit':
      return { config: imagekitConfig.parse(config), secret: imagekitSecret.parse(secret) };
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
/**
 * How long a backend gets to prove it works before we call it broken.
 *
 * Without a limit this never returns at all for the two mistakes people actually
 * make: an endpoint that silently drops packets, where the AWS SDK retries for
 * minutes, and a root directory the process cannot reach, where the filesystem
 * call itself can block. Both left the form spinning forever with no error, which
 * is the worst of the three outcomes — worse than being told it failed.
 *
 * Generous, because a first upload to a cold provider on a slow connection is
 * genuinely not instant.
 */
const TEST_TIMEOUT_MS = 20_000;

export async function testConnector(
  connector: StorageConnector,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          ok: false,
          reason: `It did not respond within ${Math.round(timeoutMs / 1000)} seconds. Check the endpoint address and that this server can reach it.`,
        }),
      timeoutMs,
    );
    // Nothing should be kept alive by a timer that has already lost the race.
    timer.unref?.();
  });

  // The losing side keeps running to completion in the background. That is fine
  // for a test that only ever writes one small object into its own prefix, and the
  // alternative — threading an AbortSignal through every provider SDK — buys
  // nothing an administrator would notice.
  return Promise.race([runConnectorTest(connector), timeout]);
}

async function runConnectorTest(
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
    return { ok: false, reason: describeFailure(error) };
  } finally {
    await connector.delete(key).catch(() => undefined);
  }
}


/**
 * Whatever the provider actually said.
 *
 * The SDKs do not all throw Error objects — Cloudinary throws a plain object with
 * a message and an http_code — so an instanceof check quietly turns a useful
 * explanation into "Unknown failure" at exactly the moment an administrator needs
 * to know why their credentials were refused.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;

  if (error && typeof error === 'object') {
    const shaped = error as {
      message?: unknown;
      error?: { message?: unknown };
      http_code?: number;
      code?: string;
    };
    const message =
      (typeof shaped.message === 'string' && shaped.message) ||
      (typeof shaped.error?.message === 'string' && shaped.error.message);
    if (message) {
      return shaped.http_code ? `${message} (HTTP ${shaped.http_code})` : message;
    }
    if (shaped.code) return String(shaped.code);
  }

  return 'the provider refused the request without saying why';
}
