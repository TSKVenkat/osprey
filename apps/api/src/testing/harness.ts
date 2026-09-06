import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '@osprey/db/testing';
import type { Database } from '@osprey/db';

import { buildApp } from '../app.ts';
import { loadEnv } from '../env.ts';
import { bootstrapFirstAdmin } from '../bootstrap.ts';

export const TEST_ADMIN = { email: 'admin@test.local', password: 'admin-password-1' };

export interface Harness {
  app: FastifyInstance;
  db: Database;
  /** Root directory of the local storage backend, once configured. */
  storageRoot: string;
  close: () => Promise<void>;
}

// One database per worker, not per test. Starting PGlite and applying migrations
// takes a couple of seconds; doing it for every test made the suite slow enough to
// hit its own timeouts as soon as the machine was busy with anything else.
let shared: Promise<Awaited<ReturnType<typeof createTestDatabase>>> | null = null;

function sharedDatabase() {
  shared ??= createTestDatabase();
  return shared;
}

/** Empties every table so the next test starts from nothing. */
async function reset(db: Database): Promise<void> {
  await db.execute(sql`
    do $$
    declare statement text;
    begin
      select 'truncate table ' || string_agg(format('%I.%I', schemaname, tablename), ', ')
             || ' restart identity cascade'
        into statement
        from pg_tables
       where schemaname = 'public';
      if statement is not null then execute statement; end if;
    end $$;
  `);
}

/**
 * A real Fastify app over a real Postgres, both in-process. No ports, no containers,
 * so an integration test costs about as much as a unit test to run.
 */
export async function createHarness(): Promise<Harness> {
  const { db } = await sharedDatabase();
  await reset(db);
  const storageRoot = await mkdtemp(join(tmpdir(), 'osprey-test-'));
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
    storageRoot,
    close: async () => {
      await app.close();
      // The database is shared across the file and torn down with the worker.
      await rm(storageRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Configures the local storage backend and makes it the default, which is what an
 * administrator does once before anyone can record.
 */
export async function configureLocalStorage(
  harness: Harness,
  adminCookie: string,
): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/v1/admin/storage',
    headers: { cookie: adminCookie },
    payload: { kind: 'local', label: 'Test disk', config: { root: harness.storageRoot } },
  });
  if (created.statusCode !== 201) {
    throw new Error(`Could not configure storage: ${created.body}`);
  }

  const id = created.json().storage.id as string;
  const made = await harness.app.inject({
    method: 'POST',
    url: `/v1/admin/storage/${id}/default`,
    headers: { cookie: adminCookie },
  });
  if (made.statusCode !== 200) throw new Error(`Could not set default storage: ${made.body}`);
  return id;
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
  const cookie = response.cookies.find((c) => c.name === 'osprey_session');
  if (!cookie) throw new Error('Login succeeded but set no session cookie.');
  return `osprey_session=${cookie.value}`;
}

/** Creates a user through the admin API and signs in as them. */
export async function createUserAndLogin(
  app: FastifyInstance,
  adminCookie: string,
  user: { email: string; password: string; name?: string; role?: 'admin' | 'user' | 'viewer' },
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
