import { Outlet, useRouterState } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMe } from '@/api/queries';
import { useAuth } from '@/auth/useAuth';
import { modKeyLabel } from '@/lib/platform';
import { readStorage, storageKeys, writeStorage } from '@/lib/storage';
import { Kbd } from '@/ui';
import styles from './AppShell.module.css';
import { CommandPalette } from './CommandPalette';
import { ContextSwitcherContext } from './context-switcher';
import { groupNavItems, visibleNavItems } from './navigation';
import { usePermissions } from './permissions';
import { Sidebar } from './Sidebar';
import { useMediaQuery } from './useMediaQuery';
import { UserMenu } from './UserMenu';

const NARROW_QUERY = '(max-width: 47.99rem)';

/** Authenticated layout: sidebar, top bar, command palette and the routed page. */
export function AppShell() {
  const auth = useAuth();
  const me = useMe();
  const { permissions } = usePermissions();
  const narrow = useMediaQuery(NARROW_QUERY);

  const [collapsedPref, setCollapsedPref] = useState(
    () => readStorage(storageKeys.sidebarCollapsed) === 'true',
  );
  const collapsed = narrow || collapsedPref;
  const toggleSidebar = useCallback(() => {
    setCollapsedPref((prev) => {
      writeStorage(storageKeys.sidebarCollapsed, String(!prev));
      return !prev;
    });
  }, []);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [contextSwitcher, setContextSwitcher] = useState<ReactNode>(null);
  const slot = useMemo(() => ({ setContent: setContextSwitcher }), []);

  const navItems = useMemo(() => visibleNavItems(permissions), [permissions]);
  const navGroups = useMemo(() => groupNavItems(navItems), [navItems]);

  const signOut = useCallback(() => {
    void auth.signOut();
  }, [auth]);

  // Global Ctrl/⌘+K opens the command palette.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Move focus to the main region after client-side navigation so screen reader and keyboard
  // users start at the new page content (the initial load keeps the browser default).
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = '';
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  const identity = {
    name: me.data?.display_name ?? auth.user?.name ?? null,
    email: me.data?.email ?? auth.user?.email ?? null,
  };

  return (
    <ContextSwitcherContext.Provider value={slot}>
      <div className={styles.shell} data-collapsed={collapsed || undefined}>
        <a href="#main" className={styles.skipLink}>
          Skip to content
        </a>
        <Sidebar
          groups={navGroups}
          collapsed={collapsed}
          canToggle={!narrow}
          onToggle={toggleSidebar}
        />
        <div className={styles.main}>
          <header className={styles.topbar}>
            <div className={styles.contextSlot} data-empty={contextSwitcher ? undefined : true}>
              {contextSwitcher}
            </div>
            <div className={styles.topbarEnd}>
              <button
                type="button"
                className={styles.paletteTrigger}
                onClick={() => setPaletteOpen(true)}
                aria-keyshortcuts="Control+K Meta+K"
                aria-haspopup="dialog"
                aria-label="Search or jump to…"
              >
                <Search aria-hidden="true" className={styles.paletteIcon} />
                <span className={styles.paletteLabel}>Search or jump to…</span>
                <span className={styles.paletteKeys} aria-hidden="true">
                  <Kbd>{modKeyLabel()}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              </button>
              <UserMenu identity={identity} onSignOut={signOut} />
            </div>
          </header>
          <main id="main" ref={mainRef} tabIndex={-1} className={styles.content}>
            <div className={styles.contentInner}>
              <Outlet />
            </div>
          </main>
        </div>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          navItems={navItems}
          onSignOut={signOut}
        />
      </div>
    </ContextSwitcherContext.Provider>
  );
}
