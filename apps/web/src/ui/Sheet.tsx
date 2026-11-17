import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { IconButton } from './Button';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required accessible name, shown as the panel heading. */
  title: ReactNode;
  description?: ReactNode;
  /** Controls in the header, before the close button. */
  actions?: ReactNode;
  size?: 'md' | 'lg';
  children?: ReactNode;
  className?: string;
}

/**
 * Side panel for inspecting a record without leaving the list (modal: focus is trapped,
 * Escape closes, focus returns to the row that opened it).
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  actions,
  size = 'md',
  children,
  className,
}: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={cx(styles.content, styles[size], className)}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={styles.header}>
            <div className={styles.heading}>
              <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className={styles.description}>
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <div className={styles.actions}>
              {actions}
              <RadixDialog.Close asChild>
                <IconButton label="Close panel" size="sm" icon={<X aria-hidden="true" />} />
              </RadixDialog.Close>
            </div>
          </div>
          <div className={styles.body}>{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
