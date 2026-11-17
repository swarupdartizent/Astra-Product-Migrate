import { useEffect, useState } from 'react';
import { cx } from '@/lib/cx';
import { formatAbsolute, formatRelative, toDate } from '@/lib/time';
import styles from './Timestamp.module.css';
import { Tooltip } from './Tooltip';

export interface TimestampProps {
  value: Date | string | number;
  /** "relative" (default): "5 minutes ago" with the absolute time in a tooltip. */
  format?: 'relative' | 'absolute';
  className?: string;
}

/** Re-renders periodically so relative times stay true while the page is open. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Timestamp({ value, format = 'relative', className }: TimestampProps) {
  const now = useNow(30_000);
  const date = toDate(value);
  if (!date) {
    return <span className={cx(styles.timestamp, className)}>Invalid date</span>;
  }
  const absolute = formatAbsolute(date);
  if (format === 'absolute') {
    return (
      <time className={cx(styles.timestamp, className)} dateTime={date.toISOString()}>
        {absolute}
      </time>
    );
  }
  return (
    <Tooltip content={absolute}>
      <time
        className={cx(styles.timestamp, styles.relative, className)}
        dateTime={date.toISOString()}
        // Focusable so keyboard users can reach the absolute time in the tooltip.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={`${formatRelative(date, now)} (${absolute})`}
      >
        {formatRelative(date, now)}
      </time>
    </Tooltip>
  );
}
