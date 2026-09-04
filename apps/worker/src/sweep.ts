import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  type Database,
  mediaAssets,
  recordings,
  sessions,
  uploadSessions,
} from '@bilby/db';
import type { StorageConnector } from '@bilby/storage';

export interface SweepResult {
  expiredLogins: number;
  abandonedUploads: number;
  purgedRecordings: number;
  deletedObjects: number;
  /** Recordings whose files could not be removed, left for the next run. */
  deferredRecordings: number;
}

export interface SweepDeps {
  db: Database;
  connectorFor: (storageConfigId: string) => Promise<StorageConnector>;
  /** How long a deleted recording stays recoverable before its files go. */
  retentionDays?: number;
  now?: () => Date;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Housekeeping that nothing else does.
 *
 * Two of these are the difference between a tidy instance and one that quietly
 * fills up: an upload that was never finished holds parts at the provider that are
 * invisible in a bucket listing but still billed, and a deleted recording keeps its
 * files until something goes and removes them.
 */
export async function sweep(deps: SweepDeps): Promise<SweepResult> {
  const { db, connectorFor } = deps;
  const now = deps.now?.() ?? new Date();
  const retentionDays = deps.retentionDays ?? 7;
  const log = deps.log ?? (() => {});

  const result: SweepResult = {
    expiredLogins: 0,
    abandonedUploads: 0,
    purgedRecordings: 0,
    deletedObjects: 0,
    deferredRecordings: 0,
  };

  // Expired logins. Harmless to keep, but there is no reason to.
  const expired = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({
    id: sessions.id,
  });
  result.expiredLogins = expired.length;

  // Uploads that were started and never finished. The provider is holding parts for
  // each one; aborting is what actually releases them.
  const stale = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.state, 'uploading'), lt(uploadSessions.expiresAt, now)));

  for (const session of stale) {
    try {
      const connector = await connectorFor(session.storageConfigId);
      await connector.abortUpload({
        providerRef: session.providerRef,
        objectKey: session.objectKey,
        contentType: session.contentType,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      // The provider may have dropped it already, which is the outcome we wanted.
      log('abort failed', { uploadSessionId: session.id, error: String(error) });
    }

    await db
      .update(uploadSessions)
      .set({ state: 'abandoned' })
      .where(eq(uploadSessions.id, session.id));
    await db
      .update(recordings)
      .set({ state: 'abandoned' })
      .where(and(eq(recordings.id, session.recordingId), inArray(recordings.state, ['draft', 'uploading'])));
    result.abandonedUploads++;
  }

  // Recordings deleted long enough ago that the undo window has passed.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const doomed = await db
    .select()
    .from(recordings)
    .where(and(isNotNull(recordings.deletedAt), lt(recordings.deletedAt, cutoff)));

  for (const recording of doomed) {
    const assets = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.recordingId, recording.id));

    let allRemoved = true;
    for (const asset of assets) {
      try {
        const connector = await connectorFor(recording.storageConfigId);
        await connector.delete(asset.objectKey);
        result.deletedObjects++;
      } catch (error) {
        // The row is what tells us where the file is, so it stays until the file
        // is actually gone. Better to retry next time than to orphan the object.
        allRemoved = false;
        log('object delete failed', { objectKey: asset.objectKey, error: String(error) });
      }
    }

    if (allRemoved) {
      // Assets and everything else hang off this row and go with it.
      await db.delete(recordings).where(eq(recordings.id, recording.id));
      result.purgedRecordings++;
    } else {
      result.deferredRecordings++;
    }
  }

  log('swept', { ...result });
  return result;
}

/** Uploads still in flight, for a health endpoint or a dashboard. */
export async function inFlightUploads(db: Database): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(uploadSessions)
    .where(eq(uploadSessions.state, 'uploading'));
  return Number(rows[0]?.n ?? 0);
}
