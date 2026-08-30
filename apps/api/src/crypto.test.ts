import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal, secretKey } from './crypto.ts';

const key = secretKey(randomBytes(32).toString('base64'));

describe('secret sealing', () => {
  it('round-trips a credential blob', () => {
    const secret = JSON.stringify({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });
    expect(open(seal(secret, key), key)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    const first = seal('same input', key);
    const second = seal('same input', key);
    // A fresh IV per encryption, so identical credentials do not look identical
    // in the database.
    expect(first.secretCt).not.toBe(second.secretCt);
    expect(first.secretIv).not.toBe(second.secretIv);
  });

  it('refuses to decrypt with the wrong key', () => {
    const sealed = seal('secret', key);
    const other = secretKey(randomBytes(32).toString('base64'));
    expect(() => open(sealed, other)).toThrow();
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const sealed = seal('secret', key);
    const bytes = Buffer.from(sealed.secretCt, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    // GCM is authenticated: a modified ciphertext fails rather than decrypting to
    // something else.
    expect(() => open({ ...sealed, secretCt: bytes.toString('base64') }, key)).toThrow();
  });
});
