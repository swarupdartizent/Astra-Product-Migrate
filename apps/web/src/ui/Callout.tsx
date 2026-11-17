import { CircleCheck, CircleExclamationPoint, Info, TriangleExclamationPoint } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Callout.module.css';

export interface CalloutProps {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  /** Optional action aligned to the end (e.g. a small Button). */
  action?: ReactNode;
  /** Announce politely when it appears (status) instead of staying silent. */
  live?: boolean;
  className?: string;
}

const ICONS = {
  info: Info,
  success: CircleCheck,
  warning: TriangleExclamationPoint,
  danger: CircleExclamationPoint,
} as const;

/** Inline, persistent message within a page or form. */
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  live = false,
  className,
}: CalloutProps) {
  const Icon = ICONS[tone];
  return (
    <div className={cx(styles.callout, styles[tone], className)} role={live ? 'status' : undefined}>
      <Icon className={styles.icon} aria-hidden="true" />
      <div className={styles.text}>
        {title ? <p className={styles.title}>{title}</p> : null}
        {children ? <div className={styles.body}>{children}</div> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
