import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, users } from '@osprey/db';

import { badRequest, unauthorized } from '../errors.ts';
import { requireAuth } from '../auth/guards.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.ts';
import {
  SESSION_COOKIE,
  createSession,
  revokeAllSessions,
  revokeSession,
} from '../auth/sessions.ts';
import type { Env } from '../env.ts';

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

export function authRoutes(app: FastifyInstance, db: Database, env: Env) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
  };

  app.post(
    '/v1/auth/login',
    {
      config: {
        rateLimit: {
          // Counted per account per address rather than per address alone.
          // Guessing one account's password is what this is for, and keying only
          // on the address means everyone behind one office router shares a
          // budget and can lock each other out of their own accounts.
          max: 10,
          timeWindow: '1 minute',
          // The default hook runs before the body is parsed, and the email is in
          // the body.
          hook: 'preHandler' as const,
          keyGenerator: (request: { ip: string; body?: unknown }) => {
            const email = (request.body as { email?: unknown } | undefined)?.email;
            return `${request.ip}:${typeof email === 'string' ? email.toLowerCase() : 'unknown'}`;
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = loginBody.parse(request.body);

      const found = await db
        .select()
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);
      const user = found[0];

      // Verification runs even when no user matched, so the response takes the same
      // time either way and does not reveal which addresses have accounts.
      const ok = await verifyPassword(password, user?.passwordHash ?? null);
      if (!user || !ok || !user.isActive) {
        throw unauthorized('That email and password do not match an active account.');
      }

      const { token, expiresAt } = await createSession(db, user.id, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
      return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  app.get('/v1/auth/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user,
  }));

  app.post(
    '/v1/auth/password',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { currentPassword, newPassword } = changePasswordBody.parse(request.body);
      const problem = passwordProblem(newPassword);
      if (problem) throw badRequest('WEAK_PASSWORD', problem);

      const found = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1);
      const user = found[0];
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw unauthorized('Your current password is not correct.');
      }

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
        .where(eq(users.id, user.id));

      // Every existing session is dropped, including this one: a password change is
      // usually a response to something, and half-revoking would defeat the point.
      await revokeAllSessions(db, user.id);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return { ok: true };
    },
  );
}
