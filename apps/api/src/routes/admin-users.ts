import type { FastifyInstance } from 'fastify';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { type Database, users } from '@osprey/db';

import { badRequest, conflict, notFound } from '../errors.ts';
import { requireAdmin } from '../auth/guards.ts';
import { hashPassword, passwordProblem } from '../auth/password.ts';
import { revokeAllSessions } from '../auth/sessions.ts';

const createBody = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
  role: z.enum(['admin', 'user', 'viewer']).default('user'),
});

const updateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(['admin', 'user', 'viewer']).optional(),
  isActive: z.boolean().optional(),
});

const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  isActive: users.isActive,
  createdAt: users.createdAt,
};

export function adminUserRoutes(app: FastifyInstance, db: Database) {
  app.get('/v1/admin/users', { preHandler: requireAdmin }, async () => ({
    users: await db.select(publicColumns).from(users).orderBy(users.createdAt),
  }));

  // Accounts are created by an admin. There is no open sign-up: an instance where
  // anyone can register is an instance anyone can fill with recordings.
  app.post('/v1/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest('WEAK_PASSWORD', problem);

    const email = body.email.toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) throw conflict('EMAIL_TAKEN', 'That email already has an account.');

    const created = await db
      .insert(users)
      .values({
        email,
        name: body.name,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      })
      .returning(publicColumns);

    return reply.code(201).send({ user: created[0] });
  });

  app.patch('/v1/admin/users/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = updateBody.parse(request.body);

    const found = await db.select().from(users).where(eq(users.id, id)).limit(1);
    const target = found[0];
    if (!target) throw notFound('No such user.');

    // An admin cannot demote or disable themselves. Locking yourself out of your own
    // instance is a support problem with no in-app fix.
    const isSelf = target.id === request.user!.id;
    if (isSelf && body.role === 'user') {
      throw badRequest('CANNOT_DEMOTE_SELF', 'You cannot remove your own admin role.');
    }
    if (isSelf && body.isActive === false) {
      throw badRequest('CANNOT_DISABLE_SELF', 'You cannot disable your own account.');
    }

    // Nor can the last remaining admin be removed by anyone.
    const losesAdmin = target.role === 'admin' && (body.role === 'user' || body.isActive === false);
    if (losesAdmin) {
      const others = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.isActive, true), ne(users.id, target.id)));
      if ((others[0]?.n ?? 0) === 0) {
        throw badRequest('LAST_ADMIN', 'This instance must keep at least one active admin.');
      }
    }

    const updated = await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning(publicColumns);

    // A disabled account or a changed role must take effect immediately, not
    // whenever the user's current session happens to expire.
    if (body.isActive === false || body.role) await revokeAllSessions(db, id);

    return { user: updated[0] };
  });

  // Accounts are disabled rather than deleted: deleting one would cascade to every
  // recording it owns, which is almost never what an admin means by "remove".
  app.post('/v1/admin/users/:id/reset-password', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
    const problem = passwordProblem(password);
    if (problem) throw badRequest('WEAK_PASSWORD', problem);

    const found = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!found[0]) throw notFound('No such user.');

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
      .where(eq(users.id, id));
    await revokeAllSessions(db, id);

    return { ok: true };
  });
}
