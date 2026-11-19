import { useState } from 'react';
import { useProgramme } from '@/api/programmes';
import { ApiErrorView } from '@/app/ApiErrorView';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Badge, Callout, PageHeader, Skeleton, Tab, TabPanel, Tabs, TabsList } from '@/ui';
import { FleetView } from './FleetView';
import { MeteringView } from './MeteringView';
import {
  partnerScopeText,
  PROGRAMME_SECTION_LABELS,
  PROGRAMME_SECTIONS,
  type ProgrammeSearch,
  type ProgrammeSection,
} from './model';
import { OverviewView } from './OverviewView';
import { PortfolioView } from './PortfolioView';
import styles from './Programmes.module.css';
import { SetupView } from './SetupView';

export interface ProgrammePageProps {
  programmeId: string;
  /** The view from the URL. Without it the page keeps its own state (tests, embedding). */
  search?: ProgrammeSearch;
  /** Called with the whole next view; `replace` for section changes, push for selections. */
  onSearch?: (next: ProgrammeSearch, replace: boolean) => void;
}

export function ProgrammePage(props: ProgrammePageProps) {
  return (
    <RequirePermission permission="tenant:read">
      <ProgrammeDetailView {...props} />
    </RequirePermission>
  );
}

function clean(s: ProgrammeSearch): ProgrammeSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * An installed-base programme (E18): the owner's view of every customer, the shared playbook,
 * the consented fleet scan and Complexity Index, the portfolio plan and commercial metering.
 * A partner sees only its own customers.
 */
function ProgrammeDetailView({ programmeId, search, onSearch }: ProgrammePageProps) {
  const q = useProgramme(programmeId);
  const [local, setLocal] = useState<ProgrammeSearch>({});
  const view = search ?? local;
  const section: ProgrammeSection = view.section ?? 'overview';
  const update = (patch: Partial<ProgrammeSearch>, replace: boolean) => {
    const next = clean({ ...view, ...patch });
    if (onSearch) onSearch(next, replace);
    else setLocal(next);
  };
  useDocumentTitle(q.data ? `${q.data.name} · Programme` : 'Programme');
  const breadcrumbs = [
    { label: 'Programmes', to: '/programmes' as const },
    { label: q.data?.name ?? 'Programme' },
  ];

  if (q.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading programme…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="16rem" height="1.75rem" />} />
        <Skeleton height="14rem" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Programme" />
        <ApiErrorView
          error={q.error}
          title="Could not load this programme"
          onRetry={() => void q.refetch()}
          retrying={q.isFetching}
        />
      </>
    );
  }
  const p = q.data;
  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={p.name}
        meta={
          p.scope === 'partner' ? (
            <Badge tone="info">Partner view</Badge>
          ) : p.can_manage ? (
            <Badge tone="accent">Programme owner</Badge>
          ) : null
        }
        description={p.description || undefined}
      />
      {p.scope === 'partner' ? (
        <div className={styles.scopeBanner}>
          <Callout tone="info" title={partnerScopeText(p.partners)}>
            Other partners’ customers, pods and places in the plan are not shown. Programme-wide
            figures count only your customers.
          </Callout>
        </div>
      ) : null}
      <Tabs value={section} onValueChange={(v) => update({ section: v as ProgrammeSection }, true)}>
        <TabsList aria-label="Programme sections">
          {PROGRAMME_SECTIONS.map((sec) => (
            <Tab key={sec} value={sec}>
              {PROGRAMME_SECTION_LABELS[sec]}
            </Tab>
          ))}
        </TabsList>
        <TabPanel value="overview">
          {section === 'overview' ? (
            <OverviewView
              programme={p}
              onOpenCustomer={(id) => update({ section: 'fleet', customer: id }, false)}
            />
          ) : null}
        </TabPanel>
        <TabPanel value="setup">
          {section === 'setup' ? <SetupView programme={p} /> : null}
        </TabPanel>
        <TabPanel value="fleet">
          {section === 'fleet' ? (
            <FleetView
              programme={p}
              selected={view.customer ?? null}
              onSelect={(id) => update({ customer: id ?? undefined }, id === null)}
            />
          ) : null}
        </TabPanel>
        <TabPanel value="portfolio">
          {section === 'portfolio' ? <PortfolioView programme={p} /> : null}
        </TabPanel>
        <TabPanel value="metering">
          {section === 'metering' ? <MeteringView programme={p} /> : null}
        </TabPanel>
      </Tabs>
    </>
  );
}
