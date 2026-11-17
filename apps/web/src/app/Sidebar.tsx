import { Link } from '@tanstack/react-router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cx } from '@/lib/cx';
import { IconButton, Tooltip } from '@/ui';
import type { NavGroup, NavItem } from './navigation';
import { ProductMark } from './ProductMark';
import styles from './AppShell.module.css';

export interface SidebarProps {
  groups: { group: NavGroup; items: NavItem[] }[];
  collapsed: boolean;
  /** Hidden on narrow viewports, where the sidebar is always an icon rail. */
  canToggle: boolean;
  onToggle: () => void;
}

export function Sidebar({ groups, collapsed, canToggle, onToggle }: SidebarProps) {
  return (
    <aside className={cx(styles.sidebar, collapsed && styles.sidebarCollapsed)}>
      <div className={styles.sidebarHeader}>
        <Link to="/" className={styles.brandLink} aria-label="Astra Migrate home">
          <ProductMark showName={!collapsed} />
        </Link>
      </div>
      <nav aria-label="Main" className={styles.nav}>
        {groups.map(({ group, items }) => (
          <div key={group.id} className={styles.navGroup}>
            {group.label ? (
              collapsed ? (
                <div className={styles.navDivider} role="presentation" />
              ) : (
                <h2 className={styles.navGroupLabel} id={`nav-${group.id}`}>
                  {group.label}
                </h2>
              )
            ) : null}
            <ul
              className={styles.navList}
              aria-labelledby={group.label && !collapsed ? `nav-${group.id}` : undefined}
            >
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Tooltip content={item.label} side="right" disabled={!collapsed}>
                      <Link
                        to={item.to}
                        activeOptions={{ exact: item.exact ?? false }}
                        className={styles.navLink}
                        aria-label={collapsed ? item.label : undefined}
                      >
                        <Icon className={styles.navIcon} aria-hidden="true" />
                        {!collapsed ? <span className={styles.navLabel}>{item.label}</span> : null}
                      </Link>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {canToggle ? (
        <div className={styles.sidebarFooter}>
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
            <IconButton
              label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              size="sm"
              icon={
                collapsed ? (
                  <PanelLeftOpen aria-hidden="true" />
                ) : (
                  <PanelLeftClose aria-hidden="true" />
                )
              }
              onClick={onToggle}
            />
          </Tooltip>
        </div>
      ) : null}
    </aside>
  );
}
