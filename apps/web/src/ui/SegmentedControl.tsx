import { useId, useRef, type KeyboardEvent } from 'react';
import { cx } from '@/lib/cx';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name for the group, e.g. "Group by". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Single choice among a few views (radio group semantics: one tab stop, arrow keys move and
 * select).
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onValueChange,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : options.length - 1;
      const option = options[target];
      if (option) {
        onValueChange(option.value);
        refs.current[target]?.focus();
      }
      return;
    }
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (option) {
      onValueChange(option.value);
      refs.current[next]?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(styles.group, size === 'sm' && styles.sm, className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            name={name}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={styles.option}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
