/**
 * Safe wrappers around localStorage. Storage can be unavailable or throw (private browsing,
 * blocked site data, quota). Callers always get a usable fallback and the UI still renders.
 * Use only for per-user conveniences (theme, sidebar state), never for state that must persist.
 */

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignore: preference simply will not persist.
  }
}

export const storageKeys = {
  theme: 'astra.theme',
  sidebarCollapsed: 'astra.sidebar.collapsed',
} as const;
