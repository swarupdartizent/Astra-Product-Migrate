import { describe, expect, it } from 'vitest';
import { formatRelative, toDate } from './time';

describe('formatRelative', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('says "just now" within 45 seconds', () => {
    expect(formatRelative(new Date('2026-11-17T11:59:30Z'), now, 'en')).toBe('just now');
  });

  it('formats minutes, hours and days', () => {
    expect(formatRelative(new Date('2026-11-17T11:55:00Z'), now, 'en')).toBe('5 minutes ago');
    expect(formatRelative(new Date('2026-11-17T09:00:00Z'), now, 'en')).toBe('3 hours ago');
    expect(formatRelative(new Date('2026-11-15T12:00:00Z'), now, 'en')).toBe('2 days ago');
    expect(formatRelative(new Date('2026-11-18T12:00:00Z'), now, 'en')).toBe('tomorrow');
  });
});

describe('toDate', () => {
  it('rejects invalid input', () => {
    expect(toDate('not a date')).toBeNull();
    expect(toDate(0)?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});
