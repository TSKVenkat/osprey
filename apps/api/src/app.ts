import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Database } from '@openloom/db';
import { type Env, webOrigins } from './env.ts';
import { healthRoutes } from './routes/health.ts';

export async function buildApp(env: Env, db: Database) {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: 'info', transport: { target: 'pino-pretty' } }
        : { level: 'info' },
    // Uploads can be large; the body limit here only guards JSON control-plane
    // requests, since part bytes go straight to storage or through a stream route.
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: webOrigins(env), credentials: true });
  await app.register(cookie, { secret: env.SECRET_KEY });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  healthRoutes(app, db);

  return app;
}
