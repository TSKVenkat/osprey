import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, backoffDelay, shouldRetry } from './backoff.ts';

describe('backoffDelay', () => {
  it('grows exponentially', () => {
    // random() pinned to 1 gives the ceiling for each attempt.
    const ceilings = [0, 1, 2, 3].map((n) => backoffDelay(n, DEFAULT_RETRY, () => 0.999999));
    expect(ceilings[0]).toBeLessThan(ceilings[1]!);
    expect(ceilings[1]).toBeLessThan(ceilings[2]!);
    expect(ceilings[2]).toBeLessThan(ceilings[3]!);
  });

  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      expect(backoffDelay(attempt, DEFAULT_RETRY, () => 0.999999)).toBeLessThanOrEqual(
        DEFAULT_RETRY.capMs,
      );
    }
  });

  it('spreads retries across the whole window', () => {
    // Full jitter, not a fixed delay: this is what stops every client that failed at
    // the same moment retrying at the same moment and causing the next failure.
    const low = backoffDelay(5, DEFAULT_RETRY, () => 0);
    const high = backoffDelay(5, DEFAULT_RETRY, () => 0.999999);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(DEFAULT_RETRY.baseMs);
  });

  it('is deterministic for a given random source', () => {
    const source = () => 0.5;
    expect(backoffDelay(3, DEFAULT_RETRY, source)).toBe(backoffDelay(3, DEFAULT_RETRY, source));
  });
});

describe('shouldRetry', () => {
  it('stops at the attempt limit', () => {
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts - 2, 0)).toBe(true);
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts - 1, 0)).toBe(false);
  });

  it('stops once the time budget is spent, however few attempts were made', () => {
    expect(shouldRetry(0, DEFAULT_RETRY.totalBudgetMs + 1)).toBe(false);
  });
});
