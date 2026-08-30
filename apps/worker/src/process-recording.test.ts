import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { mediaAssets, recordings, storageConfigs, users } from '@openloom/db';
import { createTestDatabase } from '@openloom/db/testing';
import { LocalConnector, uploadLocalFile } from '@openloom/storage';
import { moovIsAtTheFront, probeFile } from '@openloom/processing';

import { processRecording } from './process-recording.ts';

const exec = promisify(execFile);

/**
 * The processing stage as the worker actually runs it: a real recording in real
 * storage, a real ffmpeg, and a real database underneath.
 */
describe('processRecording', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>['db'];
  let closeDb: () => Promise<void>;
  let root: string;
  let connector: LocalConnector;
  let storageConfigId: string;
  let ownerId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    db = created.db;
    closeDb = created.close;
    root = await mkdtemp(join(tmpdir(), 'openloom-worker-'));
    connector = new LocalConnector({
      root,
      baseUrl: 'http://localhost:3000/files/test',
      signingSecret: 'test-secret',
    });

    ownerId = (
      await db
        .insert(users)
        .values({ email: 'owner@test.local', passwordHash: 'x', name: 'Owner' })
        .returning()
    )[0]!.id;

    storageConfigId = (
      await db
        .insert(storageConfigs)
        .values({
          kind: 'local',
          label: 'Test disk',
          config: { root },
          secretCt: '',
          secretIv: '',
          secretTag: '',
          capabilities: connector.capabilities,
        })
        .returning()
    )[0]!.id;
  }, 60_000);

  afterEach(async () => {
    await closeDb();
    await rm(root, { recursive: true, force: true });
  });

  /** Builds a real clip and puts it in storage as a recording's original. */
  async function givenRecording(name: string, encodeArgs: string[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'openloom-input-'));
    const path = join(dir, name);
    await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      ...encodeArgs,
      path,
    ], { timeout: 120_000 });

    const recordingId = (
      await db
        .insert(recordings)
        .values({ ownerId, storageConfigId, title: name, state: 'ready' })
        .returning()
    )[0]!.id;

    const objectKey = `r/${recordingId}/original.${name.split('.').pop()}`;
    const stored = await uploadLocalFile(connector, {
      path,
      objectKey,
      contentType: name.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    });
    await db.insert(mediaAssets).values({
      recordingId,
      kind: 'original',
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      bytes: stored.bytes,
    });

    await rm(dir, { recursive: true, force: true });
    return recordingId;
  }

  const deps = () => ({ db, connectorFor: async () => connector });

  it('converts a Chrome recording so Safari can play it', async () => {
    // H.264 with Opus: the video is kept, only the audio is converted.
    const id = await givenRecording('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-strict', '-2',
    ]);

    const result = await processRecording(id, deps());

    expect(result.plan).toBe('transcode-audio');
    expect(result.producedRendition).toBe(true);

    const rendition = (
      await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id))
    ).find((a) => a.kind === 'mp4_source');
    expect(rendition).toBeDefined();

    // Read back out of storage: what a viewer would actually be served.
    const local = join(root, rendition!.objectKey);
    const info = await probeFile(local);
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
    expect(moovIsAtTheFront((await readFile(local)).subarray(0, 64 * 1024))).toBe(true);
  }, 180_000);

  it('re-encodes a WebM recording', async () => {
    const id = await givenRecording('chrome.webm', [
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus',
    ]);

    const result = await processRecording(id, deps());

    expect(result.plan).toBe('transcode');
    const rendition = (
      await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id))
    ).find((a) => a.kind === 'mp4_source');
    const info = await probeFile(join(root, rendition!.objectKey));
    expect(info.videoCodec).toBe('h264');
    expect(info.audioCodec).toBe('aac');
  }, 240_000);

  it('does no work on a recording that is already deliverable', async () => {
    const id = await givenRecording('safari.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart',
    ]);

    const result = await processRecording(id, deps());

    expect(result.plan).toBe('reuse');
    expect(result.producedRendition).toBe(false);
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id));
    expect(assets.filter((a) => a.kind === 'mp4_source')).toHaveLength(0);
  }, 180_000);

  it('fills in the metadata the upload could not know', async () => {
    const id = await givenRecording('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-strict', '-2',
    ]);

    await processRecording(id, deps());

    const recording = (await db.select().from(recordings).where(eq(recordings.id, id)))[0]!;
    // The browser reports none of this; ffprobe is the first thing that knows.
    expect(recording.durationMs).toBeGreaterThan(1800);
    expect(recording.width).toBe(320);
    expect(recording.height).toBe(240);
    expect(recording.hasAudio).toBe(true);
    expect(recording.state).toBe('ready');
  }, 180_000);

  it('produces a poster frame', async () => {
    const id = await givenRecording('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    ]);

    const result = await processRecording(id, deps());

    expect(result.producedPoster).toBe(true);
    const poster = (
      await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id))
    ).find((a) => a.kind === 'poster');
    expect(poster?.contentType).toBe('image/webp');
    expect(poster!.bytes).toBeGreaterThan(0);
  }, 180_000);

  it('can be run twice without duplicating anything', async () => {
    const id = await givenRecording('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-strict', '-2',
    ]);

    await processRecording(id, deps());
    await processRecording(id, deps());

    // A retried job must not leave a second rendition behind. The rendition key is
    // content-addressed, so the same input produces the same key.
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id));
    expect(assets.filter((a) => a.kind === 'mp4_source')).toHaveLength(1);
    expect(assets.filter((a) => a.kind === 'poster')).toHaveLength(1);
  }, 240_000);

  it('leaves a deleted recording alone', async () => {
    const id = await givenRecording('chrome.mp4', [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    ]);
    await db.update(recordings).set({ deletedAt: new Date() }).where(eq(recordings.id, id));

    const result = await processRecording(id, deps());

    expect(result.plan).toBe('skipped');
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.recordingId, id));
    expect(assets.filter((a) => a.kind !== 'original')).toHaveLength(0);
  }, 120_000);
});
