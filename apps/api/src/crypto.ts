import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedSecret {
  secretCt: string;
  secretIv: string;
  secretTag: string;
}

/**
 * Storage credentials are encrypted before they reach the database, so a database
 * dump on its own is not enough to reach the bucket. AES-256-GCM is authenticated:
 * a tampered ciphertext fails to decrypt rather than producing wrong plaintext.
 *
 * The key comes from SECRET_KEY. Changing it makes existing credentials unreadable,
 * which is a rotation procedure we do not have yet — noted in the env example.
 */
export function seal(plaintext: string, key: Buffer): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    secretCt: ct.toString('base64'),
    secretIv: iv.toString('base64'),
    secretTag: cipher.getAuthTag().toString('base64'),
  };
}

export function open(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.secretIv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.secretTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.secretCt, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function secretKey(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}
