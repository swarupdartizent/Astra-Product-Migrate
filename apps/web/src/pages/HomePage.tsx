import { useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw, UserRound } from 'lucide-react';
import { useHealth, useMe } from '@/api/queries';
import type { Health, RoleAssignment, ScopeType } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { navItems, visibleNavItems } from '@/app/navigation';
import { usePermissions } from '@/app/permissions';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  IconButton,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Timestamp,
  Tooltip,
} from '@/ui';
import styles from './HomePage.module.css';

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  platform: 'Platform',
  programme: 'Programme',
  partner: 'Partner',
  tenant: 'Tenant',
  project: 'Project',
} satisfies Record<ScopeType, string>;

const col = createDataTableColumns<RoleAssignment>();
const roleColumns = col.columns([
  col.accessor('role_label', {
    header: 'Role',
    size: 240,
    cell: (info) => (
      <span className={styles.roleCell}>
        <span className={styles.roleLabel}>{info.getValue()}</span>
        <Mono className={styles.roleCode}>{info.row.original.role}</Mono>
      </span>
    ),
  }),
  col.accessor('scope_type', {
    header: 'Scope',
    size: 140,
    cell: (info) => <Badge>{SCOPE_LABELS[info.getValue()] ?? info.getValue()}</Badge>,
  }),
  col.accessor((row) => row.scope_name ?? '', {
    id: 'scope_name',
    header: 'Applies to',
    size: 260,
    cell: (info) => {
      const row = info.row.original;
      if (row.scope_type === 'platform' && row.scope_id === null) {
        return <span className={styles.muted}>Entire platform</span>;
      }
      return row.scope_name ?? <Mono className={styles.muted}>{row.scope_id ?? '—'}</Mono>;
    },
  }),
]);

function roleRowId(row: RoleAssignment): string {
  return `${row.role}:${row.scope_type}:${row.scope_id ?? '*'}`;
}

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomePage() {
  useDocumentTitle('Home');
  const auth = useAuth();
  const me = useMe();
  const name = me.data?.display_name ?? auth.user?.name ?? null;

  return (
    <>
      <PageHeader
        title={name ? `${greeting(new Date())}, ${name}` : 'Welcome'}
        description={
          me.data ? (
            <>
              Signed in as <span className={styles.email}>{me.data.email}</span>
            </>
          ) : me.isPending ? (
            <Skeleton width="14rem" />
          ) : null
        }
      />
      <div className={styles.grid}>
        <div className={styles.column}>
          <GetStartedCard />
          <RolesCard />
        </div>
        <PlatformStatusCard />
      </div>
    </>
  );
}

/** Real links to the screens this user can open; nothing else. */
function GetStartedCard() {
  const { permissions, isLoading } = usePermissions();
  if (isLoading) return null;
  const items = visibleNavItems(permissions, navItems).filter((item) => item.id !== 'home');
  if (items.length === 0) return null;
  return (
    <Card aria-labelledby="start-title" flush>
      <CardHeader
        titleId="start-title"
        title="Get started"
        description="Screens you can use with your roles."
      />
      <ul className={styles.links}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <Link to={item.to} className={styles.linkRow}>
                <span className={styles.linkIcon} aria-hidden="true">
                  <Icon />
                </span>
                <span className={styles.linkText}>
                  <span className={styles.linkLabel}>{item.label}</span>
                  {item.description ? (
                    <span className={styles.linkDescription}>{item.description}</span>
                  ) : null}
                </span>
                <ChevronRight className={styles.linkChevron} aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RolesCard() {
  const me = useMe();
  return (
    <Card aria-labelledby="roles-title" flush className={styles.rolesCard}>
      <CardHeader
        titleId="roles-title"
        title="Your role assignments"
        description="What you can do, and where. Roles are granted by an administrator."
      />
      <CardBody>
        {me.isError ? (
          <ApiErrorView
            error={me.error}
            title="Could not load your role assignments"
            onRetry={() => void me.refetch()}
            retrying={me.isFetching}
            compact
          />
        ) : (
          <DataTable
            label="Your role assignments"
            data={me.data?.roles}
            columns={roleColumns}
            getRowId={roleRowId}
            loading={me.isPending}
            skeletonRows={3}
            initialSorting={[{ id: 'role_label', desc: false }]}
            empty={
              <EmptyState
                compact
                icon={<UserRound />}
                title="No role assignments yet"
                body="You are signed in, but no roles have been granted to you. Ask a platform administrator for access."
              />
            }
          />
        )}
      </CardBody>
    </Card>
  );
}

function overallTone(status: Health['status']) {
  return status === 'ok' ? 'success' : 'warning';
}

function PlatformStatusCard() {
  const health = useHealth();
  const queryClient = useQueryClient();
  const refreshing = health.isFetching && !health.isPending;

  return (
    <Card aria-labelledby="status-title" className={styles.statusCard}>
      <CardHeader
        titleId="status-title"
        title="Platform status"
        description={
          health.data ? (
            <>
              Checked <Timestamp value={health.dataUpdatedAt} />
            </>
          ) : (
            'Live health of the Astra Migrate API'
          )
        }
        actions={
          <Tooltip content="Check again">
            <IconButton
              label="Check platform status again"
              size="sm"
              icon={<RefreshCw aria-hidden="true" />}
              loading={refreshing}
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['health'] })}
            />
          </Tooltip>
        }
      />
      <CardBody>
        {health.isPending ? (
          <div className={styles.statusLoading} aria-busy="true">
            <span className="sr-only">Loading platform status…</span>
            <Skeleton width="7rem" height="1.25rem" />
            <Skeleton width="100%" />
            <Skeleton width="80%" />
          </div>
        ) : health.isError ? (
          <ApiErrorView
            error={health.error}
            title="Could not load platform status"
            onRetry={() => void health.refetch()}
            retrying={health.isFetching}
            compact
            headingLevel={3}
          />
        ) : (
          <div className={styles.statusBody}>
            <div className={styles.statusSummary}>
              <StatusPill tone={overallTone(health.data.status)}>
                {health.data.status === 'ok' ? 'Operational' : 'Degraded'}
              </StatusPill>
              <span className={styles.version}>
                Version <Mono>{health.data.version}</Mono>
              </span>
            </div>
            {health.data.checks.length > 0 ? (
              <KeyValueList
                items={health.data.checks.map((check) => ({
                  key: check.name,
                  label: (
                    <span className={styles.checkName}>
                      <Activity aria-hidden="true" />
                      <Mono>{check.name}</Mono>
                    </span>
                  ),
                  value: (
                    <span className={styles.checkValue}>
                      <StatusPill tone={check.status === 'ok' ? 'success' : 'danger'}>
                        {check.status === 'ok' ? 'OK' : 'Failing'}
                      </StatusPill>
                      {check.detail ? (
                        <span className={styles.checkDetail}>{check.detail}</span>
                      ) : null}
                    </span>
                  ),
                }))}
              />
            ) : (
              <p className={styles.muted}>The API reported no individual checks.</p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
