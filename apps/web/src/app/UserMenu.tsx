import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/theme/useTheme';
import type { ThemePreference } from '@/theme/context';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui';
import styles from './AppShell.module.css';

export interface UserIdentity {
  name: string | null;
  email: string | null;
}

function initials(identity: UserIdentity): string {
  const source = identity.name ?? identity.email ?? '';
  const words = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words.at(-1)?.[0] ?? ''}`
      : (words[0]?.slice(0, 2) ?? '');
  return letters.toUpperCase() || '?';
}

export interface UserMenuProps {
  identity: UserIdentity;
  onSignOut: () => void;
}

export function UserMenu({ identity, onSignOut }: UserMenuProps) {
  const { preference, setPreference } = useTheme();
  const display = identity.name ?? identity.email ?? 'Signed-in user';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={styles.userTrigger}>
        <span className={styles.avatar} aria-hidden="true">
          {initials(identity)}
        </span>
        <span className="sr-only">Account menu for {display}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className={styles.userMenu}>
        <div className={styles.userSummary}>
          <p className={styles.userName}>{display}</p>
          {identity.email && identity.email !== display ? (
            <p className={styles.userEmail}>{identity.email}</p>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => setPreference(value as ThemePreference)}
        >
          <DropdownMenuRadioItem value="system" icon={<Monitor />}>
            System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" icon={<Sun />}>
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" icon={<Moon />}>
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LogOut />} onSelect={onSignOut}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
