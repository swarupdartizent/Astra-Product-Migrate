import { RefreshCw, TriangleExclamationPoint } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Button } from './Button';
import styles from './State.module.css';

export interface ErrorStateProps {
  title?: ReactNode;
  /** What went wrong, in plain language. */
  body?: ReactNode;
  /** Technical reference shown in monospace (status, problem type, request id). */
  reference?: ReactNode;
  icon?: ReactNode;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Extra actions beside (or instead of) retry. */
  actions?: ReactNode;
  tone?: 'danger' | 'warning' | 'neutral';
  compact?: boolean;
  headingLevel?: 1 | 2 | 3 | 4;
  className?: string;
}

/** A real failure, stated honestly, with a way forward. Announced to screen readers. */
export function ErrorState({
  title = 'Something went wrong',
  body,
  reference,
  icon,
  onRetry,
  retrying = false,
  actions,
  tone = 'danger',
  compact = false,
  headingLevel = 3,
  className,
}: ErrorStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      role="alert"
      className={cx(styles.state, styles[tone], compact && styles.compact, className)}
    >
      <div className={styles.icon} aria-hidden="true">
        {icon ?? <TriangleExclamationPoint />}
      </div>
      <Heading className={styles.title}>{title}</Heading>
      {body ? <p className={styles.body}>{body}</p> : null}
      {reference ? <p className={styles.reference}>{reference}</p> : null}
      {onRetry || actions ? (
        <div className={styles.action}>
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRetry}
              loading={retrying}
              leadingIcon={<RefreshCw aria-hidden="true" />}
            >
              Try again
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
