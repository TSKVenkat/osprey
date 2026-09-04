import { describe, expect, it } from 'vitest';
import { loadEnv, webOrigins } from './env.ts';

const valid = {
  DATABASE_URL: 'postgres://localhost:5432/bilby',
  SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('fills in defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects a secret key that is not 32 bytes', () => {
    expect(() => loadEnv({ ...valid, SECRET_KEY: 'too-short' })).toThrow(/SECRET_KEY/);
  });

  it('rejects a missing database url', () => {
    expect(() => loadEnv({ SECRET_KEY: valid.SECRET_KEY })).toThrow(/DATABASE_URL/);
  });

  it('splits a comma-separated origin list', () => {
    const env = loadEnv({ ...valid, WEB_ORIGIN: 'http://a.test, http://b.test' });
    expect(webOrigins(env)).toEqual(['http://a.test', 'http://b.test']);
  });
});
