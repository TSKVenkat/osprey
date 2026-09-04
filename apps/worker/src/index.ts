import { cpus } from 'node:os';
import { createDatabase } from '@bilby/db';
import {
  PROCESS_RECORDING,
  SWEEP,
  type ProcessRecordingPayload,
  createQueue,
  processRecordingPayload,
} from '@bilby/jobs';

import { loadWorkerEnv } from './env.ts';
import { connectorLoader } from './storage.ts';
import { processRecording } from './process-recording.ts';
import { sweep } from './sweep.ts';

const env = loadWorkerEnv();
const { db, close } = createDatabase(env.DATABASE_URL);
const boss = await createQueue(env.DATABASE_URL);

// ffmpeg saturates a core each. Leaving one free keeps the host responsive, and the
// cap stops a burst of recordings from taking down the machine doing the work.
const concurrency = Math.max(1, Math.min(cpus().length - 1, 4));

const connectorFor = connectorLoader(db, env);

await boss.work(
  PROCESS_RECORDING,
  { batchSize: concurrency },
  async (jobs: { data: ProcessRecordingPayload }[]) => {
    for (const job of jobs) {
      const { recordingId } = processRecordingPayload.parse(job.data);
      const started = Date.now();
      const result = await processRecording(recordingId, {
        db,
        connectorFor,
        log: (message, details) => console.log(message, JSON.stringify(details ?? {})),
      });
      console.log('processed', JSON.stringify({ ...result, tookMs: Date.now() - started }));
    }
  },
);

// Housekeeping nothing else does: releasing parts held by uploads that were never
// finished, and removing files for recordings whose undo window has passed.
await boss.work(SWEEP, { batchSize: 1 }, async () => {
  await sweep({
    db,
    connectorFor,
    retentionDays: env.RETENTION_DAYS,
    log: (message, details) => console.log(message, JSON.stringify(details ?? {})),
  });
});
await boss.schedule(SWEEP, '*/15 * * * *');

console.log(`worker ready, ${concurrency} at a time`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    await boss.stop({ graceful: true });
    await close();
    process.exit(0);
  });
}
