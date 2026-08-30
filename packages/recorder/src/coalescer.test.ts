import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ChunkCoalescer } from './coalescer.ts';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function chunk(size: number, fill: number): Blob {
  return blobOf(new Uint8Array(size).fill(fill));
}

/** fast-check types its byte arrays against ArrayBufferLike, which is not a
 *  BlobPart. Copying gives a plain ArrayBuffer. */
function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer as ArrayBuffer]);
}

describe('ChunkCoalescer', () => {
  it('holds chunks back until they add up to a whole part', () => {
    const coalescer = new ChunkCoalescer(1000);

    expect(coalescer.push(chunk(400, 1))).toEqual([]);
    expect(coalescer.push(chunk(400, 2))).toEqual([]);

    const parts = coalescer.push(chunk(400, 3));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ partNumber: 1, bytes: 1000, isLast: false });
    expect(coalescer.pendingBytes).toBe(200);
  });

  it('splits a single oversized chunk into several parts', () => {
    const coalescer = new ChunkCoalescer(1000);

    const parts = coalescer.push(chunk(3500, 1));

    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(parts.every((p) => p.bytes === 1000)).toBe(true);
    expect(coalescer.pendingBytes).toBe(500);
  });

  it('emits the remainder as a final, undersized part', () => {
    const coalescer = new ChunkCoalescer(1000);
    coalescer.push(chunk(1500, 1));

    const last = coalescer.flush();

    expect(last).toMatchObject({ partNumber: 2, bytes: 500, isLast: true });
  });

  it('emits nothing when there is nothing buffered', () => {
    expect(new ChunkCoalescer(1000).flush()).toBeNull();
  });

  it('ignores empty chunks', () => {
    const coalescer = new ChunkCoalescer(100);
    expect(coalescer.push(new Blob([]))).toEqual([]);
    expect(coalescer.pendingBytes).toBe(0);
  });

  it('refuses to be used after flushing', () => {
    const coalescer = new ChunkCoalescer(100);
    coalescer.flush();
    expect(() => coalescer.push(chunk(10, 1))).toThrow(/after flush/);
    expect(() => coalescer.flush()).toThrow(/Already flushed/);
  });

  /**
   * The invariant the whole upload path rests on: whatever sequence of chunks
   * MediaRecorder produces, the parts we send must concatenate back into exactly
   * those bytes, in order, with only the last part allowed to be short.
   */
  it('always reassembles into the original byte stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 400 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 1, max: 500 }),
        async (chunks, targetBytes) => {
          const coalescer = new ChunkCoalescer(targetBytes);
          const parts = chunks.flatMap((c) => coalescer.push(blobOf(c)));
          const last = coalescer.flush();
          if (last) parts.push(last);

          const source = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          const assembled = Buffer.concat(
            await Promise.all(parts.map(async (p) => Buffer.from(await bytesOf(p.blob)))),
          );
          expect(assembled).toEqual(source);

          expect(parts.map((p) => p.partNumber)).toEqual(parts.map((_, i) => i + 1));
          for (const part of parts.slice(0, -1)) {
            expect(part.bytes).toBe(targetBytes);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
