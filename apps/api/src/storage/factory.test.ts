import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { testConnector } from './factory.ts';
import type { StorageConnector } from '@osprey/storage';

/** A connector whose createUpload throws whatever it is given. */
function throwing(error: unknown): StorageConnector {
  return {
    kind: 'local',
    capabilities: { minPartBytes: 1 },
    createUpload: async () => {
      throw error;
    },
    delete: async () => {},
  } as unknown as StorageConnector;
}

describe('reporting why a storage backend was refused', () => {
  it('passes an ordinary error message through', async () => {
    const result = await testConnector(throwing(new Error('bucket does not exist')));
    expect(result).toEqual({ ok: false, reason: 'bucket does not exist' });
  });

  it('reads a message off a plain object', async () => {
    // Cloudinary throws one of these rather than an Error, and an instanceof check
    // would drop the only explanation the administrator gets.
    const result = await testConnector(throwing({ message: 'Invalid API key', http_code: 401 }));
    expect(result).toEqual({ ok: false, reason: 'Invalid API key (HTTP 401)' });
  });

  it('reads a nested message', async () => {
    const result = await testConnector(throwing({ error: { message: 'Missing signature' } }));
    expect(result).toMatchObject({ reason: 'Missing signature' });
  });

  it('falls back to a code when there is no message', async () => {
    const result = await testConnector(throwing({ code: 'ENOTFOUND' }));
    expect(result).toMatchObject({ reason: 'ENOTFOUND' });
  });

  it('says so plainly when there is nothing to report', async () => {
    const result = await testConnector(throwing('something odd'));
    expect(result).toMatchObject({ reason: /without saying why/ });
  });
});

describe('a backend that never answers', () => {
  /** Hangs on the first call, the way an unreachable endpoint does. */
  function hangingConnector(): StorageConnector {
    return {
      capabilities: { minPartBytes: 1 },
      createUpload: () => new Promise(() => {}),
      delete: async () => {},
    } as unknown as StorageConnector;
  }

  it('gives up rather than leaving the request open forever', async () => {
    const started = Date.now();
    const result = await testConnector(hangingConnector(), 50);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/did not respond/);
    // The point of the test: it returns at all.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('a backend that fails once and then works', () => {
  /** Fails `failures` times with `reason`, then succeeds. */
  function flaky(failures: number, reason: string) {
    let calls = 0;
    let stored: Buffer = Buffer.alloc(0);
    const connector = {
      capabilities: { minPartBytes: 1 },
      createUpload: async () => {
        calls++;
        if (calls <= failures) throw new Error(reason);
        return { objectKey: 'k', contentType: 'application/octet-stream' };
      },
      // Stores what it was given and serves it back, because the test it has to
      // satisfy reads a byte range and compares it to what was written.
      putPart: async (_s: unknown, n: number, body: Buffer) => {
        stored = body;
        return { partNumber: n, etag: 'e', bytes: body.length };
      },
      completeUpload: async () => {},
      stat: async () => ({ bytes: stored.length, contentType: 'application/octet-stream' }),
      openRead: async (_k: string, range?: { start?: number; end?: number }) =>
        Readable.from([stored.subarray(range?.start ?? 0, (range?.end ?? stored.length - 1) + 1)]),
      delete: async () => {},
    } as unknown as StorageConnector;
    return { connector, calls: () => calls };
  }

  it('does not reject a working backend over one timeout', async () => {
    // Cloudinary answers a cold connection with this every so often and then works
    // two seconds later. Rejecting on the first one costs somebody an afternoon
    // checking credentials that were right.
    const { connector } = flaky(1, 'Request Timeout (HTTP 499)');

    const result = await testConnector(connector, 5000);

    expect(result.ok).toBe(true);
  });

  it('gives up once the network has plainly had its chances', async () => {
    const { connector, calls } = flaky(99, 'fetch failed');

    const result = await testConnector(connector, 5000);

    expect(result.ok).toBe(false);
    expect(calls()).toBe(3);
  });

  it('does not retry an answer, only an accident', async () => {
    // A rejected key is a fact. Asking three times makes the person wait longer to
    // hear it and tells them nothing new.
    const { connector, calls } = flaky(99, 'Invalid api_key 111111111111111');

    const result = await testConnector(connector, 5000);

    expect(result.ok).toBe(false);
    expect(calls()).toBe(1);
  });
});
