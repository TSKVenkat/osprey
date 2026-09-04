import type { FastifyInstance } from 'fastify';
import { eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, storageConfigs } from '@osprey/db';

import { badRequest, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { seal, secretKey } from '../crypto.ts';
import type { Env } from '../env.ts';
import { createConnector, parseConnectorInput, testConnector } from '../storage/factory.ts';
import { connectorFromRow, factoryContext } from '../storage/resolve.ts';

const createBody = z.object({
  kind: z.enum(['local', 's3', 'cloudinary', 'imagekit']),
  label: z.string().min(1).max(200),
  config: z.unknown(),
  secret: z.unknown().optional(),
  /**
   * Start using it for new recordings straight away.
   *
   * Saving and activating used to be two steps, and somebody who did the first and
   * not the second got a working configuration that nothing ever wrote to — with
   * no sign anything was wrong.
   */
  makeDefault: z.boolean().optional(),
});

// Deliberately omits every secret column. There is no endpoint that returns
// credentials, not even to an admin: they go in and they are used, that is all.
const publicColumns = {
  id: storageConfigs.id,
  kind: storageConfigs.kind,
  label: storageConfigs.label,
  config: storageConfigs.config,
  capabilities: storageConfigs.capabilities,
  isDefault: storageConfigs.isDefault,
  status: storageConfigs.status,
  lastTestedAt: storageConfigs.lastTestedAt,
  createdAt: storageConfigs.createdAt,
};

export function adminStorageRoutes(app: FastifyInstance, db: Database, env: Env) {
  app.get('/v1/admin/storage', { preHandler: requireAdmin }, async () => ({
    storage: await db.select(publicColumns).from(storageConfigs).orderBy(storageConfigs.createdAt),
  }));

  app.post('/v1/admin/storage', { preHandler: requireAdmin }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const { config, secret } = parseConnectorInput(body.kind, body.config, body.secret);

    // Tested before it is saved. A configuration that cannot be written to is worse
    // than no configuration: it fails later, in the middle of someone's recording.
    // No id yet; the connection test only writes, reads and deletes, so the read
    // URL prefix does not matter here.
    const connector = createConnector(
      { kind: body.kind, config, secret },
      factoryContext(env, 'unsaved'),
    );
    const result = await testConnector(connector);
    if (!result.ok) {
      throw badRequest('STORAGE_TEST_FAILED', `Could not use that storage: ${result.reason}`);
    }

    const created = await db
      .insert(storageConfigs)
      .values({
        kind: body.kind,
        label: body.label,
        config,
        ...seal(JSON.stringify(secret), secretKey(env.SECRET_KEY)),
        capabilities: connector.capabilities,
        status: 'ok',
        lastTestedAt: new Date(),
      })
      .returning(publicColumns);

    const saved = created[0]!;

    // Also the first one to be configured: an instance with storage that nothing
    // uses is not a working instance.
    const existingDefault = await db
      .select({ id: storageConfigs.id })
      .from(storageConfigs)
      .where(eq(storageConfigs.isDefault, true))
      .limit(1);

    if (body.makeDefault || existingDefault.length === 0) {
      await db.update(storageConfigs).set({ isDefault: false }).where(ne(storageConfigs.id, saved.id));
      await db.update(storageConfigs).set({ isDefault: true }).where(eq(storageConfigs.id, saved.id));
      return reply.code(201).send({ storage: { ...saved, isDefault: true } });
    }

    return reply.code(201).send({ storage: saved });
  });

  app.post('/v1/admin/storage/:id/test', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db.select().from(storageConfigs).where(eq(storageConfigs.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('No such storage configuration.');

    const result = await testConnector(connectorFromRow(row, env));
    await db
      .update(storageConfigs)
      .set({ status: result.ok ? 'ok' : 'failing', lastTestedAt: new Date() })
      .where(eq(storageConfigs.id, id));

    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  });

  app.post('/v1/admin/storage/:id/default', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db.select().from(storageConfigs).where(eq(storageConfigs.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('No such storage configuration.');

    // Re-tested at the moment it becomes the default, because that is the moment it
    // starts mattering to every new recording.
    const result = await testConnector(connectorFromRow(row, env));
    if (!result.ok) {
      throw badRequest(
        'STORAGE_TEST_FAILED',
        `That storage is not usable right now: ${result.reason}`,
      );
    }

    // Cleared first: the partial unique index allows exactly one default row, so
    // setting a new one without clearing the old would be rejected by the database.
    await db
      .update(storageConfigs)
      .set({ isDefault: false })
      .where(ne(storageConfigs.id, id));
    const updated = await db
      .update(storageConfigs)
      .set({ isDefault: true, status: 'ok', lastTestedAt: new Date() })
      .where(eq(storageConfigs.id, id))
      .returning(publicColumns);

    return { storage: updated[0] };
  });

  app.delete('/v1/admin/storage/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db.select().from(storageConfigs).where(eq(storageConfigs.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('No such storage configuration.');
    if (row.isDefault) {
      throw badRequest(
        'STORAGE_IN_USE',
        'Make another configuration the default before removing this one.',
      );
    }

    // Recordings reference their storage configuration, so the delete fails while any
    // recording still points at it. That is the desired outcome: the row is what
    // tells us where those files live.
    try {
      await db.delete(storageConfigs).where(eq(storageConfigs.id, id));
    } catch {
      throw badRequest(
        'STORAGE_IN_USE',
        'Recordings are still stored here, so this configuration cannot be removed.',
      );
    }

    return reply.code(204).send();
  });
}
