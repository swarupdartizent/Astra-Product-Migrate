import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface PlainTextProps {
  /** Text only. Model output, code and legacy data are always rendered as text, never as markup. */
  children: string | null | undefined;
  /** Optional accessible name for the scroll region. */
  label?: string;
  className?: string;
  /** Shown when the text is empty. */
  empty?: ReactNode;
  /** Number the lines (for source code). */
  lineNumbers?: boolean;
}

/**
 * Verbatim text (whitespace kept) in a scrollable, keyboard-focusable box. React escapes the
 * string, so nothing in it can become HTML.
 */
export function PlainText({
  children,
  label,
  className,
  empty = null,
  lineNumbers = false,
}: PlainTextProps) {
  if (!children) return <>{empty}</>;
  if (lineNumbers) {
    const lines = children.replace(/\r\n/g, '\n').split('\n');
    const width = String(lines.length).length;
    return (
      <pre
        className={cx('plain-text', 'plain-text-code', className)}
        // Scrollable content must be reachable by keyboard.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={label}
      >
        {lines.map((line, i) => (
          <span key={i} className="plain-text-line">
            <span className="plain-text-number" aria-hidden="true">
              {String(i + 1).padStart(width, ' ')}
            </span>
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    );
  }
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
