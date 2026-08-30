import { createDecipheriv } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Database, storageConfigs } from '@openloom/db';
import { LocalConnector, S3Connector, type StorageConnector } from '@openloom/storage';

import type { WorkerEnv } from './env.ts';

/**
 * Builds a connector from a stored configuration, decrypting its credentials the
 * same way the API does. Kept small and duplicated rather than shared, because the
 * alternative is a package that exists only to hold one switch statement.
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
    );

    const config = row.config as Record<string, unknown>;
    if (row.kind === 'local') {
      return new LocalConnector({
        root: String(config.root),
        baseUrl: `${env.PUBLIC_API_URL}/files/${row.id}`,
        signingSecret: env.SECRET_KEY,
      });
    }
    if (row.kind === 's3') {
      return new S3Connector({
        bucket: String(config.bucket),
        region: config.region ? String(config.region) : undefined,
        endpoint: config.endpoint ? String(config.endpoint) : undefined,
        forcePathStyle: Boolean(config.forcePathStyle),
        accessKeyId: String(secret.accessKeyId),
        secretAccessKey: String(secret.secretAccessKey),
      });
    }
    throw new Error(`Storage backend "${row.kind}" is not built yet.`);
  };
}
