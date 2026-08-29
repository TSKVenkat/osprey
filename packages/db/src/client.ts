import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

/**
 * Deliberately the driver-agnostic type: production runs on postgres-js and tests
 * run on an in-process PGlite, and every caller should work with either.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end() };
}

/** Cheapest possible round trip, used by the readiness check. */
export async function ping(db: Database): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
