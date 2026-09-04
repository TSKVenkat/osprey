import { createDecipheriv } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Database, storageConfigs } from '@bilby/db';
import { buildConnector, type StorageConnector } from '@bilby/storage';

import type { WorkerEnv } from './env.ts';

/**
 * Builds a connector from a stored configuration, decrypting its credentials the
 * same way the API does. The construction itself lives in the storage package, so
 * the two cannot drift apart.
 */
export function connectorLoader(db: Database, env: WorkerEnv) {
  const key = Buffer.from(env.SECRET_KEY, 'base64');

  return async (storageConfigId: string): Promise<StorageConnector> => {
    const rows = await db
      .select()
      .from(storageConfigs)
      .where(eq(storageConfigs.id, storageConfigId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error(`No storage configuration ${storageConfigId}.`);

    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.secretIv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.secretTag, 'base64'));
    const secret = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(row.secretCt, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ) as Record<string, unknown>;

    return buildConnector(
      { kind: row.kind, config: (row.config ?? {}) as Record<string, unknown>, secret },
      {
        localBaseUrl: `${env.PUBLIC_API_URL}/files/${row.id}`,
        signingSecret: env.SECRET_KEY,
      },
    );
  };
}
