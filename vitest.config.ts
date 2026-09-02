import { readFileSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Roughly what one worker needs at its peak.
 *
 * Each one holds its own PGlite — Postgres compiled to WebAssembly — and the worker
 * tests shell out to ffmpeg on top of that. Measured at a few hundred megabytes,
 * rounded up, because the cost of guessing high is a slower suite and the cost of
 * guessing low is the machine dying.
 */
const MEMORY_PER_WORKER = 800 * 1024 * 1024;

/**
 * Memory this machine can actually hand out right now.
 *
 * `freemem()` is the wrong number on Linux: it excludes the page cache, which the
 * kernel gives back on demand, so it reads far lower than what is really available
 * and would drive the suite down to one worker on a perfectly healthy machine.
 * MemAvailable is the kernel's own estimate of what a new process can have without
 * swapping, which is exactly the question being asked here.
 */
function availableMemory(): number {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const kilobytes = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1];
    if (kilobytes) return Number(kilobytes) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted. freemem is the portable answer.
  }
  return freemem();
}

/**
 * How many test workers this machine can afford, not how many it has cores for.
 *
 * A fixed count is fine right up until the suite runs next to something else — a
 * compose stack, a dev server, another project's containers — and then it is the
 * thing that gets the machine OOM-killed. That happened, more than once, and the
 * fixed four was the reason.
 *
 * Never zero, and never more than four: past that the suite is bounded by starting
 * Postgres instances rather than by running tests.
 */
function workerCount(): number {
  const affordable = Math.floor(availableMemory() / MEMORY_PER_WORKER);
  return Math.max(1, Math.min(4, availableParallelism(), affordable));
}

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // The e2e specs are Playwright's, and need a running instance.
    exclude: ['**/node_modules/**', 'e2e/**'],
    environment: 'node',
    // Each API test starts an in-process Postgres and applies migrations, which is
    // slower than a unit test but still faster than waiting on a container.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    maxWorkers: workerCount(),
    minWorkers: 1,
    env: {
      // Real bcrypt, minimum work factor. The production cost is set in password.ts.
      BCRYPT_ROUNDS: '4',
    },
  },
});
