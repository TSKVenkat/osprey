import { describe, expect, it } from 'vitest';
import { assertDenseParts, assertSafeKey } from './keys.ts';

describe('assertSafeKey', () => {
  it('accepts the keys we actually generate', () => {
    for (const key of [
      'r/8f2c/original.webm',
      'r/8f2c/mp4/9a1b2c3d4e5f6071.mp4',
      'r/8f2c/poster/9a1b2c3d4e5f6071.webp',
    ]) {
      expect(() => assertSafeKey(key)).not.toThrow();
    }
  });

  it('rejects traversal, absolute paths, and empty segments', () => {
    for (const key of ['../secrets', 'a/../../b', '/etc/passwd', 'a//b', 'a/./b', 'a/', '']) {
      expect(() => assertSafeKey(key), key).toThrow(/Object key/);
    }
  });

  it('rejects backslashes and control characters', () => {
    expect(() => assertSafeKey('a\\b')).toThrow(/disallowed character/);
    expect(() => assertSafeKey(`a${String.fromCharCode(0)}b`)).toThrow(/disallowed character/);
    expect(() => assertSafeKey(`a${String.fromCharCode(10)}b`)).toThrow(/disallowed character/);
  });

  it('rejects a key longer than the provider limit', () => {
    expect(() => assertSafeKey('a'.repeat(1025))).toThrow(/1 and 1024/);
  });
});

describe('assertDenseParts', () => {
  it('accepts 1..n in any order', () => {
    expect(() => assertDenseParts([{ partNumber: 3 }, { partNumber: 1 }, { partNumber: 2 }])).not.toThrow();
  });

  it('rejects a gap, a zero, and an empty list', () => {
    expect(() => assertDenseParts([{ partNumber: 1 }, { partNumber: 3 }])).toThrow(/no gaps/);
    expect(() => assertDenseParts([{ partNumber: 0 }])).toThrow(/no gaps/);
    expect(() => assertDenseParts([])).toThrow(/at least one part/);
  });
});
