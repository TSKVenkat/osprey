import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SECRET_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'SECRET_KEY must be 32 bytes, base64'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  // How long a deleted recording keeps its files, so a mistake can be undone.
  RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
