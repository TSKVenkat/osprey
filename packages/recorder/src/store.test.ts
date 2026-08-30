import { describe, expect, it } from 'vitest';
import { MemoryPartStore } from './store.ts';
import type { Part } from './coalescer.ts';

function part(partNumber: number, fill: number): Part {
  const bytes = new Uint8Array(64).fill(fill);
  return {
    partNumber,
    blob: new Blob([bytes.slice().buffer as ArrayBuffer]),
    bytes: bytes.length,
    isLast: false,
  };
}

describe('MemoryPartStore', () => {
  it('stores and returns a part', async () => {
    const store = new MemoryPartStore();
    await store.put('r1', part(1, 7));

    const blob = await store.get('r1', 1);
    expect(new Uint8Array(await blob!.arrayBuffer())[0]).toBe(7);
  });

  it('returns null for a part it does not have', async () => {
    expect(await new MemoryPartStore().get('r1', 1)).toBeNull();
  });

  it('lists parts in order', async () => {
    const store = new MemoryPartStore();
    for (const n of [3, 1, 2]) await store.put('r1', part(n, n));
    expect(await store.list('r1')).toEqual([1, 2, 3]);
  });

  it('releases one part without touching the others', async () => {
    const store = new MemoryPartStore();
    await store.put('r1', part(1, 1));
    await store.put('r1', part(2, 2));

    await store.release('r1', 1);

    expect(await store.list('r1')).toEqual([2]);
  });

  it('keeps recordings separate', async () => {
    const store = new MemoryPartStore();
    await store.put('r1', part(1, 1));
    await store.put('r2', part(1, 2));

    await store.deleteRecording('r1');

    expect(await store.list('r1')).toEqual([]);
    expect(await store.list('r2')).toEqual([1]);
  });

  it('keeps a manifest so an interrupted upload can be found again', async () => {
    const store = new MemoryPartStore();
    const manifest = {
      recordingId: 'r1',
      uploadSessionId: 's1',
      mimeType: 'video/webm',
      partSize: 1024,
      startedAt: 1,
      state: 'uploading' as const,
      parts: [{ partNumber: 1, bytes: 64, uploaded: false }],
    };

    await store.saveManifest(manifest);

    // This is what a page reads on startup to notice it has work left over from a
    // tab that died.
    expect(await store.loadManifests()).toEqual([manifest]);
  });

  it('drops the manifest along with the recording', async () => {
    const store = new MemoryPartStore();
    await store.saveManifest({
      recordingId: 'r1',
      uploadSessionId: 's1',
      mimeType: 'video/webm',
      partSize: 1024,
      startedAt: 1,
      state: 'done',
      parts: [],
    });

    await store.deleteRecording('r1');

    expect(await store.loadManifests()).toEqual([]);
  });
});
