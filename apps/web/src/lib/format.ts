export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * "3 minutes ago", falling back to a date once that stops being useful.
 *
 * A library is read by recency — what did I record this morning — and an absolute
 * timestamp makes the reader do that arithmetic themselves. Past a week the
 * relative form stops helping ("23 days ago" is not a date anyone can place), so
 * it hands over to the calendar.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 45) return 'just now';

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  // Each unit is used up to the point where the next one starts reading better:
  // minutes until an hour, hours until a day, days until a week.
  const scales: [Intl.RelativeTimeFormatUnit, number, number][] = [
    ['minute', 60, 3600],
    ['hour', 3600, 86_400],
    ['day', 86_400, 7 * 86_400],
  ];
  for (const [unit, size, until] of scales) {
    if (seconds < until) return relative.format(-Math.round(seconds / size), unit);
  }

  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Hours only when there are hours, so a 40-second clip does not read "0:00:40". */
export function formatClock(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '0:00';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const padded = String(seconds).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${padded}`
    : `${minutes}:${padded}`;
}
