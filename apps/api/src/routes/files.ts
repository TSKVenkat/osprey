import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, storageConfigs } from '@osprey/db';
import { LocalConnector } from '@osprey/storage';

import { forbidden, notFound } from '../errors.ts';
import type { Env } from '../env.ts';
import { connectorFromRow } from '../storage/resolve.ts';

const query = z.object({
  expires: z.coerce.number().int().positive(),
  signature: z.string().min(1),
});

/**
 * Parses a single-range request header. Multi-range is legal HTTP and no video
 * player asks for it, so it is treated as a request for the whole file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // "bytes=-500" means the last 500 bytes.
  if (rawStart === '') {
    const length = Number(rawEnd);
    if (length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * Serves files for the local storage backend. Everything else hands the browser a
 * URL to the provider instead; this route exists so a self-hosted instance with no
 * object storage still gets working playback, including seeking.
 */
export function fileRoutes(app: FastifyInstance, db: Database, env: Env) {
  app.get('/files/:configId/*', async (request, reply) => {
    const { configId, '*': objectKey } = z
      .object({ configId: z.string().uuid(), '*': z.string().min(1) })
      .parse(request.params);
    const { expires, signature } = query.parse(request.query);

    const rows = await db
      .select()
      .from(storageConfigs)
      .where(eq(storageConfigs.id, configId))
      .limit(1);
    const row = rows[0];
    if (!row || row.kind !== 'local') throw notFound();

    const connector = connectorFromRow(row, env);
    if (!(connector instanceof LocalConnector)) throw notFound();
    if (!connector.verifyReadSignature(objectKey, expires, signature)) {
      throw forbidden('That link has expired.');
    }

    const info = await connector.stat(objectKey);
    if (!info) throw notFound();

    // Renditions are content-addressed, so a URL always points at the same bytes and
    // can be cached indefinitely.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    reply.header('content-type', info.contentType);
    reply.header('accept-ranges', 'bytes');

    const range = parseRange(request.headers.range, info.bytes);
    if (!range) {
      reply.header('content-length', info.bytes);
      return reply.send(await connector.openRead(objectKey));
    }

    reply.code(206);
    reply.header('content-range', `bytes ${range.start}-${range.end}/${info.bytes}`);
    reply.header('content-length', range.end - range.start + 1);
    return reply.send(await connector.openRead(objectKey, range));
  });
}
