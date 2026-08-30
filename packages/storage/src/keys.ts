import { StorageError } from './errors.ts';

/**
 * Control characters, DEL, and backslashes have no legitimate use in an object key and
 * behave differently across the five backends. Checked by code point rather than with a
 * regex so the source stays free of literal control characters.
 */
function hasDisallowedCharacter(key: string): boolean {
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '\\') return true;
  }
  return false;
}

/**
 * Object keys reach us from request bodies, so they are checked before they are ever
 * turned into a filesystem path or a provider key.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 1024) {
    throw new StorageError('INVALID_KEY', 'Object key must be between 1 and 1024 characters.');
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new StorageError('INVALID_KEY', 'Object key must not start or end with a slash.');
  }
  if (key.includes('//')) {
    throw new StorageError('INVALID_KEY', 'Object key must not contain an empty path segment.');
  }
  // Covers "..", "./" and anything else trying to climb out of the storage root.
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new StorageError('INVALID_KEY', 'Object key must not contain relative path segments.');
  }
  if (hasDisallowedCharacter(key)) {
    throw new StorageError('INVALID_KEY', 'Object key contains a disallowed character.');
  }
}

/** Parts must be numbered 1..n with nothing missing before an upload can be committed. */
export function assertDenseParts(parts: { partNumber: number }[]): void {
  if (parts.length === 0) {
    throw new StorageError('PARTS_NOT_DENSE', 'An upload must have at least one part.');
  }
  const numbers = parts.map((p) => p.partNumber).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      throw new StorageError(
        'PARTS_NOT_DENSE',
        `Parts must be numbered 1..${numbers.length} with no gaps; found ${numbers.join(', ')}.`,
      );
    }
  }
}
