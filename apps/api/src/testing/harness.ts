import type { FastifyInstance } from 'fastify';
import { createTestDatabase } from '@openloom/db/testing';
import type { Database } from '@openloom/db';

import { buildApp } from '../app.ts';
import { loadEnv } from '../env.ts';
import { bootstrapFirstAdmin } from '../bootstrap.ts';

export const TEST_ADMIN = { email: 'admin@test.local', password: 'admin-password-1' };

export interface Harness {
  app: FastifyInstance;
  db: Database;
  close: () => Promise<void>;
}

/**
 * A real Fastify app over a real Postgres, both in-process. No ports, no containers,
 * so an integration test costs about as much as a unit test to run.
 */
export async function createHarness(): Promise<Harness> {
  const { db, close: closeDb } = await createTestDatabase();
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  });

  const app = await buildApp(env, db);
  await bootstrapFirstAdmin(db, TEST_ADMIN);

  return {
    app,
    db,
    close: async () => {
      await app.close();
      await closeDb();
    },
  };
}

/** Signs in and returns the session cookie, ready to put on later requests. */
export async function login(
  app: FastifyInstance,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: credentials,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed for ${credentials.email}: ${response.body}`);
  }
  const cookie = response.cookies.find((c) => c.name === 'openloom_session');
  if (!cookie) throw new Error('Login succeeded but set no session cookie.');
  return `openloom_session=${cookie.value}`;
}

/** Creates a user through the admin API and signs in as them. */
export async function createUserAndLogin(
  app: FastifyInstance,
  adminCookie: string,
  user: { email: string; password: string; name?: string; role?: 'admin' | 'user' },
): Promise<{ id: string; cookie: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/users',
    headers: { cookie: adminCookie },
    payload: { name: user.name ?? 'Test User', role: user.role ?? 'user', ...user },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Could not create ${user.email}: ${response.body}`);
  }
  const id = response.json().user.id as string;
  return { id, cookie: await login(app, user) };
}
