import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import {
  adapterKeys,
  useAdapterRuns,
  useAdapters,
  useCreateSourceConnection,
  useDeleteSourceConnection,
  useSourceConnections,
  useStartAdapterRun,
} from '@/api/adapters';
import { useSecrets } from '@/api/tenancy';
import type { SourceConnection, SourceEngine, Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { validateConnection, type ConnForm } from './model';
import { ActivityImports } from '../discovery/ActivityImports';
import { adapterRunStatus, RUN_KIND_LABELS } from '../adapters/model';

export function SourcesTab({ tenant }: { tenant: Tenant }) {
  const conns = useSourceConnections(tenant.id);
  const canManage = tenant.permissions.includes('source:manage');
  const [creating, setCreating] = useState(false);

  return (
    <div className={s.stack}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <p className={`${s.muted} ${s.small}`} style={{ maxWidth: '48rem' }}>
          Connections to the legacy estate. Every account is checked to be read-only before
          discovery or extraction can start; passwords live in the tenant&apos;s connector secrets.
        </p>
        {canManage ? (
          <Button
            variant="primary"
            leadingIcon={<Plus aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            Add source connection
          </Button>
        ) : null}
      </div>
      {conns.isPending ? (
        <Skeleton height="10rem" />
      ) : conns.isError ? (
        <ApiErrorView
          error={conns.error}
          title="Could not load source connections"
          onRetry={() => void conns.refetch()}
        />
      ) : conns.data.length === 0 ? (
        <EmptyState
          icon={<Database />}
          title="No source connections"
          body={canManage ? 'Add one to check, harvest and extract the estate.' : undefined}
        />
      ) : (
        conns.data.map((c) => <ConnectionCard key={c.id} tenant={tenant} connection={c} />)
      )}
      {creating ? (
        <CreateConnectionDialog tenant={tenant} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

function ConnectionCard({
  tenant,
  connection: c,
}: {
  tenant: Tenant;
  connection: SourceConnection;
}) {
  const runs = useAdapterRuns(c.id);
  const start = useStartAdapterRun(c.id);
  const remove = useDeleteSourceConnection(tenant.id);
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const active = runs.data?.find((r) => r.status === 'queued' || r.status === 'running');
  const checkOk = c.last_check?.status === 'succeeded';

  const run = (kind: 'check' | 'harvest' | 'extract', mode?: 'full' | 'delta') =>
    start.mutate(mode ? { kind, mode } : { kind }, {
      onSuccess: () => toast.info(`${RUN_KIND_LABELS[kind]} started`),
    });

  return (
    <Card aria-labelledby={`conn-${c.id}`}>
      <CardHeader
        titleId={`conn-${c.id}`}
        title={c.name}
        description={
          <>
            <Mono>{c.adapter}</Mono> · {c.engine} · {c.host}:{c.port}/{c.database}
          </>
        }
        actions={
          c.last_check ? (
            <StatusPill tone={checkOk ? 'success' : 'danger'}>
              {checkOk ? 'Read-only check passed' : 'Check failed'}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">Not checked</StatusPill>
          )
        }
      />
      <CardBody className={s.stackSm}>
        <KeyValueList
          items={[
            { key: 'user', label: 'Account', value: <Mono>{c.username}</Mono> },
            { key: 'password', label: 'Password', value: <Mono>{c.password_ref}</Mono> },
            { key: 'encrypt', label: 'Encrypted connection', value: c.encrypt ? 'Yes' : 'No' },
            {
              key: 'checked',
              label: 'Last checked',
              value: c.last_checked_at ? <Timestamp value={c.last_checked_at} /> : null,
            },
          ]}
        />
        {active?.job_id ? (
          <JobProgress
            jobId={active.job_id}
            title={RUN_KIND_LABELS[active.kind] ?? active.kind}
            compact
            onFinished={() => void qc.invalidateQueries({ queryKey: adapterKeys.all })}
          />
        ) : null}
        <FormError error={start.error} />
        <section aria-label={`Runs for ${c.name}`}>
          <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
            Runs
          </h3>
          {runs.isPending ? (
            <Skeleton height="3rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <p className={s.muted}>No runs yet. Start with a connection check.</p>
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm}>
              {runs.data.slice(0, 10).map((r) => {
                const st = adapterRunStatus(r.status);
                return (
                  <li key={r.id} className={s.row}>
                    <StatusPill tone={st.tone}>{st.label}</StatusPill>
                    <Link to="/adapter-runs/$runId" params={{ runId: r.id }}>
                      {RUN_KIND_LABELS[r.kind] ?? r.kind}
                      {r.mode ? ` (${r.mode})` : ''}
                    </Link>
                    <span className={`${s.muted} ${s.xs}`}>
                      <Timestamp value={r.created_at} /> · {r.requested_by}
                    </span>
                    {r.status_detail ? (
                      <span className={`${s.small}`}>{r.status_detail}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <ActivityImports connection={c} />
      </CardBody>
      {c.can_manage ? (
        <CardFooter>
          <Button
            variant="ghost"
            leadingIcon={<Trash aria-hidden="true" />}
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
          <Button
            onClick={() => run('check')}
            loading={start.isPending && start.variables.kind === 'check'}
            disabled={!!active}
          >
            Check connection
          </Button>
          <Button
            onClick={() => run('harvest')}
            disabled={!!active || !checkOk}
            title={checkOk ? undefined : 'Needs a passing connection check'}
          >
            Read metadata and traps
          </Button>
          <Button onClick={() => run('extract', 'full')} disabled={!!active || !checkOk}>
            Full extract
          </Button>
          <Button onClick={() => run('extract', 'delta')} disabled={!!active || !checkOk}>
            Delta extract
          </Button>
        </CardFooter>
      ) : null}
      {!checkOk && c.can_manage ? (
        <p className={s.footerNote}>
          Discovery and extraction start only after a connection check proves the account is
          read-only.
        </p>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone="danger"
        title={`Delete connection ${c.name}?`}
        description="The connection is removed. Its secret stays in the tenant's connector secrets."
        confirmLabel="Delete connection"
        onConfirm={async () => {
          await remove.mutateAsync(c.id);
          toast.success(`Connection ${c.name} deleted`);
        }}
      />
    </Card>
  );
}

function CreateConnectionDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const adapters = useAdapters();
  const secrets = useSecrets(tenant.id);
  const create = useCreateSourceConnection(tenant.id);
  const [f, setF] = useState<ConnForm>({
    name: '',
    adapter: '',
    engine: '',
    host: '',
    port: '1433',
    database: '',
    username: '',
    password_ref: '',
    encrypt: true,
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateConnection(f);
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const sources = (adapters.data ?? []).filter(
    (a) => a.type === 'source_adapter' && a.status === 'published' && a.contract_valid,
  );
  const adapter = sources.find((a) => a.ref === f.adapter);
  const set = <K extends keyof ConnForm>(k: K, v: ConnForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (create.error) create.reset();
  };

  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add source connection"
      description="Use a read-only account. The connection check refuses accounts that can write."
      submitLabel="Add connection"
      size="lg"
      pending={create.isPending}
      error={create.error}
      fields={[
        'name',
        'adapter',
        'engine',
        'host',
        'port',
        'database',
        'username',
        'password_ref',
        'encrypt',
        'project_id',
      ]}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors) || !f.engine) return;
        create.mutate(
          {
            name: f.name,
            adapter: f.adapter,
            engine: f.engine,
            host: f.host.trim(),
            port: Number(f.port),
            database: f.database.trim(),
            username: f.username.trim(),
            password_ref: f.password_ref,
            encrypt: f.encrypt,
          },
          {
            onSuccess: (c) => {
              toast.success(`Connection ${c.name} added`, { description: 'Check it next.' });
              onClose();
            },
          },
        );
      }}
    >
      <div className={s.grid2}>
        <Field label="Name" error={errors.name} required>
          <Input mono value={f.name} onChange={(e) => set('name', e.target.value.toLowerCase())} />
        </Field>
        <Field label="Source adapter" error={errors.adapter} required>
          <Select
            options={sources.map((a) => ({ value: a.ref, label: `${a.title} (${a.ref})` }))}
            value={f.adapter}
            onValueChange={(v) => {
              set('adapter', v);
              const a = sources.find((x) => x.ref === v);
              if (a?.engines.length === 1) set('engine', a.engines[0] as SourceEngine);
            }}
            placeholder={adapters.isPending ? 'Loading…' : 'Choose an adapter'}
          />
        </Field>
        <Field label="Engine" error={errors.engine} required>
          <Select
            options={(adapter?.engines ?? ['sqlserver', 'sqlanywhere']).map((e) => ({
              value: e,
              label: e,
            }))}
            value={f.engine}
            onValueChange={(v) => set('engine', v as SourceEngine)}
            placeholder="Choose the engine"
          />
        </Field>
        <Field label="Host" error={errors.host} required>
          <Input mono value={f.host} onChange={(e) => set('host', e.target.value)} />
        </Field>
        <Field label="Port" error={errors.port} required>
          <Input
            type="number"
            inputMode="numeric"
            value={f.port}
            onChange={(e) => set('port', e.target.value)}
          />
        </Field>
        <Field label="Database" error={errors.database} required>
          <Input mono value={f.database} onChange={(e) => set('database', e.target.value)} />
        </Field>
        <Field label="Read-only account" error={errors.username} required>
          <Input
            mono
            value={f.username}
            onChange={(e) => set('username', e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field
          label="Password secret"
          help={
            <>
              A connector secret in this tenant.{' '}
              <Link
                to="/tenants/$tenantId"
                params={{ tenantId: tenant.id }}
                search={{ tab: 'secrets' }}
              >
                Add a secret
              </Link>
            </>
          }
          error={
            errors.password_ref ??
            (secrets.isError ? 'Secrets could not be listed with your permissions.' : undefined)
          }
          required
        >
          <Select
            options={(secrets.data ?? []).map((x) => ({ value: x.reference, label: x.reference }))}
            value={f.password_ref}
            onValueChange={(v) => set('password_ref', v)}
            placeholder={
              secrets.isPending
                ? 'Loading…'
                : (secrets.data?.length ?? 0) === 0
                  ? 'No secrets yet'
                  : 'Choose a secret'
            }
            disabled={(secrets.data?.length ?? 0) === 0}
          />
        </Field>
      </div>
      <Field label="Encrypt the connection" inline>
        <Switch checked={f.encrypt} onCheckedChange={(v) => set('encrypt', v)} />
      </Field>
      {adapter && !adapter.validated ? (
        <p className={s.small}>
          <Badge tone="warning">Unvalidated</Badge> This adapter has not yet been proven on a real
          estate.
        </p>
      ) : null}
    </FormDialog>
  );
}
