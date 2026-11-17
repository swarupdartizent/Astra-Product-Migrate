import { CircleExclamationPoint } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { FieldContext } from './field-context';
import styles from './Field.module.css';

export interface FieldProps {
  label: ReactNode;
  /** Helper text shown under the control and linked with aria-describedby. */
  help?: ReactNode;
  /** Error message; marks the control aria-invalid and is announced with it. */
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Visually hide the label (it stays available to assistive technology). */
  hideLabel?: boolean;
  /** Put the label beside the control (checkbox / switch). */
  inline?: boolean;
  className?: string;
  /** Exactly one form control from this design system (Input, Textarea, Select, Checkbox, Switch). */
  children: ReactNode;
}

/** Label, help and error wiring for a single form control. */
export function Field({
  label,
  help,
  error,
  required = false,
  disabled = false,
  hideLabel = false,
  inline = false,
  className,
  children,
}: FieldProps) {
  const baseId = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const ctx = useMemo(
    () => ({
      controlId: `${baseId}-control`,
      labelId: `${baseId}-label`,
      helpId: help ? `${baseId}-help` : undefined,
      errorId: hasError ? `${baseId}-error` : undefined,
      invalid: hasError,
      required,
      disabled,
    }),
    [baseId, help, hasError, required, disabled],
  );

  const labelEl = (
    <label
      id={ctx.labelId}
      htmlFor={ctx.controlId}
      className={cx(styles.label, hideLabel && 'sr-only', disabled && styles.labelDisabled)}
    >
      {label}
      {required ? (
        <span className={styles.required} aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );

  return (
    <FieldContext.Provider value={ctx}>
      <div className={cx(styles.field, inline && styles.inline, className)}>
        {inline ? (
          <div className={styles.inlineRow}>
            {children}
            {labelEl}
          </div>
        ) : (
          <>
            {labelEl}
            {children}
          </>
        )}
        {help ? (
          <p id={ctx.helpId} className={styles.help}>
            {help}
          </p>
        ) : null}
        {hasError ? (
          <p id={ctx.errorId} className={styles.error}>
            <CircleExclamationPoint aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
