import type { Capabilities } from './types.ts';

/**
 * Exponentially weighted average of recent upload speed. Recent parts matter more
 * than old ones, because what we want to know is what the connection is doing now.
 */
export class RateEstimator {
  private value: number | null = null;

  private readonly alpha: number;

  constructor(alpha = 0.3) {
    this.alpha = alpha;
  }

  observe(bytes: number, elapsedMs: number): void {
    if (elapsedMs <= 0 || bytes <= 0) return;
    const sample = (bytes * 1000) / elapsedMs;
    this.value = this.value === null ? sample : this.alpha * sample + (1 - this.alpha) * this.value;
  }

  /** Null until at least one part has completed. */
  get bytesPerSecond(): number | null {
    return this.value;
  }

  /** Seconds left, or null while there is nothing to base an estimate on. */
  estimateSeconds(remainingBytes: number): number | null {
    if (!this.value) return null;
    return remainingBytes / this.value;
  }
}

/** Roughly how long one part should take. Short enough to keep progress moving,
 *  long enough that per-request overhead does not matter. */
const TARGET_SECONDS_PER_PART = 8;

/**
 * Bigger parts on a fast link mean fewer round trips; smaller parts on a slow one
 * mean less to redo when a part fails and smoother progress. Keeping a part's time
 * in flight bounded also keeps it well inside the lifetime of its signed URL.
 */
export function adaptivePartSize(
  bytesPerSecond: number | null,
  capabilities: Pick<Capabilities, 'minPartBytes' | 'maxPartBytes'>,
  fallbackBytes: number,
): number {
  if (!bytesPerSecond) return fallbackBytes;
  const wanted = bytesPerSecond * TARGET_SECONDS_PER_PART;
  const ceiling = Math.min(capabilities.maxPartBytes, 16 * 1024 * 1024);
  return Math.round(Math.min(Math.max(wanted, capabilities.minPartBytes), ceiling));
}
