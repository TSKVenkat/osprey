export interface RetryPolicy {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
  /** Total time a single part may spend being retried before it is given up on. */
  totalBudgetMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  baseMs: 500,
  capMs: 30_000,
  maxAttempts: 8,
  totalBudgetMs: 10 * 60_000,
};

/**
 * Exponential backoff with full jitter: a delay picked uniformly from zero up to the
 * exponential ceiling.
 *
 * The jitter is the point. Fixed backoff means that when a provider blips, every
 * client that failed retries at the same moment and blips it again. Spreading the
 * retries out is what stops one failure becoming a repeating one.
 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export function shouldRetry(
  attempt: number,
  elapsedMs: number,
  policy: RetryPolicy = DEFAULT_RETRY,
): boolean {
  return attempt + 1 < policy.maxAttempts && elapsedMs < policy.totalBudgetMs;
}
