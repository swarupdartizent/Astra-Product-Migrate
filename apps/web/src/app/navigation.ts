import type { LinkProps } from '@tanstack/react-router';
import {
  Activity,
  Database,
  FlaskConical,
  Network,
  Plug,
  Bot,
  Building2,
  Cpu,
  FileCode,
  FolderKanban,
  House,
  Package,
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

export type NavGroupId = 'overview' | 'platform' | 'configuration' | 'ai' | 'governance';

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
  /**
   * Exact API permission code required to see this entry; a list means any one of them;
   * null means any signed-in user.
   */
  permission: string | readonly string[] | null;
  group: NavGroupId;
  /** Match the route exactly (true for "/"); otherwise child routes keep it active. */
  exact?: boolean;
  /** Extra search terms for the command palette. */
  keywords?: readonly string[];
}

export const navGroups: readonly NavGroup[] = [
  { id: 'overview' },
  { id: 'platform', label: 'Platform' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'ai', label: 'AI' },
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
    id: 'packs',
    to: '/packs',
    label: 'Pack library',
    description:
      'Browse adapter, domain, compliance and pattern packs; upload, test and publish them.',
    icon: Package,
    permission: null,
    group: 'configuration',
    keywords: ['adapters', 'compliance', 'controls', 'compose'],
  },
  {
    id: 'adapters',
    to: '/adapters',
    label: 'Adapters',
    description: 'Source and target adapters, the adapter contract, traps and target constraints.',
    icon: Plug,
    permission: null,
    group: 'configuration',
    keywords: ['source', 'target', 'contract', 'traps', 'constraints'],
  },
  {
    id: 'golden',
    to: '/golden',
    label: 'Golden datasets',
    description: 'Run adapters against golden datasets and read the scorecard.',
    icon: FlaskConical,
    permission: null,
    group: 'configuration',
    keywords: ['golden', 'scorecard', 'precision', 'recall', 'measure'],
  },
  {
    id: 'baselines',
    to: '/baselines',
    label: 'Baselines',
    description: 'Immutable target metadata baselines that projects design against.',
    icon: Database,
    permission: null,
    group: 'configuration',
    keywords: ['target', 'metadata', 'schema', 'synthetic'],
  },
  {
    id: 'ontology',
    to: '/ontology',
    label: 'Ontology',
    description: 'Browse and search business concepts, their rules, bindings and precedents.',
    icon: Network,
    permission: null,
    group: 'configuration',
    keywords: ['concepts', 'glossary', 'domain', 'bindings', 'rules'],
  },
  {
    id: 'templates',
    to: '/templates',
    label: 'Templates',
    description: 'Blueprint templates that new projects can start from.',
    icon: FileCode,
    permission: null,
    group: 'configuration',
    keywords: ['blueprint', 'starter'],
  },
  {
    id: 'agents',
    to: '/agents',
    label: 'Agents',
    description: 'Registered agents, their tools, limits, tests, release and governance records.',
    icon: Bot,
    // Any signed-in person with a role may view the registry; the API refuses everyone else.
    permission: null,
    group: 'ai',
    keywords: ['agent', 'manifest', 'guardrail', 'governance', 'release'],
  },
  {
    id: 'models',
    to: '/models',
    label: 'Models',
    description: 'Model providers, credentials, the aliases agents use, and model cost.',
    icon: Cpu,
    permission: ['model:manage', 'audit:read', 'observability:read'],
    group: 'ai',
    keywords: ['providers', 'aliases', 'cost', 'usage', 'llm'],
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

/** True when `required` is null, or the user holds it (or any one of a list). */
export function holdsAny(
  permissions: ReadonlySet<string>,
  required: string | readonly string[] | null,
): boolean {
  if (required === null) return true;
  if (typeof required === 'string') return permissions.has(required);
  return required.some((p) => permissions.has(p));
}

/** Entries the user may see, in registry order. */
export function visibleNavItems(
  permissions: ReadonlySet<string>,
  items: readonly NavItem[] = navItems,
): NavItem[] {
  return items.filter((item) => holdsAny(permissions, item.permission));
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
