import { describe, expect, it } from 'vitest';
import { testConnector } from './factory.ts';
import type { StorageConnector } from '@bilby/storage';

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
