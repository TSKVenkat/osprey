import type { FastifyInstance } from 'fastify';
import { type Database, ping } from '@bilby/db';

export function healthRoutes(app: FastifyInstance, db: Database) {
  // Liveness: the process is up. Never touches the database, so a database outage
  // does not make the orchestrator kill an otherwise healthy process.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: this instance can actually serve traffic.
  app.get('/ready', async (_req, reply) => {
    if (await ping(db)) return { status: 'ready' };
    return reply.code(503).send({ status: 'unavailable', reason: 'database' });
  });
}
