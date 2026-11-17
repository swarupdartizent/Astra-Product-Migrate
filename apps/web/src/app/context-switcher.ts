import { createContext, useContext, useEffect, type ReactNode } from 'react';

/**
 * The top bar reserves a slot for a "current context" switcher (e.g. tenant or project).
 * Nothing is registered yet. A feature that introduces a context calls
 * `useContextSwitcher(<TenantSwitcher />)` from a component rendered inside the app shell;
 * the slot renders it and clears it on unmount.
 */
export interface ContextSwitcherSlotValue {
  setContent: (content: ReactNode) => void;
}

export const ContextSwitcherContext = createContext<ContextSwitcherSlotValue | null>(null);

export function useContextSwitcher(content: ReactNode): void {
  const slot = useContext(ContextSwitcherContext);
  useEffect(() => {
    if (!slot) return;
    slot.setContent(content);
    return () => slot.setContent(null);
  }, [slot, content]);
}
