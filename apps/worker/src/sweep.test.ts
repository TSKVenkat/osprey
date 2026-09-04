import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  mediaAssets,
  recordings,
  sessions,
  storageConfigs,
  uploadSessions,
  users,
} from '@osprey/db';
import { createTestDatabase } from '@osprey/db/testing';
import { LocalConnector, type StorageConnector } from '@osprey/storage';

import { sweep } from './sweep.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('sweep', () => {
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
    root = await mkdtemp(join(tmpdir(), 'osprey-sweep-'));
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

  const deps = (overrides: Partial<Parameters<typeof sweep>[0]> = {}) => ({
    db,
    connectorFor: async () => connector as StorageConnector,
    ...overrides,
  });

  async function givenRecording(state: 'uploading' | 'ready', deletedAt?: Date) {
    return (
      await db
        .insert(recordings)
        .values({ ownerId, storageConfigId, title: 'A recording', state, deletedAt })
        .returning()
    )[0]!;
  }

  async function givenStoredObject(recordingId: string, key: string) {
    const session = await connector.createUpload({
      objectKey: key,
      contentType: 'video/mp4',
    });
    const part = await connector.putPart(session, 1, Buffer.alloc(64, 1));
    const stored = await connector.completeUpload(session, [part]);
    await db.insert(mediaAssets).values({
      recordingId,
      kind: 'original',
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      bytes: stored.bytes,
    });
    return stored.objectKey;
  }

  it('clears out expired logins', async () => {
    await db.insert(sessions).values([
      { userId: ownerId, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() - HOUR) },
      { userId: ownerId, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + HOUR) },
    ]);

    const result = await sweep(deps());

    expect(result.expiredLogins).toBe(1);
    // The live one is untouched.
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it('abandons an upload that was started and never finished', async () => {
    const recording = await givenRecording('uploading');
    await db.insert(uploadSessions).values({
      recordingId: recording.id,
      storageConfigId,
      providerRef: 'r/never-finished/original.mp4',
      objectKey: 'r/never-finished/original.mp4',
      contentType: 'video/mp4',
      partSize: 8 * 1024 * 1024,
      expiresAt: new Date(Date.now() - HOUR),
    });

    const result = await sweep(deps());

    expect(result.abandonedUploads).toBe(1);
    const [session] = await db.select().from(uploadSessions);
    expect(session!.state).toBe('abandoned');
    // The recording goes with it, so it stops appearing as work in progress.
    const [after] = await db.select().from(recordings).where(eq(recordings.id, recording.id));
    expect(after!.state).toBe('abandoned');
  });

  it('leaves an upload that is still within its window alone', async () => {
    const recording = await givenRecording('uploading');
    await db.insert(uploadSessions).values({
      recordingId: recording.id,
      storageConfigId,
      providerRef: 'r/in-progress/original.mp4',
      objectKey: 'r/in-progress/original.mp4',
      contentType: 'video/mp4',
      partSize: 8 * 1024 * 1024,
      expiresAt: new Date(Date.now() + HOUR),
    });

    const result = await sweep(deps());

    // Sweeping mid-recording would destroy exactly the thing it is meant to protect.
    expect(result.abandonedUploads).toBe(0);
    const [session] = await db.select().from(uploadSessions);
    expect(session!.state).toBe('uploading');
  });

  it('does not touch a finished recording', async () => {
    const recording = await givenRecording('ready');
    const key = await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    const result = await sweep(deps());

    expect(result.purgedRecordings).toBe(0);
    expect(await connector.stat(key)).not.toBeNull();
  });

  it('keeps a recently deleted recording, so a mistake can be undone', async () => {
    const recording = await givenRecording('ready', new Date(Date.now() - HOUR));
    const key = await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    const result = await sweep(deps());

    expect(result.purgedRecordings).toBe(0);
    expect(await connector.stat(key)).not.toBeNull();
    expect(await db.select().from(recordings)).toHaveLength(1);
  });

  it('removes the files and the row once the undo window has passed', async () => {
    const recording = await givenRecording('ready', new Date(Date.now() - 8 * DAY));
    const key = await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    const result = await sweep(deps());

    expect(result.purgedRecordings).toBe(1);
    expect(result.deletedObjects).toBe(1);
    expect(await connector.stat(key)).toBeNull();
    expect(await db.select().from(recordings)).toHaveLength(0);
    // The asset rows go with the recording.
    expect(await db.select().from(mediaAssets)).toHaveLength(0);
  });

  it('honours a shorter retention when one is configured', async () => {
    const recording = await givenRecording('ready', new Date(Date.now() - 2 * DAY));
    await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    const result = await sweep(deps({ retentionDays: 1 }));

    expect(result.purgedRecordings).toBe(1);
  });

  it('keeps the row when the files could not be removed', async () => {
    const recording = await givenRecording('ready', new Date(Date.now() - 8 * DAY));
    await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    const failing = {
      ...connector,
      delete: async () => {
        throw new Error('storage is unreachable');
      },
    } as unknown as StorageConnector;

    const result = await sweep(deps({ connectorFor: async () => failing }));

    // The row is what says where the file is. Dropping it while the file survives
    // would orphan the object with nothing left pointing at it.
    expect(result.purgedRecordings).toBe(0);
    expect(result.deferredRecordings).toBe(1);
    expect(await db.select().from(recordings)).toHaveLength(1);
  });

  it('removes every asset a recording accumulated', async () => {
    const recording = await givenRecording('ready', new Date(Date.now() - 8 * DAY));
    const original = await givenStoredObject(recording.id, `r/${recording.id}/original.mp4`);

    // A processed recording has more than one file behind it.
    const rendition = await connector.createUpload({
      objectKey: `r/${recording.id}/mp4/abc.mp4`,
      contentType: 'video/mp4',
    });
    const part = await connector.putPart(rendition, 1, Buffer.alloc(32, 2));
    const stored = await connector.completeUpload(rendition, [part]);
    await db.insert(mediaAssets).values({
      recordingId: recording.id,
      kind: 'mp4_source',
      objectKey: stored.objectKey,
      contentType: 'video/mp4',
      bytes: stored.bytes,
    });

    const result = await sweep(deps());

    expect(result.deletedObjects).toBe(2);
    expect(await connector.stat(original)).toBeNull();
    expect(await connector.stat(stored.objectKey)).toBeNull();
  });

  it('does nothing, loudly, on an empty instance', async () => {
    const result = await sweep(deps());
    expect(result).toEqual({
      expiredLogins: 0,
      abandonedUploads: 0,
      purgedRecordings: 0,
      deletedObjects: 0,
      deferredRecordings: 0,
    });
  });
});
