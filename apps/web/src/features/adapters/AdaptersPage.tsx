import { Link, useNavigate } from '@tanstack/react-router';
import { Plug } from 'lucide-react';
import { useMemo } from 'react';
import { useAdapterContract, useAdapters } from '@/api/adapters';
import type { AdapterSummary } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  type Tone,
} from '@/ui';
import s from '../shared.module.css';
import { PACK_STATUS } from '../packs/model';
import { ADAPTERS_TABS, type AdaptersTab } from './model';
import { UnvalidatedBadge } from './UnvalidatedBadge';

export function AdaptersPage({ tab }: { tab: AdaptersTab }) {
  useDocumentTitle('Adapters');
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Adapters"
        description="How each source and target product plugs into the platform. Source adapters read estates through read-only accounts; target adapters load only through the vendor's APIs."
      />
      <Tabs
        value={ADAPTERS_TABS.includes(tab) ? tab : 'adapters'}
        onValueChange={(v) =>
          void navigate({ to: '/adapters', search: { tab: v as AdaptersTab }, replace: true })
        }
      >
        <TabsList aria-label="Adapter sections">
          <Tab value="adapters">Adapter packs</Tab>
          <Tab value="contract">The adapter contract</Tab>
        </TabsList>
        <TabPanel value="adapters">
          <AdapterList />
        </TabPanel>
        <TabPanel value="contract">
          <ContractView />
        </TabPanel>
      </Tabs>
    </>
  );
}

function AdapterList() {
  const adapters = useAdapters();
  const navigate = useNavigate();
  const columns = useMemo(() => {
    const col = createDataTableColumns<AdapterSummary>();
    return col.columns([
      col.accessor('title', {
        header: 'Adapter',
        size: 300,
        cell: (info) => {
          const a = info.row.original;
          return (
            <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
              <Link
                to="/adapters/$name/$version"
                params={{ name: a.name, version: a.version }}
                className={s.cellLink}
                onClick={(e) => e.stopPropagation()}
              >
                {a.title}
              </Link>
              <Mono className={`${s.muted} ${s.xs}`}>{a.ref}</Mono>
              {!a.contract_valid ? (
                <span className={s.small} style={{ color: 'var(--color-danger-text)' }}>
                  Does not match the adapter contract. {a.contract_problem}
                </span>
              ) : null}
            </span>
          );
        },
      }),
      col.accessor('type', {
        header: 'Kind',
        size: 110,
        cell: (info) => <Badge>{info.getValue() === 'source_adapter' ? 'Source' : 'Target'}</Badge>,
      }),
      col.accessor('product', {
        header: 'Product',
        size: 200,
        cell: (info) =>
          info.getValue() ? (
            <span className={s.cellStack}>
              <span>{info.getValue()}</span>
              <span className={`${s.muted} ${s.xs}`}>
                {info.row.original.product_versions.join(', ')}
              </span>
            </span>
          ) : (
            <span className={s.muted}>—</span>
          ),
      }),
      col.display({
        id: 'coverage',
        header: 'Covers',
        size: 240,
        cell: (info) => {
          const a = info.row.original;
          if (!a.contract_valid) return <span className={s.muted}>—</span>;
          return a.type === 'source_adapter' ? (
            <span className={`${s.small}`} style={{ whiteSpace: 'normal' }}>
              {a.engines.join(', ')} · {a.object_types.length} object types · {a.entities} entities
              · {a.traps} traps
              {a.curated_traps ? ` (+${a.curated_traps} curated)` : ''}
              {a.golden_datasets.length ? ` · ${a.golden_datasets.length} golden` : ''}
            </span>
          ) : (
            <span className={s.small}>
              {a.entities} load endpoints · {a.constraints} constraints
            </span>
          );
        },
      }),
      col.display({
        id: 'status',
        header: 'Status',
        size: 200,
        cell: (info) => {
          const a = info.row.original;
          const st = (PACK_STATUS as Partial<Record<string, { label: string; tone: Tone }>>)[
            a.status
          ] ?? {
            label: a.status,
            tone: 'neutral' as const,
          };
          return (
            <span className={s.row}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
              {!a.contract_valid ? (
                <Badge tone="danger">Contract mismatch</Badge>
              ) : !a.validated ? (
                <UnvalidatedBadge />
              ) : null}
            </span>
          );
        },
      }),
    ]);
  }, []);

  return (
    <Card flush aria-label="Adapter packs">
      <CardBody>
        {adapters.isError ? (
          <ApiErrorView
            error={adapters.error}
            title="Could not load adapters"
            onRetry={() => void adapters.refetch()}
          />
        ) : (
          <DataTable
            label="Adapter packs, newest version first"
            data={adapters.data}
            columns={columns}
            getRowId={(a) => a.ref}
            loading={adapters.isPending}
            onRowClick={(a) =>
              void navigate({
                to: '/adapters/$name/$version',
                params: { name: a.name, version: a.version },
              })
            }
            empty={
              <EmptyState
                compact
                icon={<Plug />}
                title="No adapter packs"
                body="Adapters are packs of type source or target adapter."
              />
            }
          />
        )}
      </CardBody>
    </Card>
  );
}

function ContractView() {
  const contract = useAdapterContract();
  if (contract.isPending) return <Skeleton height="12rem" />;
  if (contract.isError) {
    return (
      <ApiErrorView
        error={contract.error}
        title="Could not load the contract"
        onRetry={() => void contract.refetch()}
      />
    );
  }
  const c = contract.data;
  return (
    <div className={s.stack}>
      <Card aria-labelledby="contract-ops">
        <CardHeader
          titleId="contract-ops"
          title={`Operations (${c.version})`}
          description="What every adapter provides. The platform supplies the drivers, the read-only guard, the job runner and storage."
        />
        <CardBody>
          <ul style={{ listStyle: 'none' }} className={s.stackSm}>
            {c.operations.map((op) => (
              <li key={op.name} className={s.cellStack}>
                <Mono>{op.name}</Mono>
                <span className={`${s.muted} ${s.small}`}>{op.description}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Callout tone="info" title="Read-only by construction: three layers">
        <ol style={{ paddingLeft: 'var(--space-5)' }}>
          {c.read_only_layers.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </Callout>
    </div>
  );
}
