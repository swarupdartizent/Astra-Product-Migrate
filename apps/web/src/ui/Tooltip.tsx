import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';
import styles from './Tooltip.module.css';

/** Mount once near the root. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link). It must forward refs and DOM props. */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Optional keyboard shortcut hint rendered after the content. */
  shortcut?: ReactNode;
  /** Render nothing extra and just return the trigger (e.g. when a label is already visible). */
  disabled?: boolean;
}

/**
 * Supplementary hint on hover and keyboard focus. Never put essential information only in a
 * tooltip; icon-only buttons still need their own aria-label.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  shortcut,
  disabled = false,
}: TooltipProps) {
  if (disabled) return children;
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.content} side={side} align={align} sideOffset={6}>
          {content}
          {shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
