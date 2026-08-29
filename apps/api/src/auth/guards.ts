import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@openloom/db';

import { forbidden, notFound, unauthorized } from '../errors.ts';
import { SESSION_COOKIE, type AuthUser, resolveSession } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

/**
 * Resolves the cookie once per request. Handlers read `request.user` and never
 * touch cookies themselves.
 */
export function registerAuthContext(app: FastifyInstance, db: Database) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await resolveSession(db, token) : null;
  });
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
}

export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'admin') throw forbidden('This action is for administrators.');
}

/**
 * The one place ownership is decided. Returns 404 rather than 403 for a resource
 * someone does not own, so the API does not confirm that an id exists to people who
 * have no business knowing.
 */
export function requireOwnerOrAdmin(user: AuthUser | null, ownerId: string): void {
  if (!user) throw unauthorized();
  if (user.role === 'admin') return;
  if (user.id !== ownerId) throw notFound();
}
