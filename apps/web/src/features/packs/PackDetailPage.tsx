import { useNavigate } from '@tanstack/react-router';
import { usePack } from '@/api/packs';
import type { PackDetail } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { PACK_STATUS, packTypeLabel } from './model';
import { PACK_TABS, type PackTab } from './tabs';
import { ControlsTable, RulesTable, SettingsTable } from './PackContentTables';
import { PackCompare } from './PackCompare';
import { PackFiles } from './PackFiles';
import { PackTests } from './PackTests';

export interface PackDetailPageProps {
  name: string;
  version: string;
  tab: PackTab;
}

export function PackDetailPage({ name, version, tab }: PackDetailPageProps) {
  const pack = usePack(name, version);
  const navigate = useNavigate();
  useDocumentTitle(pack.data ? `${pack.data.title} ${version}` : `${name} ${version}`);
  const breadcrumbs = [
    { label: 'Pack library', to: '/packs' as const },
    { label: `${name}@${version}` },
  ];

  if (pack.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading pack…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="18rem" height="1.75rem" />} />
        <Skeleton height="12rem" />
      </div>
    );
  }
  if (pack.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title={`${name}@${version}`} />
        <ApiErrorView
          error={pack.error}
          title="Could not load this pack"
          onRetry={() => void pack.refetch()}
          retrying={pack.isFetching}
        />
      </>
    );
  }

  const p = pack.data;
  const adds = p.manifest.adds ?? {};
  const st = PACK_STATUS[p.status];
  const visible: PackTab[] = PACK_TABS.filter((t) => {
    if (t === 'controls') return (adds.controls?.length ?? 0) > 0 || p.type === 'compliance';
    if (t === 'rules') return (adds.rules?.length ?? 0) > 0;
    if (t === 'settings') return (adds.settings?.length ?? 0) > 0;
    if (t === 'compare') return p.other_versions.length > 1;
    return true;
  });
  const current = visible.includes(tab) ? tab : 'overview';

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={p.title}
        meta={
          <span className={s.row}>
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
            <Badge>{packTypeLabel(p.type)}</Badge>
          </span>
        }
        description={
          <>
            <Mono>
              {p.name}@{p.version}
            </Mono>
            {p.other_versions.length > 1 ? ` · ${p.other_versions.length} versions` : ''}
          </>
        }
      />
      <Tabs
        value={current}
        onValueChange={(value) =>
          void navigate({
            to: '/packs/$name/$version',
            params: { name, version },
            search: { tab: value as PackTab },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Pack sections">
          <Tab value="overview">Overview</Tab>
          {visible.includes('controls') ? (
            <Tab value="controls" badge={adds.controls?.length ?? 0}>
              Controls
            </Tab>
          ) : null}
          {visible.includes('rules') ? (
            <Tab value="rules" badge={adds.rules?.length ?? 0}>
              Rules
            </Tab>
          ) : null}
          {visible.includes('settings') ? (
            <Tab value="settings" badge={adds.settings?.length ?? 0}>
              Settings
            </Tab>
          ) : null}
          <Tab value="files" badge={p.files.length}>
            Files
          </Tab>
          <Tab value="tests">Tests and release</Tab>
          {visible.includes('compare') ? <Tab value="compare">Compare versions</Tab> : null}
        </TabsList>
        <TabPanel value="overview">
          <Overview pack={p} />
        </TabPanel>
        {visible.includes('controls') ? (
          <TabPanel value="controls">
            <ControlsTable controls={adds.controls ?? []} />
          </TabPanel>
        ) : null}
        {visible.includes('rules') ? (
          <TabPanel value="rules">
            <RulesTable rules={adds.rules ?? []} />
          </TabPanel>
        ) : null}
        {visible.includes('settings') ? (
          <TabPanel value="settings">
            <SettingsTable settings={adds.settings ?? []} />
          </TabPanel>
        ) : null}
        <TabPanel value="files">
          <PackFiles pack={p} />
        </TabPanel>
        <TabPanel value="tests">
          <PackTests pack={p} />
        </TabPanel>
        {visible.includes('compare') ? (
          <TabPanel value="compare">
            <PackCompare pack={p} />
          </TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}

function Overview({ pack: p }: { pack: PackDetail }) {
  const m = p.manifest;
  const requires = m.requires ?? [];
  return (
    <div className={s.stack}>
      {m.disclaimer ? (
        <Callout
          tone={p.type === 'compliance' ? 'warning' : 'info'}
          title={
            p.type === 'compliance' ? 'Supports compliance, does not certify it' : 'Disclaimer'
          }
        >
          {m.disclaimer}
        </Callout>
      ) : p.type === 'compliance' ? (
        <Callout tone="warning" title="Supports compliance, does not certify it">
          This compliance pack has no disclaimer text.
        </Callout>
      ) : null}
      <Card aria-labelledby="pack-overview">
        <CardHeader titleId="pack-overview" title="About this pack" />
        <CardBody>
          <KeyValueList
            items={[
              { key: 'title', label: 'Title', value: m.title },
              {
                key: 'description',
                label: 'Description',
                value: m.description ? (
                  <span style={{ whiteSpace: 'pre-line' }}>{m.description}</span>
                ) : null,
              },
              { key: 'publisher', label: 'Publisher', value: m.publisher },
              { key: 'licence', label: 'Licence', value: m.licence },
              {
                key: 'standards',
                label: 'Standards',
                value:
                  m.standards && m.standards.length > 0 ? (
                    <span className={s.badges}>
                      {m.standards.map((x) => (
                        <Badge key={x}>{x}</Badge>
                      ))}
                    </span>
                  ) : null,
              },
              {
                key: 'digest',
                label: 'Digest',
                value: (
                  <span className={s.row}>
                    <Mono className={s.xs} style={{ overflowWrap: 'anywhere' }}>
                      {p.digest}
                    </Mono>
                    <CopyButton value={p.digest} label="Copy digest" />
                  </span>
                ),
              },
              {
                key: 'created',
                label: 'Uploaded',
                value: (
                  <>
                    <Timestamp value={p.created_at} /> by {p.created_by}
                  </>
                ),
              },
              {
                key: 'published',
                label: 'Published',
                value: p.published_at ? (
                  <>
                    <Timestamp value={p.published_at} />
                    {p.published_by ? ` by ${p.published_by}` : ''}
                  </>
                ) : null,
              },
              {
                key: 'review',
                label: 'Compliance review',
                value: p.reviewed_by_name ? (
                  <span className={s.cellStack}>
                    <span>
                      {p.reviewed_by_name}
                      {p.reviewed_by_role ? ` (${p.reviewed_by_role})` : ''}
                    </span>
                    {p.reviewed_at ? (
                      <span className={`${s.muted} ${s.small}`}>
                        <Timestamp value={p.reviewed_at} />
                      </span>
                    ) : null}
                  </span>
                ) : p.type === 'compliance' ? (
                  'Not reviewed yet'
                ) : null,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="pack-requires" flush>
        <CardHeader
          titleId="pack-requires"
          title="Requires"
          description="Packs that must be in the same blueprint, in a matching version."
        />
        <CardBody>
          {requires.length === 0 ? (
            <p className={s.muted} style={{ padding: 'var(--space-4) var(--space-5)' }}>
              No other packs are required.
            </p>
          ) : (
            <ul style={{ listStyle: 'none' }}>
              {requires.map((r) => (
                <li
                  key={r.name}
                  style={{
                    padding: 'var(--space-3) var(--space-5)',
                    borderBottom: '1px solid var(--color-border-subtle)',
                  }}
                >
                  <span className={s.row}>
                    <Mono>{r.name}</Mono>
                    <Badge>{r.versions}</Badge>
                  </span>
                  {r.reason ? <p className={`${s.muted} ${s.small}`}>{r.reason}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
