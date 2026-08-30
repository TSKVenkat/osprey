import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Database } from '@openloom/db';
import { type Env, webOrigins } from './env.ts';
import { registerErrorHandler } from './errors.ts';
import { registerAuthContext } from './auth/guards.ts';
import { healthRoutes } from './routes/health.ts';
import { authRoutes } from './routes/auth.ts';
import { adminUserRoutes } from './routes/admin-users.ts';
import { adminStorageRoutes } from './routes/admin-storage.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { recordingRoutes } from './routes/recordings.ts';
import { fileRoutes } from './routes/files.ts';

export async function buildApp(env: Env, db: Database) {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : env.NODE_ENV === 'development'
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

  // Part bodies arrive as raw bytes on the proxy upload path. Fastify has no parser
  // for this type by default and would reject the request as unsupported media.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  registerErrorHandler(app);
  registerAuthContext(app, db);

  healthRoutes(app, db);
  authRoutes(app, db, env);
  adminUserRoutes(app, db);
  adminStorageRoutes(app, db, env);
  uploadRoutes(app, db, env);
  recordingRoutes(app, db, env);
  fileRoutes(app, db, env);

  return app;
}
