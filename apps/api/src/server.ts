import { createDatabase } from '@bilby/db';
import { PROCESS_RECORDING, createQueue } from '@bilby/jobs';
import { buildApp } from './app.ts';
import { bootstrapFirstAdmin } from './bootstrap.ts';
import { loadEnv } from './env.ts';

const env = loadEnv();
const { db, close } = createDatabase(env.DATABASE_URL);
const boss = await createQueue(env.DATABASE_URL);
const app = await buildApp(env, db, {
  enqueueProcessing: async (recordingId) => {
    await boss.send(PROCESS_RECORDING, { recordingId });
  },
});

const bootstrap = await bootstrapFirstAdmin(db, {
  email: env.ADMIN_EMAIL,
  password: env.ADMIN_PASSWORD,
});
if (bootstrap === 'created') {
  app.log.info({ email: env.ADMIN_EMAIL }, 'created the first admin account');
}

await app.listen({ port: env.PORT, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await boss.stop({ graceful: true });
    await close();
    process.exit(0);
  });
}
