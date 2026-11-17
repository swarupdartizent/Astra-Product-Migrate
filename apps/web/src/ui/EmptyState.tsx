import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './State.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  /** One clear next step, e.g. a primary Button. */
  action?: ReactNode;
  /** Tighter spacing for use inside cards and tables. */
  compact?: boolean;
  /** Heading level for the title, to fit the page outline. */
  headingLevel?: 1 | 2 | 3 | 4;
  className?: string;
}

/** Explains why there is nothing here and what to do about it. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  compact = false,
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx(styles.state, compact && styles.compact, className)}>
      {icon ? (
        <div className={styles.icon} aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <Heading className={styles.title}>{title}</Heading>
      {body ? <p className={styles.body}>{body}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
