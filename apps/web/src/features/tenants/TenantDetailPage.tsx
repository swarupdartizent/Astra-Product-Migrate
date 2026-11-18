import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { tenantKeys, useTenant } from '@/api/tenancy';
import { JobProgress } from '@/app/JobProgress';
import { ApiErrorView } from '@/app/ApiErrorView';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Callout, Mono, PageHeader, Skeleton, Tab, TabPanel, Tabs, TabsList, toast } from '@/ui';
import { DangerZoneTab } from './DangerZoneTab';
import { can, TENANT_TABS, type TenantTab } from './model';
import { OverviewTab } from './OverviewTab';
import { PolicyTab } from './PolicyTab';
import { ProjectsTab } from './ProjectsTab';
import { RegionTab } from './RegionTab';
import { SecretsTab } from './SecretsTab';
import { TenantStatusPill } from './TenantStatusPill';

export interface TenantDetailPageProps {
  tenantId: string;
  tab: TenantTab;
}

export function TenantDetailPage(props: TenantDetailPageProps) {
  return (
    <RequirePermission permission="tenant:read">
      <TenantDetail {...props} />
    </RequirePermission>
  );
}

function TenantDetail({ tenantId, tab }: TenantDetailPageProps) {
  const tenant = useTenant(tenantId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  useDocumentTitle(tenant.data ? tenant.data.name : 'Tenant');

  const breadcrumbs = [
    { label: 'Tenants', to: '/tenants' as const },
    { label: tenant.data?.name ?? 'Tenant' },
  ];

  if (tenant.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading tenant…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="16rem" height="1.75rem" />} />
        <Skeleton height="12rem" />
      </div>
    );
  }
  if (tenant.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title="Tenant" />
        <ApiErrorView
          error={tenant.error}
          title="Could not load this tenant"
          onRetry={() => void tenant.refetch()}
          retrying={tenant.isFetching}
        />
      </>
    );
  }

  const t = tenant.data;
  const showSecrets = can(t, 'secrets:read');
  const showDanger = can(t, 'tenant:delete');
  const visible: TenantTab[] = TENANT_TABS.filter(
    (x) => (x !== 'secrets' || showSecrets) && (x !== 'danger' || showDanger),
  );
  const current = visible.includes(tab) ? tab : 'overview';

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={t.name}
        meta={<TenantStatusPill status={t.status} />}
        description={
          <>
            <Mono>{t.slug}</Mono> · {t.region_name ?? t.region_code}
          </>
        }
      />
      {t.active_job ? (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <JobProgress
            jobId={t.active_job.id}
            initial={t.active_job}
            title={
              t.active_job.kind === 'tenant.provision'
                ? 'Provisioning this tenant'
                : 'Moving this tenant to another region'
            }
            onFinished={(job) => {
              void qc.invalidateQueries({ queryKey: tenantKeys.all });
              if (job.status === 'succeeded') toast.success(`${job.title} finished`);
              else if (job.status === 'failed')
                toast.error(`${job.title} failed`, { description: job.error ?? undefined });
            }}
          />
        </div>
      ) : null}
      {t.status === 'failed' || t.status_detail ? (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Callout tone={t.status === 'failed' ? 'danger' : 'info'} title="Status detail">
            {t.status_detail ?? 'The tenant is in a failed state.'}
          </Callout>
        </div>
      ) : null}
      <Tabs
        value={current}
        onValueChange={(value) =>
          void navigate({
            to: '/tenants/$tenantId',
            params: { tenantId },
            search: { tab: value as TenantTab },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Tenant sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="projects">Projects</Tab>
          <Tab value="policy">Security policy</Tab>
          {showSecrets ? <Tab value="secrets">Connector secrets</Tab> : null}
          <Tab value="region">Region</Tab>
          {showDanger ? <Tab value="danger">Danger zone</Tab> : null}
        </TabsList>
        <TabPanel value="overview">
          <OverviewTab tenant={t} />
        </TabPanel>
        <TabPanel value="projects">
          <ProjectsTab tenant={t} />
        </TabPanel>
        <TabPanel value="policy">
          <PolicyTab tenant={t} />
        </TabPanel>
        {showSecrets ? (
          <TabPanel value="secrets">
            <SecretsTab tenant={t} />
          </TabPanel>
        ) : null}
        <TabPanel value="region">
          <RegionTab tenant={t} />
        </TabPanel>
        {showDanger ? (
          <TabPanel value="danger">
            <DangerZoneTab tenant={t} />
          </TabPanel>
        ) : null}
      </Tabs>
    </>
  );
}
