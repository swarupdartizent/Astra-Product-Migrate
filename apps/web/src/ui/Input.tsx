import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '@/lib/cx';
import styles from './controls.module.css';
import { useFieldControl } from './field-context';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md' | 'lg';
  /** Decorative icon inside the start of the input. */
  startAdornment?: ReactNode;
  /** Decorative icon inside the end of the input. */
  endAdornment?: ReactNode;
  /** Monospace text, for identifiers and codes. */
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({
  size = 'md',
  startAdornment,
  endAdornment,
  mono = false,
  className,
  type = 'text',
  ...props
}: InputProps) {
  const fieldProps = useFieldControl(props);
  const input = (
    <input
      type={type}
      className={cx(
        styles.control,
        size !== 'md' && styles[size],
        mono && styles.mono,
        startAdornment != null && styles.hasStart,
        endAdornment != null && styles.hasEnd,
        className,
      )}
      {...fieldProps}
    />
  );
  if (startAdornment == null && endAdornment == null) return input;
  return (
    <span className={styles.wrapper}>
      {startAdornment != null ? (
        <span className={cx(styles.adornment, styles.adornmentStart)} aria-hidden="true">
          {startAdornment}
        </span>
      ) : null}
      {input}
      {endAdornment != null ? (
        <span className={cx(styles.adornment, styles.adornmentEnd)} aria-hidden="true">
          {endAdornment}
        </span>
      ) : null}
    </span>
  );
}
