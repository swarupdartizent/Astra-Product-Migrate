import { createContext } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  /** What the user chose. "system" follows the OS. */
  preference: ThemePreference;
  /** What is actually on screen. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Switches between light and dark, pinning an explicit preference. */
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);
