import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Database = ReturnType<typeof createDatabase>['db'];

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
