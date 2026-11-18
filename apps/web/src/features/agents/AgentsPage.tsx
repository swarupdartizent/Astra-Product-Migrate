import { Link, useNavigate } from '@tanstack/react-router';
import { Bot, Download, FilePlus2, PackageOpen } from 'lucide-react';
import { useMemo } from 'react';
import {
  useAgentCatalog,
  useAgents,
  useAllGovernanceRecords,
  useImportCatalog,
  useModelReadiness,
} from '@/api/agents';
import { saveBlob } from '@/api/client';
import type { Agent, AgentCatalogItem, ModelReadiness } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { usePermissions } from '@/app/permissions';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Mono,
  PageHeader,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { GuardrailLab } from './GuardrailLab';
import {
  AGENT_TABS,
  agentVersionStatus,
  governanceJson,
  RISK_TONE,
  testStatus,
  type AgentsTab,
} from './model';

export function AgentsPage({ tab }: { tab: AgentsTab }) {
  useDocumentTitle('Agents');
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canLab = can(['agent:manage', 'audit:read']);
  const current = AGENT_TABS.includes(tab) && (tab !== 'lab' || canLab) ? tab : 'registry';

  return (
    <>
      <PageHeader
        title="Agents"
        description="Every agent is a registered, versioned manifest: what it may do, which tools it may call, its limits and who oversees it. Only released versions can be pinned to projects."
        actions={
          can('agent:manage') ? (
            <Button asChild variant="primary" leadingIcon={<FilePlus2 aria-hidden="true" />}>
              <Link to="/agents/register">Register a version</Link>
            </Button>
          ) : null
        }
      />
      <Tabs
        value={current}
        onValueChange={(v) =>
          void navigate({ to: '/agents', search: { tab: v as AgentsTab }, replace: true })
        }
      >
        <TabsList aria-label="Agent sections">
          <Tab value="registry">Registry</Tab>
          <Tab value="catalogue">Built-in catalogue</Tab>
          <Tab value="readiness">Model readiness</Tab>
          <Tab value="governance">Governance records</Tab>
          {canLab ? <Tab value="lab">Guardrail lab</Tab> : null}
        </TabsList>
        <TabPanel value="registry">
          <Registry />
        </TabPanel>
        <TabPanel value="catalogue">
          <Catalogue />
        </TabPanel>
        <TabPanel value="readiness">
          <Readiness />
        </TabPanel>
        <TabPanel value="governance">
          <GovernanceAll />
        </TabPanel>
        {canLab ? (
          <TabPanel value="lab">
            <GuardrailLab />
          </TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}

function Registry() {
  const agents = useAgents();
  const navigate = useNavigate();
  const columns = useMemo(() => {
    const col = createDataTableColumns<Agent>();
    return col.columns([
      col.accessor('title', {
        header: 'Agent',
        size: 280,
        cell: (info) => (
          <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.name}</Mono>
            <span className={`${s.muted} ${s.xs}`}>{info.row.original.purpose}</span>
          </span>
        ),
      }),
      col.accessor('team', {
        header: 'Team',
        size: 120,
        cell: (info) => <Badge>{info.getValue()}</Badge>,
      }),
      col.display({
        id: 'versions',
        header: 'Versions',
        size: 320,
        cell: (info) => (
          <span className={s.badges}>
            {info.row.original.versions.map((v) => {
              const st = agentVersionStatus(v.status);
              const tests = testStatus(v.latest_test_status);
              return (
                <Link
                  key={v.id}
                  to="/agents/$name/$version"
                  params={{ name: info.row.original.name, version: v.version }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`${info.row.original.name} ${v.version}: ${st.label}, tests ${tests.label}, risk ${v.risk_rating || 'not rated'}`}
                >
                  <StatusPill tone={st.tone}>
                    {v.version} · {st.label}
                  </StatusPill>
                </Link>
              );
            })}
          </span>
        ),
      }),
      col.accessor((a) => a.latest_released ?? '', {
        id: 'released',
        header: 'Latest released',
        size: 130,
        cell: (info) => info.row.original.latest_released ?? <span className={s.muted}>None</span>,
      }),
      col.display({
        id: 'risk',
        header: 'Risk',
        size: 90,
        cell: (info) => {
          const r = info.row.original.versions[0]?.risk_rating;
          return r ? <Badge tone={RISK_TONE[r] ?? 'neutral'}>{r}</Badge> : null;
        },
      }),
    ]);
  }, []);

  return (
    <Card flush aria-label="Registered agents">
      <CardBody>
        {agents.isError ? (
          <ApiErrorView
            error={agents.error}
            title="Could not load agents"
            onRetry={() => void agents.refetch()}
          />
        ) : (
          <DataTable
            label="Registered agents"
            data={agents.data}
            columns={columns}
            getRowId={(a) => a.name}
            loading={agents.isPending}
            onRowClick={(a) => {
              const v = a.versions[0];
              if (v)
                void navigate({
                  to: '/agents/$name/$version',
                  params: { name: a.name, version: v.version },
                });
            }}
            empty={
              <EmptyState
                compact
                icon={<Bot />}
                title="No agents registered"
                body="Import the built-in catalogue or register a manifest."
              />
            }
          />
        )}
      </CardBody>
    </Card>
  );
}

function Catalogue() {
  const catalog = useAgentCatalog();
  const importCatalog = useImportCatalog();
  const { can } = usePermissions();
  const col = createDataTableColumns<AgentCatalogItem>();
  const columns = col.columns([
    col.accessor('title', {
      header: 'Agent',
      size: 280,
      cell: (info) => (
        <span className={s.cellStack}>
          <span className={s.cellPrimary}>{info.getValue()}</span>
          <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.file}</Mono>
        </span>
      ),
    }),
    col.accessor('name', { header: 'Name', size: 200, meta: { mono: true } }),
    col.accessor('version', { header: 'Version', size: 100, meta: { mono: true } }),
    col.accessor((r) => r.registered_status ?? '', {
      id: 'registered',
      header: 'Registered',
      size: 140,
      cell: (info) =>
        info.row.original.registered_status ? (
          <StatusPill tone={agentVersionStatus(info.row.original.registered_status).tone}>
            {agentVersionStatus(info.row.original.registered_status).label}
          </StatusPill>
        ) : (
          <span className={s.muted}>Not registered</span>
        ),
    }),
  ]);
  const unregistered = (catalog.data ?? []).filter((c) => !c.registered_status).length;

  return (
    <Card flush aria-labelledby="catalog-title">
      <CardHeader
        titleId="catalog-title"
        title="Built-in catalogue"
        description="Agents shipped with the platform. Importing registers them as drafts; each still needs its test suite to pass before release."
        actions={
          can('agent:manage') ? (
            <Button
              size="sm"
              leadingIcon={<PackageOpen aria-hidden="true" />}
              loading={importCatalog.isPending}
              disabled={unregistered === 0}
              onClick={() =>
                importCatalog.mutate(undefined, {
                  onSuccess: (agents) =>
                    toast.success(
                      `${agents.length} agent${agents.length === 1 ? '' : 's'} registered as drafts`,
                    ),
                })
              }
            >
              Import as drafts
            </Button>
          ) : null
        }
      />
      {importCatalog.isError ? (
        <CardBody>
          <FormError error={importCatalog.error} />
        </CardBody>
      ) : null}
      <CardBody>
        {catalog.isError ? (
          <ApiErrorView
            error={catalog.error}
            title="Could not load the catalogue"
            compact
            onRetry={() => void catalog.refetch()}
          />
        ) : (
          <DataTable
            label="Built-in agents"
            data={catalog.data}
            columns={columns}
            getRowId={(r) => `${r.name}@${r.version}`}
            loading={catalog.isPending}
          />
        )}
      </CardBody>
    </Card>
  );
}

function Readiness() {
  const readiness = useModelReadiness();
  const col = createDataTableColumns<ModelReadiness>();
  const columns = col.columns([
    col.accessor('alias', { header: 'Model alias', size: 180, meta: { mono: true } }),
    col.accessor('ready', {
      header: 'Status',
      size: 120,
      cell: (info) =>
        info.getValue() ? (
          <StatusPill tone="success">Ready</StatusPill>
        ) : (
          <StatusPill tone="warning">Blocked</StatusPill>
        ),
    }),
    col.accessor('detail', {
      header: 'Detail',
      size: 360,
      cell: (info) => <span style={{ whiteSpace: 'normal' }}>{info.getValue()}</span>,
    }),
    col.display({
      id: 'agents',
      header: 'Used by',
      size: 260,
      cell: (info) =>
        info.row.original.agents.length ? (
          <span className={s.badges}>
            {info.row.original.agents.map((a) => (
              <Badge key={a}>{a}</Badge>
            ))}
          </span>
        ) : (
          <span className={s.muted}>No agent</span>
        ),
    }),
  ]);
  const blocked = (readiness.data ?? []).filter((r) => !r.ready).length;
  return (
    <div className={s.stack}>
      {blocked > 0 ? (
        <Callout
          tone="warning"
          title={`${blocked} alias${blocked === 1 ? ' is' : 'es are'} blocked`}
        >
          Agents using a blocked alias cannot call a model; their model test cases show as Blocked.
          Fix the provider or alias under Models.
        </Callout>
      ) : null}
      <Card flush aria-label="Model readiness">
        <CardBody>
          {readiness.isError ? (
            <ApiErrorView
              error={readiness.error}
              title="Could not check readiness"
              compact
              onRetry={() => void readiness.refetch()}
            />
          ) : (
            <DataTable
              label="Model readiness per alias"
              data={readiness.data}
              columns={columns}
              getRowId={(r) => r.alias}
              loading={readiness.isPending}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function GovernanceAll() {
  const records = useAllGovernanceRecords();
  return (
    <Card aria-labelledby="gov-title">
      <CardHeader
        titleId="gov-title"
        title="Governance records"
        description="One record per registered agent version: risk, intended use, oversight, tools, models that answered, tests and release. Open a version to read its record."
        actions={
          <Button
            size="sm"
            leadingIcon={<Download aria-hidden="true" />}
            disabled={!records.data}
            onClick={() => {
              if (!records.data) return;
              saveBlob({
                blob: new Blob([governanceJson(records.data)], { type: 'application/json' }),
                filename: `agent-governance-${new Date().toISOString().slice(0, 10)}.json`,
              });
            }}
          >
            Download JSON
          </Button>
        }
      />
      <CardBody>
        {records.isError ? (
          <ApiErrorView
            error={records.error}
            title="Could not load governance records"
            compact
            onRetry={() => void records.refetch()}
          />
        ) : records.isPending ? (
          <p className={s.muted}>Loading…</p>
        ) : records.data.length === 0 ? (
          <EmptyState compact title="No agent versions registered" />
        ) : (
          <ul style={{ listStyle: 'none' }} className={s.stackSm}>
            {records.data.map((r) => (
              <li key={`${r.agent}@${r.version}`} className={s.row}>
                <Link
                  to="/agents/$name/$version"
                  params={{ name: r.agent, version: r.version }}
                  search={{ tab: 'governance' }}
                >
                  {r.title} {r.version}
                </Link>
                <StatusPill tone={agentVersionStatus(r.status).tone}>
                  {agentVersionStatus(r.status).label}
                </StatusPill>
                <Badge tone={RISK_TONE[r.risk_rating] ?? 'neutral'}>risk {r.risk_rating}</Badge>
                <span className={`${s.muted} ${s.xs}`}>
                  {r.usage.model_calls} model calls · {r.usage.projects_pinned} projects
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
