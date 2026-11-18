import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface PlainTextProps {
  /** Text only. Model output and legacy data are always rendered as text, never as markup. */
  children: string | null | undefined;
  /** Optional accessible name for the scroll region. */
  label?: string;
  className?: string;
  /** Shown when the text is empty. */
  empty?: ReactNode;
}

/**
 * Verbatim text (whitespace kept, long words wrapped) in a scrollable, keyboard-focusable box.
 * React escapes the string, so nothing in it can become HTML.
 */
export function PlainText({ children, label, className, empty = null }: PlainTextProps) {
  if (!children) return <>{empty}</>;
  return (
    <pre
      className={cx('plain-text', className)}
      // Scrollable content must be reachable by keyboard.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={label}
    >
      {children}
    </pre>
  );
}
