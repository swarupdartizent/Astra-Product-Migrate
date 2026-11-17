import { LoaderCircle } from 'lucide-react';
import { cx } from '@/lib/cx';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Accessible label. Omit when a parent already announces the busy state. */
  label?: string;
  size?: number;
  className?: string;
}

export function Spinner({ label, size = 16, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, className)}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
    >
      <LoaderCircle width={size} height={size} aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
