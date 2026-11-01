import { describe, expect, it } from 'vitest';

import { AzureBlobPublisher } from './azure.ts';

describe('Azure Blob Storage playback URLs', () => {
  it('creates a read-only SAS URL that expires within the requested TTL', async () => {
    const publisher = new AzureBlobPublisher({
      accountName: 'exampleaccount',
      accountKey: Buffer.alloc(32, 1).toString('base64'),
      container: 'osprey-recordings',
    });
    const startedAt = Date.now();

    const target = await publisher.playbackUrl('r/abc/original.mp4', { ttlSeconds: 60 });
    const url = new URL(target.url);
    const expiresAt = Date.parse(url.searchParams.get('se') ?? '');

    expect(target.kind).toBe('progressive');
    expect(url.searchParams.get('sp')).toBe('r');
    expect(url.searchParams.get('spr')).toBe('https');
    expect(url.searchParams.get('sr')).toBe('b');
    expect(url.searchParams.get('sv')).toBe('2023-11-03');
    expect(url.searchParams.get('sig')).toBeTruthy();
    expect(expiresAt - startedAt).toBeGreaterThan(59_000);
    expect(expiresAt - startedAt).toBeLessThanOrEqual(60_000);
    expect(target.expiresAt?.getTime()).toBe(expiresAt);
  });
});
