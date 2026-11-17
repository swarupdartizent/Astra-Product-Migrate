import type { HTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Mono.module.css';

/** Keyboard key, e.g. <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx(styles.kbd, className)} {...rest} />;
}
