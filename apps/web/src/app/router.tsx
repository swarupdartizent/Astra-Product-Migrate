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
import { AdapterDetailPage } from '@/features/adapters/AdapterDetailPage';
import { AdaptersPage } from '@/features/adapters/AdaptersPage';
import {
  ADAPTER_DETAIL_TABS,
  ADAPTERS_TABS,
  type AdapterDetailTab,
  type AdaptersTab,
} from '@/features/adapters/model';
import { AuditPage } from '@/features/audit/AuditPage';
import { BaselineDetailPage, BaselinesPage } from '@/features/baselines/BaselinesPage';
import { GoldenPage } from '@/features/golden/GoldenPage';
import { ConceptPage } from '@/features/ontology/ConceptPage';
import { OntologyPage } from '@/features/ontology/OntologyPage';
import { CONCEPT_TABS, parsePacksParam, type ConceptTab } from '@/features/ontology/tabs';
import { AdapterRunPage } from '@/features/sources/AdapterRunPage';
import { DiscoveryRunPage } from '@/features/discovery/DiscoveryRunPage';
import { PresalesPage } from '@/features/presales/PresalesPage';
import { RUN_TABS, type RunTab } from '@/features/discovery/model';
import { ModelsPage } from '@/features/models/ModelsPage';
import { MODEL_TABS, type ModelTab } from '@/features/models/tabs';
import { ProjectPage } from '@/features/blueprints/ProjectPage';
import { parseProjectSearch, type ProjectSearch } from '@/features/blueprints/tabs';
import { ComposePage } from '@/features/packs/ComposePage';
import { PackDetailPage } from '@/features/packs/PackDetailPage';
import { PackLibraryPage } from '@/features/packs/PackLibraryPage';
import { PACK_TABS, type PackTab } from '@/features/packs/tabs';
import { TemplatesPage } from '@/features/templates/TemplatesPage';
import { ObservabilityPage } from '@/features/observability/ObservabilityPage';
import { TraceDetailPage } from '@/features/observability/TraceDetailPage';
import { parseProgrammeSearch, type ProgrammeSearch } from '@/features/programmes/model';
import { ProgrammePage } from '@/features/programmes/ProgrammePage';
import { ProgrammesPage } from '@/features/programmes/ProgrammesPage';
import { ReleasesPage } from '@/features/releases/ReleasesPage';
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

const programmeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/programmes/$programmeId',
  validateSearch: (search: Record<string, unknown>): ProgrammeSearch =>
    parseProgrammeSearch(search),
  component: function ProgrammeRoute() {
    const { programmeId } = programmeRoute.useParams();
    const search = programmeRoute.useSearch();
    const navigate = programmeRoute.useNavigate();
    return (
      <ProgrammePage
        programmeId={programmeId}
        search={search}
        onSearch={(next, replace) => void navigate({ search: next, replace })}
      />
    );
  },
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

const releasesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/releases',
  validateSearch: (search: Record<string, unknown>): { release?: string } =>
    typeof search.release === 'string' && search.release ? { release: search.release } : {},
  component: function ReleasesRoute() {
    const { release } = releasesRoute.useSearch();
    const navigate = releasesRoute.useNavigate();
    return (
      <ReleasesPage
        releaseId={release ?? null}
        onSelectRelease={(id) => void navigate({ search: { release: id }, replace: true })}
      />
    );
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

const projectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/projects/$projectId',
  validateSearch: (search: Record<string, unknown>): ProjectSearch => parseProjectSearch(search),
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams();
    const search = projectRoute.useSearch();
    return <ProjectPage projectId={projectId} search={search} />;
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

const adaptersRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/adapters',
  validateSearch: (search: Record<string, unknown>): { tab?: AdaptersTab } =>
    ADAPTERS_TABS.includes(search.tab as AdaptersTab) ? { tab: search.tab as AdaptersTab } : {},
  component: function AdaptersRoute() {
    const { tab } = adaptersRoute.useSearch();
    return <AdaptersPage tab={tab ?? 'adapters'} />;
  },
});

const adapterDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/adapters/$name/$version',
  validateSearch: (search: Record<string, unknown>): { tab?: AdapterDetailTab } =>
    ADAPTER_DETAIL_TABS.includes(search.tab as AdapterDetailTab)
      ? { tab: search.tab as AdapterDetailTab }
      : {},
  component: function AdapterDetailRoute() {
    const { name, version } = adapterDetailRoute.useParams();
    const { tab } = adapterDetailRoute.useSearch();
    return <AdapterDetailPage name={name} version={version} tab={tab ?? 'overview'} />;
  },
});

const goldenRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/golden',
  validateSearch: (search: Record<string, unknown>): { dataset?: string } =>
    typeof search.dataset === 'string' && search.dataset ? { dataset: search.dataset } : {},
  component: function GoldenRoute() {
    const { dataset } = goldenRoute.useSearch();
    return <GoldenPage dataset={dataset ?? null} />;
  },
});

const adapterRunRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/adapter-runs/$runId',
  component: function AdapterRunRoute() {
    const { runId } = adapterRunRoute.useParams();
    return <AdapterRunPage runId={runId} />;
  },
});

const baselinesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/baselines',
  component: BaselinesPage,
});

const baselineDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/baselines/$baselineId',
  component: function BaselineDetailRoute() {
    const { baselineId } = baselineDetailRoute.useParams();
    return <BaselineDetailPage baselineId={baselineId} />;
  },
});

const ontologyRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/ontology',
  validateSearch: (search: Record<string, unknown>): { packs?: string } =>
    typeof search.packs === 'string' && search.packs ? { packs: search.packs } : {},
  component: function OntologyRoute() {
    const { packs } = ontologyRoute.useSearch();
    return <OntologyPage packs={parsePacksParam(packs)} />;
  },
});

const conceptRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/ontology/$conceptId',
  validateSearch: (search: Record<string, unknown>): { packs?: string; tab?: ConceptTab } => {
    const out: { packs?: string; tab?: ConceptTab } = {};
    if (typeof search.packs === 'string' && search.packs) out.packs = search.packs;
    if (CONCEPT_TABS.includes(search.tab as ConceptTab)) out.tab = search.tab as ConceptTab;
    return out;
  },
  component: function ConceptRoute() {
    const { conceptId } = conceptRoute.useParams();
    const { packs, tab } = conceptRoute.useSearch();
    return (
      <ConceptPage conceptId={conceptId} packs={parsePacksParam(packs)} tab={tab ?? 'overview'} />
    );
  },
});

interface DiscoveryRunSearch {
  tab?: RunTab;
  node?: string;
  unused?: boolean;
}

const discoveryRunRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/discovery-runs/$runId',
  validateSearch: (search: Record<string, unknown>): DiscoveryRunSearch => {
    const out: DiscoveryRunSearch = {};
    if (RUN_TABS.includes(search.tab as RunTab)) out.tab = search.tab as RunTab;
    if (typeof search.node === 'string' && search.node) out.node = search.node;
    if (search.unused === true || search.unused === 'true') out.unused = true;
    return out;
  },
  component: function DiscoveryRunRoute() {
    const { runId } = discoveryRunRoute.useParams();
    const { tab, node, unused } = discoveryRunRoute.useSearch();
    return (
      <DiscoveryRunPage
        runId={runId}
        tab={tab ?? 'summary'}
        node={node ?? null}
        unused={unused === true}
      />
    );
  },
});

const presalesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: '/presales',
  validateSearch: (search: Record<string, unknown>): { estimate?: string } =>
    typeof search.estimate === 'string' && search.estimate ? { estimate: search.estimate } : {},
  component: function PresalesRoute() {
    const { estimate } = presalesRoute.useSearch();
    return <PresalesPage estimateId={estimate ?? null} />;
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
    programmeRoute,
    accessRoute,
    auditRoute,
    observabilityRoute,
    traceRoute,
    releasesRoute,
    packsRoute,
    composeRoute,
    packDetailRoute,
    projectRoute,
    templatesRoute,
    modelsRoute,
    agentsRoute,
    registerAgentRoute,
    agentVersionRoute,
    adaptersRoute,
    adapterDetailRoute,
    goldenRoute,
    adapterRunRoute,
    baselinesRoute,
    baselineDetailRoute,
    ontologyRoute,
    conceptRoute,
    discoveryRunRoute,
    presalesRoute,
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
