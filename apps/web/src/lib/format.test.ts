import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatRelative } from './format.ts';

describe('how long ago something was recorded', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const ago = (seconds: number) =>
    formatRelative(new Date(now.getTime() - seconds * 1000).toISOString(), now);

  it('says "just now" while the number would be noise', () => {
    expect(ago(3)).toBe('just now');
    expect(ago(44)).toBe('just now');
  });

  it('counts in the largest unit that still means something', () => {
    expect(ago(90)).toMatch(/minute/);
    expect(ago(3 * 3600)).toMatch(/hour/);
    expect(ago(2 * 86400)).toMatch(/day/);
  });

  // "23 days ago" is not a date anyone can place, so it hands over to the calendar.
  it('gives an actual date once relative stops helping', () => {
    expect(ago(30 * 86400)).toMatch(/2026/);
  });

  it('does not produce junk for an unparseable date', () => {
    expect(formatRelative('not a date', now)).toBe('');
  });
});

describe('how long a recording is', () => {
  it('leaves the hours out when there are none', () => {
    expect(formatClock(40_000)).toBe('0:40');
    expect(formatClock(95_000)).toBe('1:35');
  });

  it('shows hours when there are some, with padded minutes', () => {
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });

  it('has something to show before the duration is known', () => {
    expect(formatClock(null)).toBe('0:00');
  });
});

describe('sizes', () => {
  it('scales to the unit a person would use', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
