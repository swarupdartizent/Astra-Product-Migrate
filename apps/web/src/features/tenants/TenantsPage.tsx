import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTenants } from '@/api/tenancy';
import type { Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { usePermissions } from '@/app/permissions';
import { RequirePermission } from '@/app/RequirePermission';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Mono,
  PageHeader,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { CreateTenantDialog } from './CreateTenantDialog';
import { TenantStatusPill } from './TenantStatusPill';

const col = createDataTableColumns<Tenant>();
const columns = col.columns([
  col.accessor('name', {
    header: 'Tenant',
    size: 260,
    cell: (info) => (
      <span className={s.cellStack}>
        <Link
          to="/tenants/$tenantId"
          params={{ tenantId: info.row.original.id }}
          className={s.cellLink}
          onClick={(event) => event.stopPropagation()}
        >
          {info.getValue()}
        </Link>
        <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.slug}</Mono>
      </span>
    ),
  }),
  col.accessor('status', {
    header: 'Status',
    size: 150,
    cell: (info) => <TenantStatusPill status={info.getValue()} />,
  }),
  col.accessor((row) => row.region_name ?? row.region_code, {
    id: 'region',
    header: 'Region',
    size: 190,
    cell: (info) => (
      <span className={s.cellStack}>
        <span>{info.getValue()}</span>
        <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.region_code}</Mono>
      </span>
    ),
  }),
  col.accessor((row) => row.programme_name ?? '', {
    id: 'programme',
    header: 'Programme / partner',
    size: 220,
    cell: (info) => {
      const t = info.row.original;
      if (!t.programme_name && !t.partner_name) return <span className={s.muted}>None</span>;
      return (
        <span className={s.cellStack}>
          <span>{t.programme_name ?? '—'}</span>
          {t.partner_name ? (
            <span className={`${s.muted} ${s.small}`}>{t.partner_name}</span>
          ) : null}
        </span>
      );
    },
  }),
  col.accessor('mfa_required', {
    header: 'Multi-factor',
    size: 130,
    cell: (info) =>
      info.getValue() ? (
        <Badge tone="success">Required</Badge>
      ) : (
        <Badge tone="warning">Not required</Badge>
      ),
  }),
  col.accessor('created_at', {
    header: 'Created',
    size: 140,
    sortFn: 'datetime',
    cell: (info) => <Timestamp value={info.getValue()} />,
  }),
]);

export function TenantsPage() {
  return (
    <RequirePermission permission="tenant:read">
      <TenantsView />
    </RequirePermission>
  );
}

function TenantsView() {
  useDocumentTitle('Tenants');
  const tenants = useTenants();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const canCreate = can('tenant:create');

  const newButton = canCreate ? (
    <Button
      variant="primary"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      New tenant
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Each tenant has its own database, database role and encryption key, in the region chosen when it was created."
        actions={newButton}
      />
      <Card flush aria-label="Tenants">
        <CardBody>
          {tenants.isError ? (
            <ApiErrorView
              error={tenants.error}
              title="Could not load tenants"
              onRetry={() => void tenants.refetch()}
              retrying={tenants.isFetching}
              compact
            />
          ) : (
            <DataTable
              label="Tenants"
              data={tenants.data}
              columns={columns}
              getRowId={(t) => t.id}
              loading={tenants.isPending}
              initialSorting={[{ id: 'name', desc: false }]}
              onRowClick={(t) =>
                void navigate({ to: '/tenants/$tenantId', params: { tenantId: t.id } })
              }
              empty={
                <EmptyState
                  compact
                  icon={<Building2 />}
                  title="No tenants yet"
                  body={
                    canCreate
                      ? 'Create the first tenant to give a customer its own isolated storage and key.'
                      : 'There are no tenants you can see. Ask an administrator if you expected some here.'
                  }
                  action={newButton}
                />
              }
            />
          )}
        </CardBody>
      </Card>
      {creating ? <CreateTenantDialog open onOpenChange={setCreating} /> : null}
    </>
  );
}
