import { cx } from '@/lib/cx';
import styles from './ProgressBar.module.css';

export interface ProgressBarProps {
  /** 0–100; omit for an indeterminate bar. */
  value?: number;
  /** Accessible name, e.g. "Provisioning progress". */
  label: string;
  /** Spoken value text, e.g. "40%, building the database". */
  valueText?: string;
  tone?: 'accent' | 'success' | 'danger';
  className?: string;
}

export function ProgressBar({
  value,
  label,
  valueText,
  tone = 'accent',
  className,
}: ProgressBarProps) {
  const clamped = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      className={cx(styles.track, className)}
    >
      <div
        className={cx(styles.fill, clamped === undefined && styles.indeterminate)}
        data-tone={tone}
        style={clamped === undefined ? undefined : { width: `${clamped}%` }}
      />
    </div>
  );
}
