import { expect, test } from '@playwright/test';

import { requireDevServer } from './helpers.ts';

/**
 * The part store, exercised in a real browser.
 *
 * This is the piece that makes a crashed tab survivable: parts are written here
 * before they are sent and released only once the server confirms them. It is also
 * the one part of the recorder that cannot be tested in Node, because the origin
 * private file system only exists in a browser.
 *
 * A short recording never fills an 8 MiB part, so the ordinary end-to-end test
 * never reaches this code. It is driven directly instead.
 */
test('stores, returns and releases parts in the origin private file system', async ({ page }) => {
  await page.goto('/');
  await requireDevServer(page);

  const result = await page.evaluate(async () => {
    // The dev server serves the app's own modules, so this is the same store the
    // recorder uses rather than a copy of it.
    const { chooseStore } = await import('/src/lib/capture.ts');
    const { store, durable } = chooseStore();

    const recordingId = `spill-test-${Date.now()}`;
    const part = (partNumber: number, fill: number) => ({
      partNumber,
      blob: new Blob([new Uint8Array(2048).fill(fill)]),
      bytes: 2048,
      isLast: false,
    });

    await store.put(recordingId, part(1, 1));
    await store.put(recordingId, part(2, 2));
    await store.put(recordingId, part(3, 3));
    const afterPut = await store.list(recordingId);

    const readBack = await store.get(recordingId, 2);
    const firstByte = new Uint8Array(await readBack!.arrayBuffer())[0];
    const size = readBack!.size;

    // Releasing one part must not disturb the others: that is what happens every
    // time the server acknowledges a part mid-recording.
    await store.release(recordingId, 2);
    const afterRelease = await store.list(recordingId);

    const manifest = {
      recordingId,
      uploadSessionId: 'session-1',
      mimeType: 'video/mp4',
      partSize: 8388608,
      startedAt: Date.now(),
      state: 'uploading' as const,
      parts: [{ partNumber: 1, bytes: 2048, uploaded: false }],
    };
    await store.saveManifest(manifest);
    const manifests = await store.loadManifests();
    const found = manifests.find((m) => m.recordingId === recordingId);

    await store.deleteRecording(recordingId);
    const afterDelete = await store.list(recordingId);
    const manifestsAfterDelete = (await store.loadManifests()).filter(
      (m) => m.recordingId === recordingId,
    );

    const missing = await store.get(recordingId, 99);

    return {
      durable,
      storeName: store.constructor.name,
      afterPut,
      firstByte,
      size,
      afterRelease,
      manifestFound: found?.uploadSessionId ?? null,
      afterDelete,
      manifestsAfterDelete: manifestsAfterDelete.length,
      missingIsNull: missing === null,
    };
  });

  // Chrome has OPFS, so the recorder must be using the durable store rather than
  // quietly falling back to memory and losing the crash guarantee.
  expect(result.durable).toBe(true);
  expect(result.storeName).toBe('OpfsPartStore');

  expect(result.afterPut).toEqual([1, 2, 3]);
  expect(result.size).toBe(2048);
  expect(result.firstByte).toBe(2);

  expect(result.afterRelease).toEqual([1, 3]);
  expect(result.manifestFound).toBe('session-1');

  expect(result.afterDelete).toEqual([]);
  expect(result.manifestsAfterDelete).toBe(0);
  expect(result.missingIsNull).toBe(true);
});

test('keeps parts across a page reload, which is the point of storing them', async ({ page }) => {
  await page.goto('/');
  await requireDevServer(page);

  const recordingId = await page.evaluate(async () => {
    const { chooseStore } = await import('/src/lib/capture.ts');
    const { store } = chooseStore();
    const id = `reload-test-${Date.now()}`;
    await store.put(id, {
      partNumber: 1,
      blob: new Blob([new Uint8Array(4096).fill(9)]),
      bytes: 4096,
      isLast: false,
    });
    await store.saveManifest({
      recordingId: id,
      uploadSessionId: 'session-reload',
      mimeType: 'video/mp4',
      partSize: 8388608,
      startedAt: Date.now(),
      state: 'uploading',
      parts: [{ partNumber: 1, bytes: 4096, uploaded: false }],
    });
    return id;
  });

  // A reload is the mild version of the tab crash this exists to survive.
  await page.reload();

  const survived = await page.evaluate(async (id) => {
    const { chooseStore } = await import('/src/lib/capture.ts');
    const { store } = chooseStore();
    const parts = await store.list(id);
    const blob = await store.get(id, 1);
    const manifest = (await store.loadManifests()).find((m) => m.recordingId === id);
    await store.deleteRecording(id);
    return { parts, bytes: blob?.size ?? 0, session: manifest?.uploadSessionId ?? null };
  }, recordingId);

  expect(survived.parts).toEqual([1]);
  expect(survived.bytes).toBe(4096);
  expect(survived.session).toBe('session-reload');
});
