import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@osprey/db';

import { forbidden, notFound, unauthorized } from '../errors.ts';
import { SESSION_COOKIE, type AuthUser, resolveSession } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function registerAuthContext(app: FastifyInstance, db: Database) {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    request.user = token ? await resolveSession(db, token) : null;
    if (request.user?.role === 'viewer' && isRecorderRoute(request.method, request.url)) {
      await requireRecorder(request);
    }
  });
}

function isRecorderRoute(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return (
    (method === 'POST' && path === '/v1/recordings') ||
    path.startsWith('/v1/uploads/') ||
    (method === 'POST' && /^\/v1\/recordings\/[^/]+\/shares$/.test(path))
  );
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
}

export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'admin') throw forbidden('This action is for administrators.');
}

export async function requireRecorder(request: FastifyRequest, _reply?: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
  if (request.user.role === 'viewer') throw forbidden('Viewers cannot record or upload recordings.');
}

export function requireOwnerOrAdmin(user: AuthUser | null, ownerId: string): void {
  if (!user) throw unauthorized();
  if (user.role === 'admin') return;
  if (user.id !== ownerId) throw notFound();
}
