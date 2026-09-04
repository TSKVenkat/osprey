import { describe, expect, it } from 'vitest';
import { isNotFound, publicIdFor, resourceTypeFor } from './cloudinary.ts';

/**
 * Cloudinary's error shape, pinned so it cannot regress without an account.
 *
 * These are the exact objects the live API produced. Getting this wrong does not
 * look like a bug in testing — a missing asset simply reports an error with no
 * message instead of reporting that it is missing.
 */
describe('recognising a missing asset', () => {
  it('reads the nested shape the admin API actually throws', () => {
    expect(
      isNotFound({
        request_options: { method: 'GET' },
        query_params: {},
        error: { message: 'Resource not found - osprey/r/abc/original', http_code: 404 },
      }),
    ).toBe(true);
  });

  it('still reads a flat shape', () => {
    expect(isNotFound({ http_code: 404, message: 'Resource not found' })).toBe(true);
  });

  it('recognises it by message when there is no code', () => {
    expect(isNotFound({ error: { message: 'Resource not found - x' } })).toBe(true);
  });

  it('does not mistake other failures for absence', () => {
    // These must propagate: treating a rate limit or an auth failure as "missing"
    // would make the sweeper think it had already cleaned up.
    expect(isNotFound({ error: { message: 'Invalid API key', http_code: 401 } })).toBe(false);
    expect(isNotFound({ error: { message: 'Rate limit reached', http_code: 420 } })).toBe(false);
    expect(isNotFound(new Error('socket hang up'))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

describe('public ids and resource types', () => {
  it('drops the extension Cloudinary would otherwise duplicate', () => {
    expect(publicIdFor('r/abc/original.mp4')).toBe('r/abc/original');
  });

  it('keeps video, image and raw apart', () => {
    expect(resourceTypeFor('video/mp4')).toBe('video');
    expect(resourceTypeFor('image/webp')).toBe('image');
    expect(resourceTypeFor('application/octet-stream')).toBe('raw');
  });
});
