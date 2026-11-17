import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { Check, Circle } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './DropdownMenu.module.css';

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;
export const DropdownMenuRadioGroup = RadixMenu.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'end',
  ...rest
}: ComponentPropsWithRef<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        className={cx(styles.content, className)}
        sideOffset={sideOffset}
        align={align}
        {...rest}
      />
    </RadixMenu.Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentPropsWithRef<typeof RadixMenu.Item> {
  icon?: ReactNode;
  shortcut?: ReactNode;
  tone?: 'default' | 'danger';
}

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  tone = 'default',
  children,
  ...rest
}: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item
      className={cx(styles.item, tone === 'danger' && styles.danger, className)}
      {...rest}
    >
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.itemLabel}>{children}</span>
      {shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
    </RadixMenu.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...rest
}: ComponentPropsWithRef<typeof RadixMenu.CheckboxItem>) {
  return (
    <RadixMenu.CheckboxItem className={cx(styles.item, styles.indented, className)} {...rest}>
      <RadixMenu.ItemIndicator className={styles.indicator}>
        <Check aria-hidden="true" />
      </RadixMenu.ItemIndicator>
      <span className={styles.itemLabel}>{children}</span>
    </RadixMenu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  icon,
  ...rest
}: ComponentPropsWithRef<typeof RadixMenu.RadioItem> & { icon?: ReactNode }) {
  return (
    <RadixMenu.RadioItem className={cx(styles.item, className)} {...rest}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className={styles.itemLabel}>{children}</span>
      <RadixMenu.ItemIndicator className={styles.trailingIndicator}>
        <Circle aria-hidden="true" />
      </RadixMenu.ItemIndicator>
    </RadixMenu.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...rest
}: ComponentPropsWithRef<typeof RadixMenu.Label>) {
  return <RadixMenu.Label className={cx(styles.label, className)} {...rest} />;
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentPropsWithRef<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cx(styles.separator, className)} {...rest} />;
}
