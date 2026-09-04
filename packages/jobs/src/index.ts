import PgBoss from 'pg-boss';
import { z } from 'zod';

/** One place both sides agree on, so a producer and a consumer cannot drift. */
export const PROCESS_RECORDING = 'recording.process';
export const SWEEP = 'maintenance.sweep';

export const processRecordingPayload = z.object({ recordingId: z.string().uuid() });
export type ProcessRecordingPayload = z.infer<typeof processRecordingPayload>;

export async function createQueue(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    // Its own schema, so job tables never sit among the application's.
    schema: 'osprey_jobs',
  });
  await boss.start();
  await boss.createQueue(PROCESS_RECORDING);
  await boss.createQueue(SWEEP);
  return boss;
}

export { PgBoss };
