import { count } from 'drizzle-orm';
import { type Database, users } from '@bilby/db';
import { hashPassword, passwordProblem } from './auth/password.ts';

/**
 * Creates the first admin on an otherwise empty instance. Runs only when there are
 * no users at all, so it cannot be used to add an admin to a running instance.
 */
export async function bootstrapFirstAdmin(
  db: Database,
  credentials: { email?: string; password?: string },
): Promise<'created' | 'skipped'> {
  const existing = await db.select({ n: count() }).from(users);
  if ((existing[0]?.n ?? 0) > 0) return 'skipped';

  const { email, password } = credentials;
  if (!email || !password) return 'skipped';

  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD is not acceptable: ${problem}`);

  await db.insert(users).values({
    email: email.toLowerCase(),
    name: 'Admin',
    role: 'admin',
    passwordHash: await hashPassword(password),
  });

  return 'created';
}
