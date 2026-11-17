const DIVISIONS: readonly { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/** Converts a date into a value accepted by the Date constructor; returns null when invalid. */
export function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now", "5 minutes ago", "in 2 days". */
export function formatRelative(date: Date, now: Date = new Date(), locale?: string): string {
  let duration = (date.getTime() - now.getTime()) / 1000;
  if (Math.abs(duration) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'year');
}

/** Full absolute timestamp with time zone, e.g. "17 Nov 2026, 14:05:09 GMT". */
export function formatAbsolute(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(date);
}
