import { Search, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import { useUsers } from '@/api/access';
import type { User } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { usePermissions } from '@/app/permissions';
import { RequirePermission } from '@/app/RequirePermission';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { InviteUserDialog } from './InviteUserDialog';
import { assignmentLabel, USER_STATUS } from './model';
import { UserPanel } from './UserPanel';

const col = createDataTableColumns<User>();
const columns = col.columns([
  col.accessor('display_name', {
    header: 'Person',
    size: 260,
    cell: (info) => (
      <span className={s.cellStack}>
        <span className={s.cellPrimary}>{info.getValue()}</span>
        <span className={`${s.muted} ${s.small}`}>{info.row.original.email}</span>
      </span>
    ),
  }),
  col.accessor('status', {
    header: 'Status',
    size: 120,
    cell: (info) => {
      const st = USER_STATUS[info.getValue()];
      return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
    },
  }),
  col.accessor((row) => row.last_seen_at ?? '', {
    id: 'last_seen',
    header: 'Last seen',
    size: 140,
    cell: (info) =>
      info.row.original.last_seen_at ? (
        <Timestamp value={info.row.original.last_seen_at} />
      ) : (
        <span className={s.muted}>Never signed in</span>
      ),
  }),
  col.accessor((row) => row.assignments.length, {
    id: 'assignments',
    header: 'Roles',
    size: 420,
    cell: (info) => {
      const list = info.row.original.assignments;
      if (list.length === 0) return <span className={s.muted}>No roles</span>;
      return (
        <span className={s.badges}>
          {list.map((a) => (
            <Badge key={a.id} tone={a.scope_type === 'platform' ? 'accent' : 'neutral'}>
              {assignmentLabel(a)}
            </Badge>
          ))}
        </span>
      );
    },
  }),
]);

export function AccessPage() {
  return (
    <RequirePermission permission="access:read">
      <AccessView />
    </RequirePermission>
  );
}

function AccessView() {
  useDocumentTitle('Access');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 300);
  const users = useUsers(q);
  const { can } = usePermissions();
  const canManage = can('access:manage');
  const [inviting, setInviting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = users.data?.find((u) => u.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Access"
        description="People and the roles they hold. A role applies at a scope: the whole platform, a programme, a partner or a tenant. Every change is recorded in the audit log."
        actions={
          canManage ? (
            <Button
              variant="primary"
              leadingIcon={<UserRound aria-hidden="true" />}
              onClick={() => setInviting(true)}
            >
              Invite person
            </Button>
          ) : null
        }
      />
      <Card flush aria-label="People">
        <div className={s.toolbar}>
          <div style={{ width: 'min(100%, 22rem)' }}>
            <Field label="Search people" hideLabel>
              <Input
                type="search"
                placeholder="Search by name or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                startAdornment={<Search />}
                endAdornment={
                  users.isFetching && !users.isPending ? <Spinner size={14} /> : undefined
                }
              />
            </Field>
          </div>
          {users.data ? (
            <span className={`${s.muted} ${s.small}`} role="status">
              {users.data.length === 1 ? '1 person' : `${users.data.length} people`}
              {q ? ` matching “${q}”` : ''}
            </span>
          ) : null}
        </div>
        <CardBody>
          {users.isError ? (
            <ApiErrorView
              error={users.error}
              title="Could not load people"
              onRetry={() => void users.refetch()}
              retrying={users.isFetching}
              compact
            />
          ) : (
            <DataTable
              label="People"
              data={users.data}
              columns={columns}
              getRowId={(u) => u.id}
              loading={users.isPending}
              onRowClick={(u) => setSelectedId(u.id)}
              initialSorting={[{ id: 'display_name', desc: false }]}
              empty={
                <EmptyState
                  compact
                  icon={<Users />}
                  title={q ? 'Nobody matches this search' : 'No people yet'}
                  body={
                    q
                      ? 'Try part of a name or email address.'
                      : 'Invite people so roles can be granted before they first sign in.'
                  }
                />
              }
            />
          )}
        </CardBody>
        <p className={s.footerNote}>Select a person to see their roles, grant or remove access.</p>
      </Card>
      {inviting ? (
        <InviteUserDialog
          onClose={() => setInviting(false)}
          onInvited={(user) => setSelectedId(user.id)}
        />
      ) : null}
      {selected ? (
        <UserPanel user={selected} canManage={canManage} onClose={() => setSelectedId(null)} />
      ) : null}
    </>
  );
}
