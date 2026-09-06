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

export interface Harness { app: FastifyInstance; db: Database; storageRoot: string; close: () => Promise<void>; }
let shared: Promise<Awaited<ReturnType<typeof createTestDatabase>>> | null = null;
function sharedDatabase() { shared ??= createTestDatabase(); return shared; }
async function reset(db: Database): Promise<void> { await db.execute(sql`do $$ declare statement text; begin select 'truncate table ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' restart identity cascade' into statement from pg_tables where schemaname = 'public'; if statement is not null then execute statement; end if; end $$;`); }
export async function createHarness(): Promise<Harness> { const { db } = await sharedDatabase(); await reset(db); const storageRoot = await mkdtemp(join(tmpdir(), 'osprey-test-')); const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', SECRET_KEY: Buffer.alloc(32, 7).toString('base64') }); const app = await buildApp(env, db); await bootstrapFirstAdmin(db, TEST_ADMIN); return { app, db, storageRoot, close: async () => { await app.close(); await rm(storageRoot, { recursive: true, force: true }); } }; }
export async function configureLocalStorage(harness: Harness, adminCookie: string): Promise<string> { const created = await harness.app.inject({ method: 'POST', url: '/v1/admin/storage', headers: { cookie: adminCookie }, payload: { kind: 'local', label: 'Test disk', config: { root: harness.storageRoot } } }); if (created.statusCode !== 201) throw new Error(`Could not configure storage: ${created.body}`); const id = created.json().storage.id as string; const made = await harness.app.inject({ method: 'POST', url: `/v1/admin/storage/${id}/default`, headers: { cookie: adminCookie } }); if (made.statusCode !== 200) throw new Error(`Could not set default storage: ${made.body}`); return id; }
export async function login(app: FastifyInstance, credentials: { email: string; password: string }): Promise<string> { const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: credentials }); if (response.statusCode !== 200) throw new Error(`Login failed for ${credentials.email}: ${response.body}`); const cookie = response.cookies.find((c) => c.name === 'osprey_session'); if (!cookie) throw new Error('Login succeeded but set no session cookie.'); return `osprey_session=${cookie.value}`; }
export async function createUserAndLogin(app: FastifyInstance, adminCookie: string, user: { email: string; password: string; name?: string; role?: 'admin' | 'user' | 'viewer' }): Promise<{ id: string; cookie: string }> { const response = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: { cookie: adminCookie }, payload: { name: user.name ?? 'Test User', role: user.role ?? 'user', ...user } }); if (response.statusCode !== 201) throw new Error(`Could not create ${user.email}: ${response.body}`); const id = response.json().user.id as string; return { id, cookie: await login(app, user) }; }
