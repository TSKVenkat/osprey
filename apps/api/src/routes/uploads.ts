import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, max, sum } from 'drizzle-orm';
import { z } from 'zod';
import {
  type Database,
  mediaAssets,
  recordings,
  uploadParts,
  uploadSessions,
} from '@osprey/db';
import type { Capabilities, StorageConnector } from '@osprey/storage';

import { AppError, badRequest, conflict, notFound } from '../errors.ts';
import { requireAuth, requireOwnerOrAdmin } from '../auth/guards.ts';
import type { Env } from '../env.ts';
import { connectorById, defaultConnector } from '../storage/resolve.ts';

/**
 * Eight MiB sits comfortably above the 5 MiB floor S3 imposes on every part but the
 * last, and is about eight seconds of 1080p screen capture — long enough that the
 * request overhead is irrelevant, short enough that a failed part is cheap to redo.
 */
const TARGET_PART_BYTES = 8 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
};

const createRecordingBody = z.object({
  title: z.string().min(1).max(300).optional(),
  mimeType: z.string().min(1).max(200),
  expectedBytes: z.number().int().positive().optional(),
  recordedWith: z.record(z.unknown()).optional(),
});

const ackBody = z.object({
  etag: z.string().min(1).max(200),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const sessionParams = z.object({ id: z.string().uuid() });

const completeBody = z
  .object({
    /** Set when finishing an upload left behind by a tab that died. */
    interrupted: z.boolean().optional(),
  })
  .optional();
const partParams = z.object({
  id: z.string().uuid(),
  // 10 000 is the S3 ceiling and the practical ceiling everywhere else.
  partNumber: z.coerce.number().int().min(1).max(10_000),
});

/** The container is chosen by the browser, so the extension follows what it sent. */
function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.split(';')[0]!.trim()] ?? 'bin';
}

export function partSizeFor(capabilities: Capabilities): number {
  let size = Math.min(Math.max(TARGET_PART_BYTES, capabilities.minPartBytes), capabilities.maxPartBytes);
  // Google Drive rejects a chunk that is not a multiple of 256 KiB.
  if (capabilities.partAlignmentBytes) {
    size = Math.floor(size / capabilities.partAlignmentBytes) * capabilities.partAlignmentBytes;
  }
  return size;
}

export function uploadRoutes(
  app: FastifyInstance,
  db: Database,
  env: Env,
  enqueueProcessing?: (recordingId: string) => Promise<void>,
) {
  /**
   * Loads a session along with the recording it belongs to, and checks the caller
   * owns it. Every route below starts here.
   */
  async function loadSession(sessionId: string, user: Parameters<typeof requireOwnerOrAdmin>[0]) {
    const rows = await db
      .select({ session: uploadSessions, recording: recordings })
      .from(uploadSessions)
      .innerJoin(recordings, eq(recordings.id, uploadSessions.recordingId))
      .where(eq(uploadSessions.id, sessionId))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound('That upload no longer exists.');
    requireOwnerOrAdmin(user, row.recording.ownerId);
    return row;
  }

  async function connectorFor(storageConfigId: string): Promise<StorageConnector> {
    return connectorById(db, env, storageConfigId);
  }

  app.post('/v1/recordings', { preHandler: requireAuth }, async (request, reply) => {
    const body = createRecordingBody.parse(request.body);
    const { id: storageConfigId, connector } = await defaultConnector(db, env);

    const recording = (
      await db
        .insert(recordings)
        .values({
          ownerId: request.user!.id,
          storageConfigId,
          title: body.title ?? 'Untitled recording',
          state: 'uploading',
          sourceMime: body.mimeType,
          recordedWith: body.recordedWith ?? null,
        })
        .returning()
    )[0]!;

    const objectKey = `r/${recording.id}/original.${extensionFor(body.mimeType)}`;
    let providerSession;
    try {
      providerSession = await connector.createUpload({
        objectKey,
        contentType: body.mimeType,
        expectedBytes: body.expectedBytes,
      });
    } catch (error) {
      // Storage being unreachable is a configuration problem, not a bug, and the
      // person hitting it can usually fix it — but only if they are told what the
      // provider said instead of "something went wrong".
      request.log.error({ err: error, storageConfigId }, 'storage rejected a new upload');
      await db.update(recordings).set({ state: 'failed' }).where(eq(recordings.id, recording.id));
      throw new AppError(
        503,
        'STORAGE_UNAVAILABLE',
        `Storage is not accepting uploads: ${describeStorageFailure(error)}`,
        { retryable: true },
      );
    }

    const session = (
      await db
        .insert(uploadSessions)
        .values({
          recordingId: recording.id,
          storageConfigId,
          providerRef: providerSession.providerRef,
          objectKey,
          contentType: body.mimeType,
          partSize: partSizeFor(connector.capabilities),
          expiresAt: providerSession.expiresAt,
        })
        .returning()
    )[0]!;

    return reply.code(201).send({
      recordingId: recording.id,
      uploadSessionId: session.id,
      partSize: session.partSize,
      // The client reads these to decide how many parts to send at once and whether
      // it may talk to the provider directly.
      capabilities: connector.capabilities,
    });
  });

  /**
   * One part, signed on demand. Signing every part when the session is created looks
   * like a saving right up until a slow upload outlives the signatures for its later
   * parts and starts failing halfway through.
   */
  app.post('/v1/uploads/:id/parts/:partNumber/target', { preHandler: requireAuth }, async (request) => {
    const { id, partNumber } = partParams.parse(request.params);
    const { session } = await loadSession(id, request.user);
    if (session.state !== 'uploading') {
      throw conflict('UPLOAD_CLOSED', 'This upload is no longer accepting parts.');
    }

    const connector = await connectorFor(session.storageConfigId);
    const target = await connector.getPartTarget(
      {
        providerRef: session.providerRef,
        objectKey: session.objectKey,
        contentType: session.contentType,
        expiresAt: session.expiresAt,
      },
      partNumber,
      session.partSize,
    );

    if (target.mode === 'proxy') {
      return { mode: 'proxy', url: `/v1/uploads/${id}/parts/${partNumber}` };
    }
    return target;
  });

  /**
   * The proxy transport, for backends the browser cannot upload to directly. Bytes
   * pass through this process, so the route carries its own body limit rather than
   * the small one the rest of the API uses.
   */
  app.put(
    '/v1/uploads/:id/parts/:partNumber',
    {
      preHandler: requireAuth,
      bodyLimit: 64 * 1024 * 1024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { id, partNumber } = partParams.parse(request.params);
      const { session } = await loadSession(id, request.user);
      if (session.state !== 'uploading') {
        throw conflict('UPLOAD_CLOSED', 'This upload is no longer accepting parts.');
      }

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        throw badRequest('EMPTY_PART', 'A part must have a body.');
      }

      const connector = await connectorFor(session.storageConfigId);
      const part = await connector.putPart(
        {
          providerRef: session.providerRef,
          objectKey: session.objectKey,
          contentType: session.contentType,
          expiresAt: session.expiresAt,
        },
        partNumber,
        body,
      );

      // Acknowledged here too, so the proxy path is a single round trip instead of
      // an upload followed by a separate ack.
      const sha256 = createHash('sha256').update(body).digest('hex');
      await recordPart(db, id, partNumber, { ...part, sha256 });
      return { partNumber, etag: part.etag, bytes: part.bytes, sha256 };
    },
  );

  /** Used by the direct path, where the browser talks to the provider itself. */
  app.post('/v1/uploads/:id/parts/:partNumber/ack', { preHandler: requireAuth }, async (request) => {
    const { id, partNumber } = partParams.parse(request.params);
    const body = ackBody.parse(request.body);
    const { session } = await loadSession(id, request.user);
    if (session.state !== 'uploading') {
      throw conflict('UPLOAD_CLOSED', 'This upload is no longer accepting parts.');
    }

    const stored = await recordPart(db, id, partNumber, body);
    return { partNumber, etag: stored.etag, bytes: stored.bytes };
  });

  app.post('/v1/uploads/:id/complete', { preHandler: requireAuth }, async (request) => {
    const { id } = sessionParams.parse(request.params);
    const body = completeBody.parse(request.body) ?? {};
    const { session, recording } = await loadSession(id, request.user);

    // Completing twice is a normal thing for a retrying client to do.
    if (session.state === 'done') {
      return { recordingId: recording.id, state: recording.state };
    }
    if (session.state !== 'uploading') {
      throw conflict('UPLOAD_CLOSED', 'This upload cannot be completed.');
    }

    const parts = await db
      .select()
      .from(uploadParts)
      .where(eq(uploadParts.sessionId, id))
      .orderBy(uploadParts.partNumber);

    const summary = (
      await db
        .select({ n: count(), highest: max(uploadParts.partNumber), total: sum(uploadParts.bytes) })
        .from(uploadParts)
        .where(eq(uploadParts.sessionId, id))
    )[0]!;

    // Parts must be exactly 1..n. A gap means a part was lost on the way, and
    // committing anyway would produce a file that is corrupt in the middle.
    if (summary.n === 0 || summary.n !== summary.highest) {
      throw badRequest(
        'PARTS_NOT_DENSE',
        `Expected parts 1 to ${summary.n}, but the highest received was ${summary.highest ?? 0}.`,
      );
    }

    const connector = await connectorFor(session.storageConfigId);
    const stored = await connector.completeUpload(
      {
        providerRef: session.providerRef,
        objectKey: session.objectKey,
        contentType: session.contentType,
        expiresAt: session.expiresAt,
      },
      parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag, bytes: p.bytes })),
    );

    await db.update(uploadSessions).set({ state: 'done' }).where(eq(uploadSessions.id, id));
    await db.insert(mediaAssets).values({
      recordingId: recording.id,
      kind: 'original',
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      bytes: stored.bytes,
    });

    // Ready as soon as the bytes are committed: what was recorded is playable as it
    // is. The processing stage that normalises it into a seekable MP4 comes later
    // and swaps in a better rendition without the share link ever changing.
    const updated = (
      await db
        .update(recordings)
        .set({
          state: 'ready',
          bytes: stored.bytes,
          readyAt: new Date(),
          // Remembered so processing knows to rebuild the container rather than
          // trust a file whose last fragment may be incomplete.
          recordedWith: body.interrupted
            ? { ...((recording.recordedWith ?? {}) as object), interrupted: true }
            : recording.recordedWith,
        })
        .where(eq(recordings.id, recording.id))
        .returning()
    )[0]!;

    // Queued after the row is committed, and never allowed to fail the request:
    // the recording is already playable, so a lost job costs a better rendition,
    // not the recording.
    if (enqueueProcessing) {
      await enqueueProcessing(recording.id).catch((error: unknown) =>
        request.log.error({ err: error, recordingId: recording.id }, 'could not queue processing'),
      );
    }

    return { recordingId: updated.id, state: updated.state, bytes: updated.bytes };
  });

  app.post('/v1/uploads/:id/abort', { preHandler: requireAuth }, async (request) => {
    const { id } = sessionParams.parse(request.params);
    const { session, recording } = await loadSession(id, request.user);

    if (session.state === 'uploading') {
      const connector = await connectorFor(session.storageConfigId);
      // Best effort: the provider may already have dropped it, and the sweeper will
      // catch anything left behind either way.
      await connector
        .abortUpload({
          providerRef: session.providerRef,
          objectKey: session.objectKey,
          contentType: session.contentType,
          expiresAt: session.expiresAt,
        })
        .catch((error: unknown) =>
          request.log.warn({ err: error, id }, 'abort failed at the provider'),
        );

      await db.update(uploadSessions).set({ state: 'aborted' }).where(eq(uploadSessions.id, id));
      await db
        .update(recordings)
        .set({ state: 'abandoned' })
        .where(eq(recordings.id, recording.id));
    }

    return { ok: true };
  });

  /**
   * What the client asks after a crash. The server's part table is the truth and the
   * client's local manifest is a hint, which keeps the two from disagreeing about
   * what has actually landed.
   */
  app.get('/v1/uploads/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = sessionParams.parse(request.params);
    const { session, recording } = await loadSession(id, request.user);

    const parts = await db
      .select({ partNumber: uploadParts.partNumber, bytes: uploadParts.bytes })
      .from(uploadParts)
      .where(eq(uploadParts.sessionId, id))
      .orderBy(uploadParts.partNumber);

    return {
      uploadSessionId: session.id,
      recordingId: recording.id,
      state: session.state,
      partSize: session.partSize,
      expiresAt: session.expiresAt,
      parts,
    };
  });
}

/**
 * Writes a part acknowledgement exactly once. The primary key does the work: a
 * repeated ack of the same bytes is a no-op, while the same part number arriving
 * with different bytes is corruption and has to be loud.
 */
async function recordPart(
  db: Database,
  sessionId: string,
  partNumber: number,
  part: { etag: string; bytes: number; sha256: string },
) {
  const inserted = await db
    .insert(uploadParts)
    .values({ sessionId, partNumber, etag: part.etag, bytes: part.bytes, sha256: part.sha256 })
    .onConflictDoNothing()
    .returning();

  if (inserted[0]) return inserted[0];

  const existing = (
    await db
      .select()
      .from(uploadParts)
      .where(and(eq(uploadParts.sessionId, sessionId), eq(uploadParts.partNumber, partNumber)))
      .limit(1)
  )[0]!;

  if (existing.sha256 !== part.sha256) {
    throw conflict(
      'UPLOAD_PART_MISMATCH',
      `Part ${partNumber} was already stored with different content.`,
    );
  }
  return existing;
}


/**
 * Whatever the storage backend actually said. The SDKs do not all throw Error
 * objects, so an instanceof check loses the only explanation there is.
 */
function describeStorageFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const shaped = error as { message?: unknown; code?: unknown };
  if (typeof shaped?.message === 'string') return shaped.message;
  if (shaped?.code) return String(shaped.code);
  return 'the provider gave no reason';
}
