import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { ChunkCoalescer, type Part } from './coalescer.ts';
import { MemoryPartStore } from './store.ts';
import { UploadScheduler, type UploadTransport } from './scheduler.ts';
import { createTransport, type PartTarget, type UploadApi } from './transport.ts';

/** Time is driven by the test rather than waited on, so retries cost nothing. */
const instantSleep = async () => {};

function part(partNumber: number, bytes = 100): Part {
  return { partNumber, blob: blobOf(new Uint8Array(bytes)), bytes, isLast: false };
}

/** fast-check types its byte arrays against ArrayBufferLike, which is not a
 *  BlobPart. Copying gives a plain ArrayBuffer. */
function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer]);
}

describe('UploadScheduler', () => {
  it('sends every part that was enqueued', async () => {
    const sent: number[] = [];
    const scheduler = new UploadScheduler({
      concurrency: 2,
      sleep: instantSleep,
      transport: {
        async send(p) {
          sent.push(p.partNumber);
          return { bytes: p.bytes };
        },
      },
    });

    for (let i = 1; i <= 10; i++) scheduler.enqueue(part(i));
    scheduler.close();
    const { failures } = await scheduler.run();

    expect(failures).toEqual([]);
    expect(sent.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('takes the lowest part number first', async () => {
    const started: number[] = [];
    const scheduler = new UploadScheduler({
      // One worker, so the order taken is the order observed.
      concurrency: 1,
      sleep: instantSleep,
      transport: {
        async send(p) {
          started.push(p.partNumber);
          return { bytes: p.bytes };
        },
      },
    });

    for (const n of [5, 2, 9, 1]) scheduler.enqueue(part(n));
    scheduler.close();
    await scheduler.run();

    // Keeping the uploaded prefix contiguous is what lets the server assemble early.
    expect(started).toEqual([1, 2, 5, 9]);
  });

  it('honours the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const scheduler = new UploadScheduler({
      concurrency: 3,
      sleep: instantSleep,
      transport: {
        async send(p) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          inFlight--;
          return { bytes: p.bytes };
        },
      },
    });

    for (let i = 1; i <= 20; i++) scheduler.enqueue(part(i));
    scheduler.close();
    await scheduler.run();

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('retries a part that fails and then succeeds', async () => {
    let attempts = 0;
    const scheduler = new UploadScheduler({
      concurrency: 1,
      sleep: instantSleep,
      transport: {
        async send(p) {
          attempts++;
          if (attempts < 3) throw new Error('network blip');
          return { bytes: p.bytes };
        },
      },
    });

    scheduler.enqueue(part(1));
    scheduler.close();
    const { failures } = await scheduler.run();

    expect(attempts).toBe(3);
    expect(failures).toEqual([]);
  });

  it('gives up after the attempt limit and reports which part failed', async () => {
    const scheduler = new UploadScheduler({
      concurrency: 1,
      sleep: instantSleep,
      retry: { baseMs: 1, capMs: 10, maxAttempts: 3, totalBudgetMs: 10_000 },
      transport: {
        async send() {
          throw new Error('always down');
        },
      },
    });

    scheduler.enqueue(part(7));
    scheduler.close();
    const { failures } = await scheduler.run();

    // Reported rather than thrown, so the caller decides whether the upload as a
    // whole is salvageable.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.part.partNumber).toBe(7);
  });

  it('does not retry an error marked as final', async () => {
    let attempts = 0;
    const scheduler = new UploadScheduler({
      concurrency: 1,
      sleep: instantSleep,
      transport: {
        async send() {
          attempts++;
          throw Object.assign(new Error('bad request'), { retryable: false });
        },
      },
    });

    scheduler.enqueue(part(1));
    scheduler.close();
    await scheduler.run();

    // A rejected part is still rejected next time; retrying only burns the budget.
    expect(attempts).toBe(1);
  });

  it('keeps accepting parts while the recording is still going', async () => {
    const sent: number[] = [];
    const scheduler = new UploadScheduler({
      concurrency: 2,
      sleep: instantSleep,
      transport: {
        async send(p) {
          sent.push(p.partNumber);
          return { bytes: p.bytes };
        },
      },
    });

    const running = scheduler.run();
    scheduler.enqueue(part(1));
    await Promise.resolve();
    scheduler.enqueue(part(2));
    // Parts arriving after the workers have already gone idle must still be picked up.
    await new Promise((resolve) => setTimeout(resolve, 5));
    scheduler.enqueue(part(3));
    scheduler.close();

    await running;
    expect(sent.sort()).toEqual([1, 2, 3]);
  });

  it('stops starting new parts once aborted', async () => {
    let sent = 0;
    const scheduler = new UploadScheduler({
      concurrency: 1,
      sleep: instantSleep,
      transport: {
        async send(p) {
          sent++;
          return { bytes: p.bytes };
        },
      },
    });

    for (let i = 1; i <= 50; i++) scheduler.enqueue(part(i));
    scheduler.abort();
    await scheduler.run();

    expect(sent).toBe(0);
  });

  it('refuses parts enqueued after closing', () => {
    const scheduler = new UploadScheduler({
      concurrency: 1,
      transport: { async send(p) { return { bytes: p.bytes }; } },
    });
    scheduler.close();
    expect(() => scheduler.enqueue(part(1))).toThrow(/after close/);
  });
});

/**
 * The end-to-end invariant, under conditions a real network produces: parts that
 * fail and retry, parts delivered twice, parts arriving out of order. Whatever
 * happens on the way, what the server ends up holding must be exactly what was
 * recorded.
 */
describe('coalescer, scheduler and transport together', () => {
  function fakeApi(server: Map<number, Uint8Array>, faults: Map<number, number>): UploadApi {
    const remaining = new Map(faults);
    return {
      async getPartTarget(): Promise<PartTarget> {
        return { mode: 'proxy', url: '/proxy' };
      },
      async putPart(_sessionId, partNumber, blob) {
        const left = remaining.get(partNumber) ?? 0;
        if (left > 0) {
          remaining.set(partNumber, left - 1);
          throw new Error(`part ${partNumber} failed`);
        }
        // The server stores by part number, so a duplicate delivery overwrites
        // rather than appending — the same thing the primary key does for real.
        server.set(partNumber, new Uint8Array(await blob.arrayBuffer()));
        return { etag: `etag-${partNumber}` };
      },
      async ackPart() {},
    };
  }

  it('delivers the recorded bytes intact however the network misbehaves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 300 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 50, max: 400 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 25 }),
        fc.integer({ min: 1, max: 4 }),
        async (chunks, partSize, faultCounts, concurrency) => {
          const store = new MemoryPartStore();
          const server = new Map<number, Uint8Array>();
          const faults = new Map(faultCounts.map((count, index) => [index + 1, count]));

          const coalescer = new ChunkCoalescer(partSize);
          const parts = chunks.flatMap((c) => coalescer.push(blobOf(c)));
          const last = coalescer.flush();
          if (last) parts.push(last);

          for (const p of parts) await store.put('r1', p);

          const transport: UploadTransport = createTransport({
            api: fakeApi(server, faults),
            store,
            recordingId: 'r1',
            sessionId: 's1',
          });

          const scheduler = new UploadScheduler({
            transport,
            concurrency,
            sleep: instantSleep,
            retry: { baseMs: 1, capMs: 2, maxAttempts: 8, totalBudgetMs: 60_000 },
          });
          for (const p of parts) scheduler.enqueue(p);
          scheduler.close();

          const { failures } = await scheduler.run();
          expect(failures).toEqual([]);

          const assembled = Buffer.concat(
            [...server.keys()].sort((a, b) => a - b).map((n) => Buffer.from(server.get(n)!)),
          );
          expect(assembled).toEqual(Buffer.concat(chunks.map((c) => Buffer.from(c))));

          // Local copies are released only after the server confirms, so a clean run
          // leaves nothing behind.
          expect(await store.list('r1')).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );
  });
});
