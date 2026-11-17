import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './KeyValueList.module.css';

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  /** Render "—" with an accessible "Not set" when null or undefined. */
  value: ReactNode;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  /** "row": label beside value (default). "stack": label above value. */
  layout?: 'row' | 'stack';
  className?: string;
}

/** Description list for record attributes. */
export function KeyValueList({ items, layout = 'row', className }: KeyValueListProps) {
  return (
    <dl className={cx(styles.list, styles[layout], className)}>
      {items.map((item) => (
        <div key={item.key} className={styles.item}>
          <dt className={styles.label}>{item.label}</dt>
          <dd className={styles.value}>
            {item.value === null || item.value === undefined || item.value === '' ? (
              <span className={styles.empty}>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Not set</span>
              </span>
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
