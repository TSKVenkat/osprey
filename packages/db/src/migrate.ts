import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

// Migrations run one connection at a time; more would just queue behind the lock.
const client = postgres(url, { max: 1 });
const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

await migrate(drizzle(client), { migrationsFolder: folder });
await client.end();
console.log('Migrations applied.');
