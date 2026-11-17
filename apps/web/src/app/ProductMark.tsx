import { cx } from '@/lib/cx';
import styles from './ProductMark.module.css';

export interface ProductMarkProps {
  /** Show the "Astra Migrate" wordmark next to the logo. */
  showName?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}

export function ProductMark({ showName = true, size = 'md', className }: ProductMarkProps) {
  return (
    <span className={cx(styles.mark, styles[size], className)}>
      <svg className={styles.logo} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
        <path
          d="M16 6.5 24.5 25h-4l-1.6-3.7h-5.8L11.5 25h-4L16 6.5Zm0 8.4-1.8 4.3h3.6L16 14.9Z"
          fill="#fff"
        />
      </svg>
      {showName ? (
        <span className={styles.name}>Astra Migrate</span>
      ) : (
        <span className="sr-only">Astra Migrate</span>
      )}
    </span>
  );
}
