import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { safeReturnTo } from '@/auth/config';
import type { AuthContextValue } from '@/auth/context';
import { AccessPage } from '@/features/access/AccessPage';
import { AgentsPage } from '@/features/agents/AgentsPage';
import { AgentVersionPage } from '@/features/agents/AgentVersionPage';
import { AGENT_TABS, VERSION_TABS, type AgentsTab, type VersionTab } from '@/features/agents/model';
import { RegisterAgentPage } from '@/features/agents/RegisterAgentPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { MODEL_TABS, type ModelTab } from '@/features/models/tabs';
import { ProjectPage } from '@/features/blueprints/ProjectPage';
import { PROJECT_TABS, type ProjectTab } from '@/features/blueprints/tabs';
import { ComposePage } from '@/features/packs/ComposePage';
import { PackDetailPage } from '@/features/packs/PackDetailPage';
import { PackLibraryPage } from '@/features/packs/PackLibraryPage';
import { PACK_TABS, type PackTab } from '@/features/packs/tabs';
import { TemplatesPage } from '@/features/templates/TemplatesPage';
import { ObservabilityPage } from '@/features/observability/ObservabilityPage';
import { TraceDetailPage } from '@/features/observability/TraceDetailPage';
import { ProgrammesPage } from '@/features/programmes/ProgrammesPage';
import { TENANT_TABS, type TenantTab } from '@/features/tenants/model';
import { TenantDetailPage } from '@/features/tenants/TenantDetailPage';
import { TenantsPage } from '@/features/tenants/TenantsPage';
import { AuthCallbackPage } from '@/pages/AuthCallbackPage';
import { HomePage } from '@/pages/HomePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { RouteErrorPage } from '@/pages/RouteErrorPage';
import { SignInPage } from '@/pages/SignInPage';
import { AppShell } from './AppShell';

export interface RouterContext {
  queryClient: QueryClient;
  auth: AuthContextValue;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: RouteErrorPage,
});

// ---------- Public routes ----------

interface SignInSearch {
  redirect?: string;
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: ({ context, search }) => {
    if (context.auth.status === 'authenticated') {
      throw redirect({ href: safeReturnTo(search.redirect), replace: true });
    }
  },
  component: function SignInRoute() {
    const { redirect: returnTo } = signInRoute.useSearch();
    return <SignInPage returnTo={returnTo} />;
  },
});

const authCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallbackPage,
});

// ---------- Authenticated routes (inside the app shell) ----------

export const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: ({ context, location }) => {
    if (context.auth.status !== 'authenticated') {
      throw redirect({
        to: '/sign-in',
        search: location.href === '/' ? {} : { redirect: location.href },
        replace: true,
      });
    }
  },
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/',
  component: HomePage,
});

// Feature routes: children of appLayoutRoute, registered in src/app/navigation.ts.
// See README "Adding a feature page".

const tenantsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/tenants',
  component: TenantsPage,
});

interface TenantSearch {
  tab?: TenantTab;
}

const tenantDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/tenants/$tenantId',
  validateSearch: (search: Record<string, unknown>): TenantSearch =>
    TENANT_TABS.includes(search.tab as TenantTab) ? { tab: search.tab as TenantTab } : {},
  component: function TenantDetailRoute() {
    const { tenantId } = tenantDetailRoute.useParams();
    const { tab } = tenantDetailRoute.useSearch();
    return <TenantDetailPage tenantId={tenantId} tab={tab ?? 'overview'} />;
  },
});

const programmesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/programmes',
  component: ProgrammesPage,
});

const accessRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/access',
  component: AccessPage,
});

const auditRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/audit',
  component: AuditPage,
});

const observabilityRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/observability',
  component: ObservabilityPage,
});

const traceRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/observability/traces/$traceId',
  component: function TraceRoute() {
    const { traceId } = traceRoute.useParams();
    return <TraceDetailPage traceId={traceId} />;
  },
});

const packsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/packs',
  component: PackLibraryPage,
});

const composeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/packs/compose',
  component: ComposePage,
});

interface PackSearch {
  tab?: PackTab;
}

const packDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/packs/$name/$version',
  validateSearch: (search: Record<string, unknown>): PackSearch =>
    PACK_TABS.includes(search.tab as PackTab) ? { tab: search.tab as PackTab } : {},
  component: function PackDetailRoute() {
    const { name, version } = packDetailRoute.useParams();
    const { tab } = packDetailRoute.useSearch();
    return <PackDetailPage name={name} version={version} tab={tab ?? 'overview'} />;
  },
});

interface ProjectSearch {
  tab?: ProjectTab;
  version?: number;
}

const projectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/projects/$projectId',
  validateSearch: (search: Record<string, unknown>): ProjectSearch => {
    const out: ProjectSearch = {};
    if (PROJECT_TABS.includes(search.tab as ProjectTab)) out.tab = search.tab as ProjectTab;
    const v = Number(search.version);
    if (Number.isInteger(v) && v > 0) out.version = v;
    return out;
  },
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams();
    const { tab, version } = projectRoute.useSearch();
    return <ProjectPage projectId={projectId} tab={tab ?? 'editor'} version={version ?? null} />;
  },
});

const templatesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/templates',
  component: TemplatesPage,
});

const modelsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/models',
  validateSearch: (search: Record<string, unknown>): { tab?: ModelTab } =>
    MODEL_TABS.includes(search.tab as ModelTab) ? { tab: search.tab as ModelTab } : {},
  component: function ModelsRoute() {
    const { tab } = modelsRoute.useSearch();
    return <ModelsPage tab={tab ?? 'providers'} />;
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/agents',
  validateSearch: (search: Record<string, unknown>): { tab?: AgentsTab } =>
    AGENT_TABS.includes(search.tab as AgentsTab) ? { tab: search.tab as AgentsTab } : {},
  component: function AgentsRoute() {
    const { tab } = agentsRoute.useSearch();
    return <AgentsPage tab={tab ?? 'registry'} />;
  },
});

const registerAgentRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/agents/register',
  component: RegisterAgentPage,
});

const agentVersionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/agents/$name/$version',
  validateSearch: (search: Record<string, unknown>): { tab?: VersionTab } =>
    VERSION_TABS.includes(search.tab as VersionTab) ? { tab: search.tab as VersionTab } : {},
  component: function AgentVersionRoute() {
    const { name, version } = agentVersionRoute.useParams();
    const { tab } = agentVersionRoute.useSearch();
    return <AgentVersionPage name={name} version={version} tab={tab ?? 'overview'} />;
  },
});

export const routeTree = rootRoute.addChildren([
  signInRoute,
  authCallbackRoute,
  appLayoutRoute.addChildren([
    homeRoute,
    tenantsRoute,
    tenantDetailRoute,
    programmesRoute,
    accessRoute,
    auditRoute,
    observabilityRoute,
    traceRoute,
    packsRoute,
    composeRoute,
    packDetailRoute,
    projectRoute,
    templatesRoute,
    modelsRoute,
    agentsRoute,
    registerAgentRoute,
    agentVersionRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    // `auth` is supplied by <RouterProvider context={{ auth }}> on every render.
    context: { queryClient, auth: undefined as unknown as AuthContextValue },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
