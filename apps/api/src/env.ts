import { z } from 'zod';

// Parsed once at boot so a bad value fails the process rather than the first request
// that happens to touch it.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  // How the API is reached from a browser. Used to build local file URLs.
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  SECRET_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'SECRET_KEY must be 32 bytes, base64'),
  STORAGE_LOCAL_ROOT: z.string().default('./data/storage'),
  // Used once, to create the first admin on an empty database.
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export function webOrigins(env: Env): string[] {
  return env.WEB_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
