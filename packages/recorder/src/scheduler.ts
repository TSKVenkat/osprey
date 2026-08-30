import { DEFAULT_RETRY, type RetryPolicy, backoffDelay, shouldRetry } from './backoff.ts';
import type { Part } from './coalescer.ts';

export interface UploadTransport {
  /** Sends one part. Throwing means it did not land; the scheduler decides what next. */
  send(part: Part): Promise<{ bytes: number }>;
}

export interface SchedulerOptions {
  transport: UploadTransport;
  concurrency: number;
  retry?: RetryPolicy;
  /** Injected so tests can drive time instead of waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onPartDone?: (part: Part, elapsedMs: number) => void;
  onPartFailed?: (part: Part, error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uploads parts while the recording is still going.
 *
 * Work is taken in part-number order rather than arrival order, which keeps the
 * uploaded prefix of the file contiguous. That is what lets the server begin
 * assembling early, and what a future segmented format would need to publish a
 * playable prefix before the recording ends.
 */
export class UploadScheduler {
  private readonly queue: Part[] = [];
  private readonly inFlight = new Set<number>();
  private readonly failures: { part: Part; error: unknown }[] = [];
  private closed = false;
  private aborted = false;
  // Every idle worker parks here. One slot would only ever wake the worker that
  // parked last and leave the rest asleep forever.
  private waiters: (() => void)[] = [];

  private readonly transport: UploadTransport;
  private readonly concurrency: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onPartDone: (part: Part, elapsedMs: number) => void;
  private readonly onPartFailed: (part: Part, error: unknown) => void;

  constructor(options: SchedulerOptions) {
    this.transport = options.transport;
    this.concurrency = Math.max(1, options.concurrency);
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onPartDone = options.onPartDone ?? (() => {});
    this.onPartFailed = options.onPartFailed ?? (() => {});
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size;
  }

  enqueue(part: Part): void {
    if (this.closed) throw new Error('Cannot enqueue after close.');
    // Kept in part-number order. The queue is short — a handful of parts at most —
    // so an insertion sort is cheaper and clearer than maintaining a heap.
    const index = this.queue.findIndex((queued) => queued.partNumber > part.partNumber);
    if (index === -1) this.queue.push(part);
    else this.queue.splice(index, 0, part);
    this.notify();
  }

  /** No more parts are coming. Workers finish what is left and stop. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  /** Gives up: in-flight parts finish, nothing else starts. */
  abort(): void {
    this.aborted = true;
    this.closed = true;
    this.queue.length = 0;
    this.notify();
  }

  /**
   * Runs until every enqueued part has landed or been given up on. Resolves with the
   * parts that failed, so the caller can decide whether the upload is salvageable
   * rather than having an exception decide for it.
   */
  async run(): Promise<{ failures: { part: Part; error: unknown }[] }> {
    const workers = Array.from({ length: this.concurrency }, () => this.worker());
    await Promise.all(workers);
    return { failures: this.failures };
  }

  private async worker(): Promise<void> {
    for (;;) {
      const part = this.queue.shift();
      if (!part) {
        if (this.closed) return;
        await this.waitForWork();
        continue;
      }

      this.inFlight.add(part.partNumber);
      try {
        await this.sendWithRetries(part);
      } finally {
        this.inFlight.delete(part.partNumber);
      }
    }
  }

  private async sendWithRetries(part: Part): Promise<void> {
    const startedAt = this.now();

    for (let attempt = 0; ; attempt++) {
      if (this.aborted) return;
      try {
        await this.transport.send(part);
        this.onPartDone(part, this.now() - startedAt);
        return;
      } catch (error) {
        const elapsed = this.now() - startedAt;
        // Some failures are not worth retrying: a rejected part is still rejected
        // the second time. The transport says so by marking the error.
        const fatal = (error as { retryable?: boolean })?.retryable === false;
        if (fatal || !shouldRetry(attempt, elapsed, this.retry)) {
          this.failures.push({ part, error });
          this.onPartFailed(part, error);
          return;
        }
        await this.sleep(backoffDelay(attempt, this.retry, this.random));
      }
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}
