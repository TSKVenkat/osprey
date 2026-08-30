import { describe, expect, it } from 'vitest';
import { describeRecovery, isStale, planRecovery, type RemoteSession } from './recovery.ts';
import type { StoredManifest } from './store.ts';

const manifest = (parts: number[] = [1, 2, 3]): StoredManifest => ({
  recordingId: 'r1',
  uploadSessionId: 's1',
  mimeType: 'video/mp4',
  partSize: 8 * 1024 * 1024,
  startedAt: Date.now(),
  state: 'uploading',
  parts: parts.map((partNumber) => ({ partNumber, bytes: 1024 * 1024, uploaded: false })),
});

const remote = (partNumbers: number[], state = 'uploading'): RemoteSession => ({
  state,
  parts: partNumbers.map((partNumber) => ({ partNumber, bytes: 1024 * 1024 })),
});

describe('planRecovery', () => {
  it('resumes the parts the server never acknowledged', () => {
    // The tab died after writing three parts but before the last two were sent.
    const plan = planRecovery(manifest(), [1, 2, 3], remote([1]));
    expect(plan).toEqual({ action: 'resume', partNumbers: [2, 3] });
  });

  it('returns the pending parts in order', () => {
    const plan = planRecovery(manifest(), [5, 1, 3], remote([]));
    expect(plan).toEqual({ action: 'resume', partNumbers: [1, 3, 5] });
  });

  it('just commits when everything already arrived', () => {
    // Everything landed; the tab died between the last acknowledgement and the
    // commit. Nothing to re-upload.
    expect(planRecovery(manifest(), [1, 2, 3], remote([1, 2, 3]))).toEqual({ action: 'complete' });
  });

  it('commits even when the local copies are gone', () => {
    // Parts are released as soon as the server confirms them, so an upload that
    // got all the way through leaves nothing on disk.
    expect(planRecovery(manifest(), [], remote([1, 2]))).toEqual({ action: 'complete' });
  });

  it('gives up when the server has never heard of the upload', () => {
    const plan = planRecovery(manifest(), [1, 2], null);
    expect(plan).toMatchObject({ action: 'discard' });
  });

  it('gives up on an upload that was already finished', () => {
    const plan = planRecovery(manifest(), [], remote([1], 'done'));
    expect(plan).toMatchObject({ action: 'discard' });
  });

  it('gives up on an upload that was aborted', () => {
    const plan = planRecovery(manifest(), [1], remote([], 'abandoned'));
    expect(plan).toMatchObject({ action: 'discard' });
  });

  it('gives up when nothing was recorded at all', () => {
    const plan = planRecovery(manifest([]), [], remote([]));
    expect(plan).toMatchObject({ action: 'discard' });
  });

  it('gives up when the middle of the recording is missing', () => {
    // Parts 1 and 3 arrived but 2 never did, and the local copy is gone too. The
    // server will not commit a file with a hole in it, and it should not.
    const plan = planRecovery(manifest(), [], remote([1, 3]));
    expect(plan).toMatchObject({ action: 'discard' });
  });

  it('prefers resuming over giving up when a gap can still be filled', () => {
    // Same gap, but part 2 is still on disk, so it can be sent.
    const plan = planRecovery(manifest(), [2], remote([1, 3]));
    expect(plan).toEqual({ action: 'resume', partNumbers: [2] });
  });
});

describe('isStale', () => {
  it('treats a recording from a few minutes ago as recoverable', () => {
    const recent = { ...manifest(), startedAt: Date.now() - 5 * 60_000 };
    expect(isStale(recent)).toBe(false);
  });

  it('treats one from two days ago as abandoned', () => {
    const old = { ...manifest(), startedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 };
    expect(isStale(old)).toBe(true);
  });
});

describe('describeRecovery', () => {
  it('says how much is left to send', () => {
    const text = describeRecovery(manifest(), { action: 'resume', partNumbers: [2, 3] });
    expect(text).toMatch(/3\.0 MB still to upload/);
  });

  it('passes the reason through when giving up', () => {
    const text = describeRecovery(manifest(), { action: 'discard', reason: 'Gone.' });
    expect(text).toBe('Gone.');
  });
});

describe('planRecovery with a partial tail', () => {
  const tailManifest = manifest([]);

  it('sends the tail even when no whole part was ever completed', () => {
    // The common case for a short or low-bitrate recording: nothing reached eight
    // megabytes, so the entire recording is sitting in the tail.
    const plan = planRecovery(tailManifest, [], remote([]), true);
    expect(plan).toEqual({ action: 'resume', partNumbers: [], tailPartNumber: 1 });
  });

  it('numbers the tail after every part that already exists', () => {
    const plan = planRecovery(manifest(), [1, 2], remote([1, 2]), true);
    expect(plan).toEqual({ action: 'resume', partNumbers: [], tailPartNumber: 3 });
  });

  it('numbers the tail after unsent local parts too', () => {
    const plan = planRecovery(manifest(), [1, 2, 3], remote([1]), true);
    expect(plan).toEqual({ action: 'resume', partNumbers: [2, 3], tailPartNumber: 4 });
  });

  it('still gives up when there is no tail and nothing was recorded', () => {
    expect(planRecovery(tailManifest, [], remote([]), false)).toMatchObject({ action: 'discard' });
  });
});
