import type { LinkProps } from '@tanstack/react-router';
import {
  Activity,
  Building2,
  FolderKanban,
  House,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Navigation registry: the single source of truth for the sidebar, the command palette and the
 * Home "Get started" card.
 *
 * An entry is shown only when the signed-in user holds `permission` (from GET /api/v1/me).
 * Permission codes are the exact strings the API uses, with a colon: "tenant:read".
 * `permission: null` means any signed-in user. Register an entry only when its page exists
 * and talks to a real API; never add placeholders for features that are not built.
 */

export type NavGroupId = 'overview' | 'platform' | 'governance';

export interface NavGroup {
  id: NavGroupId;
  /** Visible group heading. Omit for the top, unlabelled group. */
  label?: string;
}

export interface NavItem {
  /** Stable id, used as React key and for tests. */
  id: string;
  /** Route path; must be a route registered in src/app/router.tsx. */
  to: LinkProps['to'];
  label: string;
  /** One sentence for the Home "Get started" card. */
  description?: string;
  icon: LucideIcon;
  /** Exact API permission code required to see this entry, or null for any signed-in user. */
  permission: string | null;
  group: NavGroupId;
  /** Match the route exactly (true for "/"); otherwise child routes keep it active. */
  exact?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: readonly string[];
}

export const navGroups: readonly NavGroup[] = [
  { id: 'overview' },
  { id: 'platform', label: 'Platform' },
  { id: 'governance', label: 'Governance' },
];

export const navItems: readonly NavItem[] = [
  {
    id: 'home',
    to: '/',
    label: 'Home',
    icon: House,
    permission: null,
    group: 'overview',
    exact: true,
    keywords: ['dashboard', 'start', 'status'],
  },
  {
    id: 'tenants',
    to: '/tenants',
    label: 'Tenants',
    description: 'Create tenants, set their security policy, manage connector secrets and regions.',
    icon: Building2,
    permission: 'tenant:read',
    group: 'platform',
    keywords: ['customers', 'workspaces', 'secrets', 'region'],
  },
  {
    id: 'programmes',
    to: '/programmes',
    label: 'Programmes',
    description: 'Group tenants into installed-base programmes and add delivery partners.',
    icon: FolderKanban,
    permission: 'tenant:read',
    group: 'platform',
    keywords: ['partners'],
  },
  {
    id: 'access',
    to: '/access',
    label: 'Access',
    description: 'Invite people and grant roles at the platform, programme, partner or tenant.',
    icon: Users,
    permission: 'access:read',
    group: 'governance',
    keywords: ['users', 'people', 'roles', 'permissions', 'invite'],
  },
  {
    id: 'audit',
    to: '/audit',
    label: 'Audit log',
    description: 'Search the write-once audit log, export it and verify its hash chain.',
    icon: ScrollText,
    permission: 'audit:read',
    group: 'governance',
    keywords: ['events', 'history', 'export', 'verify'],
  },
  {
    id: 'observability',
    to: '/observability',
    label: 'Observability',
    description: 'See where time goes, which operations fail and inspect individual traces.',
    icon: Activity,
    permission: 'observability:read',
    group: 'governance',
    keywords: ['traces', 'spans', 'latency', 'cost', 'jaeger'],
  },

  // How a feature registers:
  // 1. Add the route in src/app/router.tsx as a child of `appLayoutRoute`.
  // 2. Add an entry here with the exact permission code the API enforces, e.g. 'tenant:read'.
  // 3. Wrap the page in <RequirePermission permission="..."> so direct links are guarded too
  //    (the API remains the real enforcement point).
];

/** Entries the user may see, in registry order. */
export function visibleNavItems(
  permissions: ReadonlySet<string>,
  items: readonly NavItem[] = navItems,
): NavItem[] {
  return items.filter((item) => item.permission === null || permissions.has(item.permission));
}

/** Visible entries grouped for rendering; empty groups are dropped. */
export function groupNavItems(
  items: readonly NavItem[],
  groups: readonly NavGroup[] = navGroups,
): { group: NavGroup; items: NavItem[] }[] {
  return groups
    .map((group) => ({ group, items: items.filter((item) => item.group === group.id) }))
    .filter((entry) => entry.items.length > 0);
}
