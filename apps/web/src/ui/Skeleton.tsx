import type { CSSProperties } from 'react';
import { cx } from '@/lib/cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  /** Rounded pill shape (avatars, badges). */
  circle?: boolean;
  className?: string;
}

/**
 * Placeholder shape while content loads. Decorative: the loading container should carry
 * aria-busy and an accessible "Loading…" message.
 */
export function Skeleton({ width, height = '0.875rem', circle = false, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, circle && styles.circle, className)}
      style={{ width, height }}
    />
  );
}
