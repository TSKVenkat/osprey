import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, mediaAssets, recordings, storageConfigs, users } from '@osprey/db';

import { notFound } from '../errors.ts';
import { requireAuth, requireOwnerOrAdmin } from '../auth/guards.ts';
import type { Env } from '../env.ts';
import { connectorById, connectorFromRow } from '../storage/resolve.ts';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque cursor of the form "<iso timestamp>|<id>". */
  cursor: z.string().optional(),
  /** Admins only: include everyone's recordings, not just their own. */
  all: z.coerce.boolean().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const patchBody = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).nullable().optional(),
});

/**
 * Signed URLs for the posters belonging to a page of recordings.
 *
 * The worker has been making these thumbnails all along and nothing ever showed
 * them, which is why a library of recordings read as a list of filenames.
 *
 * One query for the whole page and one connector per storage configuration rather
 * than per recording: signing is local arithmetic, but building a connector
 * decrypts credentials, and doing that twenty-five times to render one screen is
 * work nobody asked for.
 */
async function postersFor(
  db: Database,
  env: Env,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      recordingId: mediaAssets.recordingId,
      objectKey: mediaAssets.objectKey,
      providerUrl: mediaAssets.providerUrl,
      storage: storageConfigs,
    })
    .from(mediaAssets)
    .innerJoin(recordings, eq(recordings.id, mediaAssets.recordingId))
    .innerJoin(storageConfigs, eq(storageConfigs.id, recordings.storageConfigId))
    .where(and(eq(mediaAssets.kind, 'poster'), inArray(mediaAssets.recordingId, ids)));

  const connectors = new Map<string, ReturnType<typeof connectorFromRow>>();
  const posters = new Map<string, string>();

  for (const row of rows) {
    if (row.providerUrl) {
      posters.set(row.recordingId, row.providerUrl);
      continue;
    }
    let connector = connectors.get(row.storage.id);
    if (!connector) {
      connector = connectorFromRow(row.storage, env);
      connectors.set(row.storage.id, connector);
    }
    // A thumbnail is not worth failing a page load over. If one cannot be signed,
    // the card falls back to its placeholder.
    try {
      posters.set(row.recordingId, (await connector.getPlaybackTarget(row.objectKey)).url);
    } catch {
      continue;
    }
  }

  return posters;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [timestamp, id] = cursor.split('|');
  if (!timestamp || !id) return null;
  const createdAt = new Date(timestamp);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

export function recordingRoutes(app: FastifyInstance, db: Database, env: Env) {
  app.get('/v1/recordings', { preHandler: requireAuth }, async (request) => {
    const query = listQuery.parse(request.query);
    const user = request.user!;
    const showEverything = query.all === true && user.role === 'admin';

    const filters = [isNull(recordings.deletedAt)];
    if (!showEverything) filters.push(eq(recordings.ownerId, user.id));

    // Keyset, not OFFSET. With OFFSET the database walks and discards every row it
    // skips, so page fifty costs fifty pages of work; this stays flat forever.
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor) {
      filters.push(
        or(
          lt(recordings.createdAt, cursor.createdAt),
          and(eq(recordings.createdAt, cursor.createdAt), lt(recordings.id, cursor.id)),
        )!,
      );
    }

    const rows = await db
      .select({
        id: recordings.id,
        title: recordings.title,
        state: recordings.state,
        durationMs: recordings.durationMs,
        bytes: recordings.bytes,
        createdAt: recordings.createdAt,
        readyAt: recordings.readyAt,
        ownerId: recordings.ownerId,
        ownerName: users.name,
      })
      .from(recordings)
      .innerJoin(users, eq(users.id, recordings.ownerId))
      .where(and(...filters))
      // The id breaks ties so two recordings created in the same millisecond cannot
      // hide each other at a page boundary.
      .orderBy(desc(recordings.createdAt), desc(recordings.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const posters = await postersFor(db, env, page.map((row) => row.id));

    return {
      recordings: page.map((row) => ({ ...row, posterUrl: posters.get(row.id) ?? null })),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    };
  });

  app.get('/v1/recordings/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParams.parse(request.params);

    const rows = await db
      .select({ recording: recordings, ownerName: users.name })
      .from(recordings)
      .innerJoin(users, eq(users.id, recordings.ownerId))
      .where(and(eq(recordings.id, id), isNull(recordings.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('No such recording.');
    requireOwnerOrAdmin(request.user, row.recording.ownerId);

    const assets = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.recordingId, id));

    // Prefer a normalised rendition when one exists, and fall back to what was
    // recorded. That fallback is what lets a share link work the moment the upload
    // finishes rather than waiting on processing.
    const playable = assets.find((a) => a.kind === 'mp4_source') ?? assets.find((a) => a.kind === 'original');
    const poster = assets.find((a) => a.kind === 'poster');

    let playback = null;
    if (playable) {
      const connector = await connectorById(db, env, row.recording.storageConfigId);
      playback = playable.providerUrl
        ? { url: playable.providerUrl, kind: 'progressive' as const }
        : await connector.getPlaybackTarget(playable.objectKey);
    }

    // The poster doubles as the video element's first frame, so playback does not
    // open on a black rectangle.
    let posterUrl: string | null = null;
    if (poster) {
      posterUrl = poster.providerUrl;
      if (!posterUrl) {
        const connector = await connectorById(db, env, row.recording.storageConfigId);
        posterUrl = await connector
          .getPlaybackTarget(poster.objectKey)
          .then((target) => target.url)
          .catch(() => null);
      }
    }

    return {
      recording: { ...row.recording, ownerName: row.ownerName },
      assets: assets.map((a) => ({ kind: a.kind, bytes: a.bytes, contentType: a.contentType })),
      playback,
      posterUrl,
    };
  });

  app.patch('/v1/recordings/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body);

    const existing = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    const recording = existing[0];
    if (!recording || recording.deletedAt) throw notFound('No such recording.');
    requireOwnerOrAdmin(request.user, recording.ownerId);

    const updated = await db
      .update(recordings)
      .set(body)
      .where(eq(recordings.id, id))
      .returning();

    return { recording: updated[0] };
  });

  app.delete('/v1/recordings/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = idParams.parse(request.params);

    const existing = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    const recording = existing[0];
    if (!recording || recording.deletedAt) throw notFound('No such recording.');
    requireOwnerOrAdmin(request.user, recording.ownerId);

    // Marked deleted rather than removed. The stored objects are cleaned up by the
    // sweeper, which keeps a slow provider from making a delete request hang, and
    // leaves a window in which an accidental delete can still be undone.
    await db.update(recordings).set({ deletedAt: sql`now()` }).where(eq(recordings.id, id));

    return reply.code(204).send();
  });
}
