import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Badge.module.css';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading icon (decorative). */
  icon?: ReactNode;
}

/** Compact label for categories and counts. */
export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], className)} {...rest}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: Tone;
  /** Always pass text: colour alone never carries status. */
  children: ReactNode;
  /** Animate the dot for live/in-progress states. */
  pulse?: boolean;
}

/** Status with a coloured dot and a text label, e.g. "Operational", "Blocked". */
export function StatusPill({ tone, pulse = false, className, children, ...rest }: StatusPillProps) {
  return (
    <span className={cx(styles.badge, styles.pill, styles[tone], className)} {...rest}>
      <span className={cx(styles.dot, pulse && styles.pulse)} aria-hidden="true" />
      {children}
    </span>
  );
}
