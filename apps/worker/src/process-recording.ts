import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { type Database, mediaAssets, recordings } from '@osprey/db';
import { type StorageConnector, downloadToFile, uploadLocalFile } from '@osprey/storage';
import {
  ffmpegArgs,
  moovIsAtTheFront,
  planFor,
  posterArgs,
  posterPositionMs,
  probeFile,
  runFfmpeg,
} from '@osprey/processing';

export interface ProcessResult {
  recordingId: string;
  plan: string;
  reason: string;
  durationMs: number | null;
  producedRendition: boolean;
  producedPoster: boolean;
}

export interface ProcessDeps {
  db: Database;
  connectorFor: (storageConfigId: string) => Promise<StorageConnector>;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/** Content-addressed, so a rendition URL is immutable and can be cached forever. */
function renditionKey(recordingId: string, kind: 'mp4' | 'poster', digest: string): string {
  const extension = kind === 'mp4' ? 'mp4' : 'webp';
  return `r/${recordingId}/${kind}/${digest.slice(0, 16)}.${extension}`;
}

async function digestOf(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Turns what the browser recorded into something every browser can play.
 *
 * The recording is already watchable before this runs — that is what keeps the
 * share link instant — so this replaces it with a better rendition rather than
 * being on the path to making it available.
 */
export async function processRecording(
  recordingId: string,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const { db, connectorFor } = deps;
  const log = deps.log ?? (() => {});

  const rows = await db.select().from(recordings).where(eq(recordings.id, recordingId)).limit(1);
  const recording = rows[0];
  if (!recording) throw new Error(`No recording ${recordingId}.`);
  if (recording.deletedAt) {
    return skipped(recordingId, 'the recording was deleted');
  }

  const originals = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.recordingId, recordingId), eq(mediaAssets.kind, 'original')))
    .limit(1);
  const original = originals[0];
  if (!original) throw new Error(`Recording ${recordingId} has no original to work from.`);

  const connector = await connectorFor(recording.storageConfigId);
  const dir = await mkdtemp(join(tmpdir(), `osprey-${recordingId.slice(0, 8)}-`));

  try {
    const source = join(dir, 'source');
    await downloadToFile(connector, original.objectKey, source);

    const info = await probeFile(source);
    const head = (await readFile(source)).subarray(0, 64 * 1024);
    const recordedWith = (recording.recordedWith ?? {}) as { interrupted?: boolean };
    const plan = planFor(info, {
      moovAtFront: moovIsAtTheFront(head),
      interrupted: recordedWith.interrupted === true,
    });
    log('planned', { recordingId, plan: plan.kind, reason: plan.reason });

    let producedRendition = false;
    if (plan.kind !== 'reuse') {
      const output = join(dir, 'rendition.mp4');
      await runFfmpeg(ffmpegArgs(plan.kind, { input: source, output }));

      const stored = await uploadLocalFile(connector, {
        path: output,
        objectKey: renditionKey(recordingId, 'mp4', await digestOf(output)),
        contentType: 'video/mp4',
      });
      const rendition = await probeFile(output);

      await db
        .insert(mediaAssets)
        .values({
          recordingId,
          kind: 'mp4_source',
          objectKey: stored.objectKey,
          contentType: 'video/mp4',
          bytes: stored.bytes,
          width: rendition.width,
          height: rendition.height,
          durationMs: rendition.durationMs,
          bitrateBps: rendition.bitrateBps,
        })
        // Reprocessing the same file twice must not add a second row.
        .onConflictDoNothing();
      producedRendition = true;
    }

    // Taken from whatever will actually be played, so the still matches the video.
    const posterSource = producedRendition ? join(dir, 'rendition.mp4') : source;
    const posterPath = join(dir, 'poster.webp');
    let producedPoster = false;
    try {
      await runFfmpeg(
        posterArgs({ input: posterSource, output: posterPath, atMs: posterPositionMs(info.durationMs) }),
      );
      if ((await stat(posterPath)).size > 0) {
        const stored = await uploadLocalFile(connector, {
          path: posterPath,
          objectKey: renditionKey(recordingId, 'poster', await digestOf(posterPath)),
          contentType: 'image/webp',
        });
        await db
          .insert(mediaAssets)
          .values({
            recordingId,
            kind: 'poster',
            objectKey: stored.objectKey,
            contentType: 'image/webp',
            bytes: stored.bytes,
          })
          .onConflictDoNothing();
        producedPoster = true;
      }
    } catch (error) {
      // A missing thumbnail is a cosmetic loss. The recording still plays, so this
      // must not fail the job and send it round the retry loop again.
      log('poster failed', { recordingId, error: String(error) });
    }

    await db
      .update(recordings)
      .set({
        state: 'ready',
        durationMs: info.durationMs,
        width: info.width,
        height: info.height,
        hasAudio: info.hasAudio,
        readyAt: recording.readyAt ?? new Date(),
        failureReason: null,
      })
      .where(eq(recordings.id, recordingId));

    return {
      recordingId,
      plan: plan.kind,
      reason: plan.reason,
      durationMs: info.durationMs,
      producedRendition,
      producedPoster,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function skipped(recordingId: string, reason: string): ProcessResult {
  return {
    recordingId,
    plan: 'skipped',
    reason,
    durationMs: null,
    producedRendition: false,
    producedPoster: false,
  };
}
