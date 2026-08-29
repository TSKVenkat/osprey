import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './testing.ts';
import { users } from './schema.ts';

describe('test database', () => {
  it('applies migrations and enforces the schema', async () => {
    const { db, close } = await createTestDatabase();
    try {
      await db.insert(users).values({
        email: 'a@example.test',
        passwordHash: 'x',
        name: 'A',
      });

      // The unique index on email has to be real, not just declared in the schema file.
      await expect(
        db.insert(users).values({ email: 'a@example.test', passwordHash: 'y', name: 'B' }),
      ).rejects.toThrow();

      const rows = await db.select().from(users);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe('user');
      expect(rows[0]?.isActive).toBe(true);
    } finally {
      await close();
    }
  });
});
