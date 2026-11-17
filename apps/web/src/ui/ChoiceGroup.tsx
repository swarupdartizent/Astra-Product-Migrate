import { useId, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Checkbox } from './Checkbox';
import styles from './ChoiceGroup.module.css';

export interface Choice<T extends string = string> {
  value: T;
  label: ReactNode;
  /** One line under the label. */
  description?: ReactNode;
  disabled?: boolean;
}

interface GroupBase {
  /** Visible group label (rendered as the fieldset legend). */
  legend: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  /** Id for the fieldset, so validation messages can focus the group. */
  id?: string;
  className?: string;
}

export interface CheckboxGroupProps<T extends string> extends GroupBase {
  options: readonly Choice<T>[];
  value: readonly T[];
  onValueChange: (value: T[]) => void;
  /** Limit the height and scroll long lists. */
  maxHeight?: string;
  /** Shown when there are no options. */
  emptyText?: ReactNode;
}

/** Several independent choices (e.g. roles, packs), with fieldset/legend semantics. */
export function CheckboxGroup<T extends string>({
  legend,
  help,
  error,
  disabled = false,
  id,
  className,
  options,
  value,
  onValueChange,
  maxHeight,
  emptyText = 'Nothing to choose from.',
}: CheckboxGroupProps<T>) {
  const base = useId();
  const helpId = help ? `${base}-help` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  return (
    <fieldset
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cx(styles.group, className)}
      disabled={disabled}
      aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className={styles.legend}>{legend}</legend>
      {help ? (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      ) : null}
      {options.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <div className={styles.list} style={maxHeight ? { maxHeight } : undefined}>
          {options.map((option) => {
            const optionId = `${base}-${option.value}`;
            const checked = value.includes(option.value);
            return (
              <div key={option.value} className={styles.item}>
                <Checkbox
                  id={optionId}
                  checked={checked}
                  disabled={disabled || option.disabled}
                  onCheckedChange={(next) =>
                    onValueChange(
                      next === true
                        ? [...value, option.value]
                        : value.filter((v) => v !== option.value),
                    )
                  }
                  aria-describedby={option.description ? `${optionId}-d` : undefined}
                />
                <label htmlFor={optionId} className={styles.itemText}>
                  <span className={styles.itemLabel}>{option.label}</span>
                  {option.description ? (
                    <span id={`${optionId}-d`} className={styles.itemDescription}>
                      {option.description}
                    </span>
                  ) : null}
                </label>
              </div>
            );
          })}
        </div>
      )}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export interface RadioCardsProps<T extends string> extends GroupBase {
  options: readonly Choice<T>[];
  value: T | '';
  onValueChange: (value: T) => void;
  name?: string;
}

/** One choice among a few, each explained in a sentence. Native radios: arrow keys work. */
export function RadioCards<T extends string>({
  legend,
  help,
  error,
  disabled = false,
  id,
  className,
  options,
  value,
  onValueChange,
  name,
}: RadioCardsProps<T>) {
  const base = useId();
  const groupName = name ?? base;
  const helpId = help ? `${base}-help` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  return (
    <fieldset
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cx(styles.group, className)}
      disabled={disabled}
      aria-describedby={[helpId, errorId].filter(Boolean).join(' ') || undefined}
    >
      <legend className={styles.legend}>{legend}</legend>
      {help ? (
        <p id={helpId} className={styles.help}>
          {help}
        </p>
      ) : null}
      <div className={styles.cards}>
        {options.map((option) => {
          const optionId = `${base}-${option.value}`;
          return (
            <label key={option.value} htmlFor={optionId} className={styles.card}>
              <input
                id={optionId}
                type="radio"
                name={groupName}
                value={option.value}
                checked={value === option.value}
                disabled={disabled || option.disabled}
                onChange={() => onValueChange(option.value)}
                className={styles.radio}
              />
              <span className={styles.itemText}>
                <span className={styles.itemLabel}>{option.label}</span>
                {option.description ? (
                  <span className={styles.itemDescription}>{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
