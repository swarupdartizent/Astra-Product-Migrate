import * as RadixDialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { LogOut, Moon, Search, Sun } from 'lucide-react';
import { useTheme } from '@/theme/useTheme';
import { Kbd } from '@/ui';
import type { NavItem } from './navigation';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigation entries the user may see (already permission-filtered). */
  navItems: readonly NavItem[];
  onSignOut: () => void;
}

/** Ctrl/⌘+K launcher: jump to any page the user can access, plus global actions. */
export function CommandPalette({ open, onOpenChange, navItems, onSignOut }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { resolved, toggle } = useTheme();

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content className={styles.content} aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <Command label="Command palette" className={styles.command} loop>
            <div className={styles.inputRow}>
              <Search className={styles.inputIcon} aria-hidden="true" />
              <Command.Input
                className={styles.input}
                placeholder="Type a command or search…"
                aria-label="Search commands"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className={styles.list}>
              <Command.Empty className={styles.empty}>No matching commands.</Command.Empty>
              {navItems.length > 0 ? (
                <Command.Group heading="Go to" className={styles.group}>
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Command.Item
                        key={item.id}
                        value={`go ${item.label}`}
                        keywords={[...(item.keywords ?? [])]}
                        className={styles.item}
                        onSelect={() => run(() => void navigate({ to: item.to }))}
                      >
                        <Icon className={styles.itemIcon} aria-hidden="true" />
                        {item.label}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              <Command.Group heading="Actions" className={styles.group}>
                <Command.Item
                  value="toggle theme"
                  keywords={['dark', 'light', 'appearance', 'mode']}
                  className={styles.item}
                  onSelect={() => run(toggle)}
                >
                  {resolved === 'dark' ? (
                    <Sun className={styles.itemIcon} aria-hidden="true" />
                  ) : (
                    <Moon className={styles.itemIcon} aria-hidden="true" />
                  )}
                  Toggle theme
                  <span className={styles.itemHint}>
                    Switch to {resolved === 'dark' ? 'light' : 'dark'}
                  </span>
                </Command.Item>
                <Command.Item
                  value="sign out"
                  keywords={['log out', 'logout', 'exit']}
                  className={styles.item}
                  onSelect={() => run(onSignOut)}
                >
                  <LogOut className={styles.itemIcon} aria-hidden="true" />
                  Sign out
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
