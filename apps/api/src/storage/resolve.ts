import { eq } from 'drizzle-orm';
import { type Database, storageConfigs } from '@bilby/db';
import type { StorageConnector } from '@bilby/storage';

import { badRequest, notFound } from '../errors.ts';
import { open, secretKey } from '../crypto.ts';
import type { Env } from '../env.ts';
import { createConnector } from './factory.ts';

/**
 * Local read URLs carry the configuration id, so the route serving them knows which
 * root the key belongs to without having to guess between several local backends.
 */
export function factoryContext(env: Env, storageConfigId: string) {
  return {
    localBaseUrl: `${env.PUBLIC_API_URL}/files/${storageConfigId}`,
    signingSecret: env.SECRET_KEY,
  };
}

/**
 * Loads a storage configuration and turns it into a connector. Credentials are
 * decrypted here, held for the length of one request, and never logged or returned.
 */
export async function connectorById(
  db: Database,
  env: Env,
  id: string,
): Promise<StorageConnector> {
  const rows = await db.select().from(storageConfigs).where(eq(storageConfigs.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('That storage configuration no longer exists.');
  return connectorFromRow(row, env);
}

export async function defaultConnector(
  db: Database,
  env: Env,
): Promise<{ id: string; connector: StorageConnector }> {
  const rows = await db
    .select()
    .from(storageConfigs)
    .where(eq(storageConfigs.isDefault, true))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw badRequest(
      'NO_STORAGE_CONFIGURED',
      'An administrator needs to configure storage before recordings can be made.',
    );
  }
  return { id: row.id, connector: connectorFromRow(row, env) };
}

type StorageRow = typeof storageConfigs.$inferSelect;

export function connectorFromRow(row: StorageRow, env: Env): StorageConnector {
  const secret = JSON.parse(
    open(
      { secretCt: row.secretCt, secretIv: row.secretIv, secretTag: row.secretTag },
      secretKey(env.SECRET_KEY),
    ),
  );
  return createConnector({ kind: row.kind, config: row.config, secret }, factoryContext(env, row.id));
}
