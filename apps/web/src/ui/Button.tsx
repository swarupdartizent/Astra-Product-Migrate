import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '@/lib/cx';
import styles from './Button.module.css';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the width stable and blocks clicks. */
  loading?: boolean;
  /** Icon before the label. */
  leadingIcon?: ReactNode;
  /** Icon after the label. */
  trailingIcon?: ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  /** Render the child element (e.g. a router Link) with button styling. */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  leadingIcon,
  trailingIcon,
  block = false,
  asChild = false,
  className,
  disabled,
  children,
  type,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    block && styles.block,
    className,
  );

  if (asChild) {
    return (
      <Slot className={classes} ref={ref} {...rest}>
        {children}
      </Slot>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      onClick={loading ? (event) => event.preventDefault() : onClick}
      {...rest}
    >
      <span className={styles.content} data-hidden={loading || undefined}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
      {loading ? (
        <span className={styles.spinnerSlot}>
          <Spinner size={size === 'sm' ? 14 : 16} />
        </span>
      ) : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonProps,
  'leadingIcon' | 'trailingIcon' | 'block'
> {
  /** Required accessible name; icon-only buttons have no visible text. */
  label: string;
  icon: ReactNode;
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      variant={variant}
      size={size}
      className={cx(styles.icon, className)}
      {...rest}
    >
      {icon}
    </Button>
  );
}
