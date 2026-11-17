import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { IconButton } from './Button';
import styles from './Dialog.module.css';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export interface DialogContentProps {
  /** Required: every dialog has an accessible name. */
  title: ReactNode;
  /** Optional sentence under the title; linked as the accessible description. */
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the corner close button (e.g. while a blocking action runs). */
  hideClose?: boolean;
  /** Prevent closing with Escape / outside click (e.g. during submission). */
  dismissible?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Modal dialog: focus is trapped, Escape closes, focus returns to the trigger. */
export function DialogContent({
  title,
  description,
  size = 'md',
  hideClose = false,
  dismissible = true,
  className,
  children,
}: DialogContentProps) {
  const block = (event: Event) => {
    if (!dismissible) event.preventDefault();
  };
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={styles.overlay} />
      <RadixDialog.Content
        className={cx(styles.content, styles[size], className)}
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <div className={styles.header}>
          <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          ) : null}
        </div>
        {children}
        {!hideClose ? (
          <RadixDialog.Close asChild>
            <IconButton
              className={styles.close}
              label="Close"
              size="sm"
              icon={<X aria-hidden="true" />}
              disabled={!dismissible}
            />
          </RadixDialog.Close>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.body, className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
