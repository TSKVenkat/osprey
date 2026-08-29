import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as schema from './schema.ts';

/**
 * An in-process Postgres for tests. Real SQL, real constraints, real migrations —
 * so an integration test exercises the same indexes and checks production does,
 * without needing a container to be running first.
 *
 * Not for production use: it lives in memory and dies with the process.
 */
export async function createTestDatabase() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  await migrate(db, { migrationsFolder: folder });

  return {
    db,
    close: () => client.close(),
  };
}

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>['db'];
