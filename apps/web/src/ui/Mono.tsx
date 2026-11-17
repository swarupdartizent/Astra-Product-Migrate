import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { CopyButton } from './CopyButton';
import styles from './Mono.module.css';

export interface MonoProps extends HTMLAttributes<HTMLElement> {
  /** Subtle background chip, for inline identifiers. */
  chip?: boolean;
  /** Truncate with an ellipsis instead of wrapping. */
  truncate?: boolean;
}

/** Inline monospace text for identifiers, versions, hashes. */
export function Mono({ chip = false, truncate = false, className, ...rest }: MonoProps) {
  return (
    <code
      className={cx(styles.mono, chip && styles.chip, truncate && styles.truncate, className)}
      {...rest}
    />
  );
}

export interface CodeBlockProps {
  /** Exact text; also what the copy button copies. */
  code: string;
  /** Short label shown in the header (e.g. "JSON", "SQL", a filename). */
  label?: ReactNode;
  /** Show a copy button (default true). */
  copyable?: boolean;
  /** Limit height and scroll. */
  maxHeight?: number | string;
  className?: string;
}

/** Preformatted, horizontally scrollable block of code or data. */
export function CodeBlock({ code, label, copyable = true, maxHeight, className }: CodeBlockProps) {
  return (
    <div className={cx(styles.block, className)}>
      {label || copyable ? (
        <div className={styles.blockHeader}>
          <span className={styles.blockLabel}>{label}</span>
          {copyable ? <CopyButton value={code} label="Copy code" size="sm" /> : null}
        </div>
      ) : null}
      {/* Scrollable region must be keyboard-focusable so its content can be scrolled. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <pre className={styles.pre} style={maxHeight ? { maxHeight } : undefined} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
