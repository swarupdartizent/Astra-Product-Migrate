import { Link, useNavigate } from '@tanstack/react-router';
import { usePack } from '@/api/packs';
import { useAdapters } from '@/api/adapters';
import type { SourceAdapterContent } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
} from '@/ui';
import s from '../shared.module.css';
import { PACK_STATUS } from '../packs/model';
import { ADAPTER_DETAIL_TABS, type AdapterDetailTab } from './model';
import { TargetConstraintsView } from './TargetConstraintsView';
import { TrapsPanel } from './TrapsPanel';
import { UnvalidatedBadge } from './UnvalidatedBadge';

export interface AdapterDetailPageProps {
  name: string;
  version: string;
  tab: AdapterDetailTab;
}

export function AdapterDetailPage({ name, version, tab }: AdapterDetailPageProps) {
  const pack = usePack(name, version);
  const adapters = useAdapters();
  const navigate = useNavigate();
  const summary = adapters.data?.find((a) => a.name === name && a.version === version);
  useDocumentTitle(pack.data ? `${pack.data.title} ${version}` : `${name} ${version}`);
  const breadcrumbs = [
    { label: 'Adapters', to: '/adapters' as const },
    { label: `${name}@${version}` },
  ];

  if (pack.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading adapter…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="18rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (pack.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title={`${name}@${version}`} />
        <ApiErrorView
          error={pack.error}
          title="Could not load this adapter"
          onRetry={() => void pack.refetch()}
        />
      </>
    );
  }
  const p = pack.data;
  const isSource = p.type === 'source_adapter';
  const isTarget = p.type === 'target_adapter';
  const st = PACK_STATUS[p.status];
  const visible = ADAPTER_DETAIL_TABS.filter(
    (t) => t === 'overview' || (t === 'traps' && isSource) || (t === 'constraints' && isTarget),
  );
  const current = visible.includes(tab) ? tab : 'overview';

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={p.title}
        meta={
          <span className={s.row}>
            <Badge>{isSource ? 'Source adapter' : isTarget ? 'Target adapter' : p.type}</Badge>
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
            {summary && !summary.contract_valid ? (
              <Badge tone="danger">Contract mismatch</Badge>
            ) : null}
            {summary?.contract_valid && !summary.validated ? <UnvalidatedBadge /> : null}
          </span>
        }
        description={
          <>
            <Mono>
              {p.name}@{p.version}
            </Mono>{' '}
            ·{' '}
            <Link to="/packs/$name/$version" params={{ name: p.name, version: p.version }}>
              pack details, files and tests
            </Link>
          </>
        }
      />
      {summary && !summary.contract_valid ? (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Callout tone="danger" title="Does not match the adapter contract">
            {summary.contract_problem}
          </Callout>
        </div>
      ) : null}
      <Tabs
        value={current}
        onValueChange={(v) =>
          void navigate({
            to: '/adapters/$name/$version',
            params: { name, version },
            search: { tab: v as AdapterDetailTab },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Adapter sections">
          <Tab value="overview">{isTarget ? 'Overview' : 'What it reads'}</Tab>
          {isSource ? <Tab value="traps">Traps</Tab> : null}
          {isTarget ? <Tab value="constraints">Constraints and load</Tab> : null}
        </TabsList>
        <TabPanel value="overview">
          {isSource && summary?.contract_valid !== false ? (
            <SourceOverview
              content={p.manifest.content as unknown as SourceAdapterContent}
              adapter={p.name}
              version={p.version}
            />
          ) : isTarget ? (
            <TargetConstraintsView name={name} version={version} />
          ) : (
            <EmptyState
              compact
              title="Nothing to show"
              body="The adapter content does not match the contract."
            />
          )}
        </TabPanel>
        {isSource ? (
          <TabPanel value="traps">
            <TrapsPanel name={name} version={version} />
          </TabPanel>
        ) : null}
        {isTarget ? (
          <TabPanel value="constraints">
            <TargetConstraintsView name={name} version={version} />
          </TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}

function SourceOverview({
  content: c,
  adapter,
  version,
}: {
  content: SourceAdapterContent;
  adapter: string;
  version: string;
}) {
  const entities = c.entities ?? [];
  return (
    <div className={s.stack}>
      <Card aria-labelledby="src-product">
        <CardHeader titleId="src-product" title="Product and engines" />
        <CardBody>
          <KeyValueList
            items={[
              { key: 'product', label: 'Product', value: c.product.name },
              { key: 'versions', label: 'Versions covered', value: c.product.versions.join(', ') },
              {
                key: 'engines',
                label: 'Engines',
                value: (
                  <ul style={{ listStyle: 'none' }}>
                    {c.engines.map((e) => (
                      <li key={e.engine}>
                        <Mono>{e.engine}</Mono>
                        {e.min_version ? ` ${e.min_version} or later` : ''}
                        {e.notes ? (
                          <span className={`${s.muted} ${s.small}`}> · {e.notes}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="src-types">
        <CardHeader
          titleId="src-types"
          title={`Object types (${c.object_types.length})`}
          description="What the metadata harvest inventories. Code types have their source text read; interface types are connections to other systems."
        />
        <CardBody>
          <ul style={{ listStyle: 'none' }} className={s.stackSm}>
            {c.object_types.map((o) => (
              <li key={o.key} className={s.row}>
                <Mono>{o.key}</Mono>
                <span>{o.label}</span>
                {o.code ? <Badge tone="info">Code</Badge> : null}
                {o.interface ? <Badge tone="accent">Interface</Badge> : null}
                {o.required === false ? <Badge>Optional</Badge> : null}
                {o.dependencies && Object.keys(o.dependencies).length ? (
                  <Badge>Dependencies</Badge>
                ) : null}
                <span className={`${s.muted} ${s.xs}`}>
                  queries for {Object.keys(o.queries).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card aria-labelledby="src-entities">
        <CardHeader
          titleId="src-entities"
          title={`Entities (${entities.length})`}
          description="What extraction reads, and the ontology concepts each binds to so domain rules can run on this product."
        />
        <CardBody>
          {entities.length === 0 ? (
            <p className={s.muted}>No entities are declared.</p>
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stack}>
              {entities.map((e) => (
                <li key={e.name} className={s.cellStack}>
                  <span className={s.row}>
                    <strong>{e.name}</strong>
                    <Mono className={s.small}>{e.table}</Mono>
                    {e.concept ? (
                      <Link to="/ontology/$conceptId" params={{ conceptId: e.concept }}>
                        <Badge tone="accent">{e.concept}</Badge>
                      </Link>
                    ) : (
                      <Badge>No concept</Badge>
                    )}
                    {e.delta_column ? (
                      <span className={`${s.muted} ${s.xs}`}>deltas by {e.delta_column}</span>
                    ) : (
                      <span className={`${s.muted} ${s.xs}`}>full extracts only</span>
                    )}
                  </span>
                  <span className={`${s.muted} ${s.small}`}>
                    Key {e.key.join(', ')}
                    {e.attributes && Object.keys(e.attributes).length
                      ? ` · attributes ${Object.entries(e.attributes)
                          .map(([a, col]) => `${a} ← ${col}`)
                          .join(', ')}`
                      : ''}
                    {e.relations && Object.keys(e.relations).length
                      ? ` · relations ${Object.entries(e.relations)
                          .map(([r, rel]) => `${r} → ${rel.entity} (${rel.column})`)
                          .join(', ')}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <div className={s.grid2}>
        <Card aria-labelledby="src-docs">
          <CardHeader titleId="src-docs" title="Document store" />
          <CardBody>
            {c.documents ? (
              <KeyValueList
                layout="stack"
                items={[
                  { key: 'table', label: 'Table', value: <Mono>{c.documents.table}</Mono> },
                  {
                    key: 'key',
                    label: 'Key / name',
                    value: `${c.documents.key} / ${c.documents.name_column}`,
                  },
                  {
                    key: 'links',
                    label: 'Link types',
                    value: Object.entries(c.documents.link_types)
                      .map(([t, ent]) => `${t} → ${ent}`)
                      .join(', '),
                  },
                ]}
              />
            ) : (
              <p className={s.muted}>This adapter declares no document store.</p>
            )}
          </CardBody>
        </Card>
        <Card aria-labelledby="src-golden">
          <CardHeader titleId="src-golden" title="Golden datasets" />
          <CardBody>
            {(c.golden_datasets ?? []).length === 0 ? (
              <p className={s.muted}>None shipped with this version.</p>
            ) : (
              <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                {(c.golden_datasets ?? []).map((g) => (
                  <li key={g.name} className={s.cellStack}>
                    <Link to="/golden" search={{ dataset: `${adapter}@${version}:${g.name}` }}>
                      {g.name}
                    </Link>
                    <span className={`${s.muted} ${s.small}`}>
                      {g.engine}
                      {g.description ? ` · ${g.description}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
