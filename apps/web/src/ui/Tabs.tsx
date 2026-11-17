import * as RadixTabs from '@radix-ui/react-tabs';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Tabs.module.css';

export type TabsProps = ComponentPropsWithRef<typeof RadixTabs.Root>;

/** Switches between views of the same object. Arrow keys move between tabs. */
export function Tabs({ className, ...rest }: TabsProps) {
  return <RadixTabs.Root className={cx(styles.root, className)} {...rest} />;
}

export interface TabsListProps extends ComponentPropsWithRef<typeof RadixTabs.List> {
  /** Accessible name for the tab list, e.g. "Tenant sections". */
  'aria-label': string;
}

export function TabsList({ className, ...rest }: TabsListProps) {
  return <RadixTabs.List className={cx(styles.list, className)} {...rest} />;
}

export interface TabProps extends ComponentPropsWithRef<typeof RadixTabs.Trigger> {
  /** Optional count or badge after the label. */
  badge?: ReactNode;
}

export function Tab({ className, children, badge, ...rest }: TabProps) {
  return (
    <RadixTabs.Trigger className={cx(styles.tab, className)} {...rest}>
      {children}
      {badge !== undefined ? <span className={styles.badge}>{badge}</span> : null}
    </RadixTabs.Trigger>
  );
}

export function TabPanel({ className, ...rest }: ComponentPropsWithRef<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cx(styles.panel, className)} {...rest} />;
}
