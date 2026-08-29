import { createDatabase } from '@openloom/db';
import { buildApp } from './app.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);
const app = await buildApp(env, db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await close();
    process.exit(0);
  });
}
