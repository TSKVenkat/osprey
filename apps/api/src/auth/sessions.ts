import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { type Database, sessions, users } from '@osprey/db';

export const SESSION_COOKIE = 'osprey_session';
const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user' | 'viewer';
}

/**
 * The cookie holds a random token; the database holds only its hash. A leaked
 * database dump therefore contains nothing that can be replayed as a login.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Database,
  userId: string,
  context: { userAgent?: string; ip?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    userAgent: context.userAgent?.slice(0, 500) ?? null,
    ip: context.ip ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Resolves a cookie to the user it belongs to, or null. Checking `isActive` here
 * rather than only at login is what makes disabling an account take effect on the
 * user's next request instead of whenever their session happens to expire.
 */
export async function resolveSession(db: Database, token: string): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Used when an account is disabled, its role changes, or its password changes. */
export async function revokeAllSessions(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping. Expired rows are harmless but there is no reason to keep them. */
export async function deleteExpiredSessions(db: Database): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
