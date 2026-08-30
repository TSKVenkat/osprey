import { describe, expect, it } from 'vitest';
import { RateEstimator, adaptivePartSize } from './rate.ts';

const caps = { minPartBytes: 5 * 1024 * 1024, maxPartBytes: 5 * 1024 * 1024 * 1024 };

describe('RateEstimator', () => {
  it('has no opinion until it has seen something', () => {
    const estimator = new RateEstimator();
    expect(estimator.bytesPerSecond).toBeNull();
    expect(estimator.estimateSeconds(1000)).toBeNull();
  });

  it('converges on a steady rate', () => {
    const estimator = new RateEstimator();
    for (let i = 0; i < 30; i++) estimator.observe(1_000_000, 1000);
    expect(estimator.bytesPerSecond).toBeCloseTo(1_000_000, -3);
  });

  it('weights recent samples more heavily', () => {
    const estimator = new RateEstimator();
    for (let i = 0; i < 10; i++) estimator.observe(1_000_000, 1000);
    estimator.observe(100_000, 1000);
    // The connection just slowed down, and the estimate should notice.
    expect(estimator.bytesPerSecond!).toBeLessThan(1_000_000);
  });

  it('ignores samples that would produce nonsense', () => {
    const estimator = new RateEstimator();
    estimator.observe(1000, 0);
    estimator.observe(0, 1000);
    expect(estimator.bytesPerSecond).toBeNull();
  });

  it('estimates remaining time', () => {
    const estimator = new RateEstimator();
    estimator.observe(1_000_000, 1000);
    expect(estimator.estimateSeconds(5_000_000)).toBeCloseTo(5, 1);
  });
});

describe('adaptivePartSize', () => {
  it('falls back before any measurement exists', () => {
    expect(adaptivePartSize(null, caps, 8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
  });

  it('never goes below what the backend accepts', () => {
    // A very slow link still cannot send a 200 KB part to S3.
    expect(adaptivePartSize(200_000, caps, 8 * 1024 * 1024)).toBe(caps.minPartBytes);
  });

  it('grows on a fast link, up to the ceiling', () => {
    expect(adaptivePartSize(50_000_000, caps, 8 * 1024 * 1024)).toBe(16 * 1024 * 1024);
  });

  it('scales with the measured rate in between', () => {
    const size = adaptivePartSize(1_000_000, caps, 8 * 1024 * 1024);
    expect(size).toBeGreaterThanOrEqual(caps.minPartBytes);
    expect(size).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
