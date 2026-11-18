import { Link } from '@tanstack/react-router';
import { Plus, Send, Server } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAdapters, useTargetConstraints } from '@/api/adapters';
import { useJob } from '@/api/jobs';
import { useSecrets } from '@/api/tenancy';
import {
  targetKeys,
  useCreateTargetConnection,
  useLoadCalls,
  useStartLoad,
  useTargetConnections,
} from '@/api/targets';
import type { LoadCall, TargetConnection, Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, reasonError, type FieldErrors } from '@/lib/forms';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
  type Tone,
} from '@/ui';
import s from '../shared.module.css';
import { isBlockedMessage, loadBlockedReason } from '../adapters/model';

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'OK', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  rate_limited: { label: 'Rate limited', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
};

export function TargetsTab({ tenant }: { tenant: Tenant }) {
  const conns = useTargetConnections(tenant.id);
  const canLoad = tenant.permissions.includes('target:load');
  const [creating, setCreating] = useState(false);
  return (
    <div className={s.stack}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <p className={`${s.muted} ${s.small}`} style={{ maxWidth: '48rem' }}>
          Connections to the target product&apos;s APIs. Loads use OAuth2 client credentials, stay
          within the recorded rate limit, and every call is logged. There is no database load.
        </p>
        {canLoad ? (
          <Button
            variant="primary"
            leadingIcon={<Plus aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            Add target connection
          </Button>
        ) : null}
      </div>
      {conns.isPending ? (
        <Skeleton height="8rem" />
      ) : conns.isError ? (
        <ApiErrorView
          error={conns.error}
          title="Could not load target connections"
          onRetry={() => void conns.refetch()}
        />
      ) : conns.data.length === 0 ? (
        <EmptyState icon={<Server />} title="No target connections" />
      ) : (
        conns.data.map((c) => <TargetCard key={c.id} connection={c} canLoad={canLoad} />)
      )}
      {creating ? <CreateTargetDialog tenant={tenant} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function TargetCard({
  connection: c,
  canLoad,
}: {
  connection: TargetConnection;
  canLoad: boolean;
}) {
  const calls = useLoadCalls(c.id);
  const [name, version] = c.adapter.split('@') as [string, string | undefined];
  const constraints = useTargetConstraints(name, version ?? '', version !== undefined);
  const blocked = constraints.data ? loadBlockedReason(constraints.data.load) : null;
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const qc = useQueryClient();
  const columns = useMemo(() => {
    const col = createDataTableColumns<LoadCall>();
    return col.columns([
      col.accessor('created_at', {
        header: 'Time',
        size: 120,
        cell: (info) => <Timestamp value={info.getValue()} />,
      }),
      col.display({
        id: 'call',
        header: 'Call',
        size: 220,
        cell: (info) => (
          <Mono className={s.xs}>
            {info.row.original.method} {info.row.original.path}
          </Mono>
        ),
      }),
      col.accessor('outcome', {
        header: 'Outcome',
        size: 130,
        cell: (info) => {
          const o = OUTCOME[info.getValue()] ?? { label: info.getValue(), tone: 'neutral' as Tone };
          return <StatusPill tone={o.tone}>{o.label}</StatusPill>;
        },
      }),
      col.accessor((x) => x.status_code ?? 0, {
        id: 'code',
        header: 'HTTP',
        size: 70,
        meta: { align: 'end' },
        cell: (info) => info.row.original.status_code ?? '—',
      }),
      col.accessor('records', { header: 'Records', size: 90, meta: { align: 'end' } }),
      col.accessor('waited_ms', {
        header: 'Waited',
        size: 90,
        meta: { align: 'end' },
        cell: (info) => `${Math.round(info.getValue())} ms`,
      }),
      col.accessor('latency_ms', {
        header: 'Latency',
        size: 90,
        meta: { align: 'end' },
        cell: (info) => `${Math.round(info.getValue())} ms`,
      }),
      col.accessor((x) => x.rate_limit_remaining ?? -1, {
        id: 'rl',
        header: 'Limit left',
        size: 100,
        meta: { align: 'end' },
        cell: (info) => info.row.original.rate_limit_remaining ?? '—',
      }),
      col.accessor((x) => x.error ?? '', {
        id: 'error',
        header: 'Error',
        size: 240,
        cell: (info) => (
          <span style={{ whiteSpace: 'normal' }}>{info.row.original.error ?? '—'}</span>
        ),
      }),
    ]);
  }, []);

  return (
    <Card aria-labelledby={`tc-${c.id}`}>
      <CardHeader
        titleId={`tc-${c.id}`}
        title={c.name}
        description={
          <>
            <Mono>{c.adapter}</Mono> · <Mono>{c.base_url}</Mono> · client <Mono>{c.client_id}</Mono>{' '}
            · secret <Mono>{c.client_secret_ref}</Mono>
          </>
        }
      />
      <CardBody className={s.stackSm}>
        {blocked ? (
          <Callout tone="warning" title="Blocked">
            {blocked}
          </Callout>
        ) : null}
        {jobId ? (
          <LoadJob
            jobId={jobId}
            onFinished={() => void qc.invalidateQueries({ queryKey: targetKeys.calls(c.id) })}
          />
        ) : null}
        <section aria-label={`Call log for ${c.name}`}>
          <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
            Call log
          </h3>
          {calls.isError ? (
            <ApiErrorView
              error={calls.error}
              title="Could not load calls"
              compact
              onRetry={() => void calls.refetch()}
            />
          ) : (
            <DataTable
              label={`API calls to ${c.name}, newest first`}
              data={calls.data}
              columns={columns}
              getRowId={(x) => x.id}
              loading={calls.isPending}
              maxHeight="24rem"
              empty={<EmptyState compact title="No calls yet" />}
            />
          )}
        </section>
      </CardBody>
      {canLoad ? (
        <CardFooter>
          <Button leadingIcon={<Send aria-hidden="true" />} onClick={() => setLoading(true)}>
            Load records
          </Button>
        </CardFooter>
      ) : null}
      {loading ? (
        <LoadDialog
          connection={c}
          entities={constraints.data?.load.endpoints.map((e) => e.entity) ?? []}
          onClose={() => setLoading(false)}
          onStarted={(id) => {
            setLoading(false);
            setJobId(id);
          }}
        />
      ) : null}
    </Card>
  );
}

/** Load job progress; an error starting "Blocked:" is a missing input, shown as Blocked. */
export function LoadJob({ jobId, onFinished }: { jobId: string; onFinished: () => void }) {
  const job = useJob(jobId);
  if (job.data?.status === 'failed' && isBlockedMessage(job.data.error)) {
    return (
      <Callout tone="warning" title="Blocked">
        {job.data.error?.replace(/^blocked:\s*/i, '')}
      </Callout>
    );
  }
  return <JobProgress jobId={jobId} title="Load" compact onFinished={onFinished} />;
}

function LoadDialog({
  connection,
  entities,
  onClose,
  onStarted,
}: {
  connection: TargetConnection;
  entities: string[];
  onClose: () => void;
  onStarted: (jobId: string) => void;
}) {
  const start = useStartLoad(connection.id);
  const [entity, setEntity] = useState(entities[0] ?? '');
  const [records, setRecords] = useState('[\n  {}\n]');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  let parsed: Record<string, unknown>[] | null = null;
  let recordsError: string | undefined;
  try {
    const v: unknown = JSON.parse(records);
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      !v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))
    ) {
      recordsError = 'Enter a JSON array of one or more objects.';
    } else parsed = v as Record<string, unknown>[];
  } catch (e) {
    recordsError = `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const clientErrors: FieldErrors<'entity' | 'records' | 'reason'> = {};
  if (!entity) clientErrors.entity = 'Choose what to load.';
  if (recordsError) clientErrors.records = recordsError;
  const r = reasonError(reason);
  if (r) clientErrors.reason = r;
  const errors = mergeFieldErrors(clientErrors, start.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Load records to ${connection.name}`}
      description="Records are sent through the target's API in the background. Every call is logged."
      submitLabel="Start load"
      size="lg"
      pending={start.isPending}
      error={start.error}
      fields={['entity', 'records', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors) || !parsed) return;
        start.mutate(
          { entity, records: parsed, reason: reason.trim() },
          {
            onSuccess: (res) => {
              toast.info('Load started');
              onStarted(res.job_id);
            },
          },
        );
      }}
    >
      <Field
        label="Entity"
        error={errors.entity}
        help={entities.length === 0 ? 'The adapter records no load endpoints.' : undefined}
        required
      >
        <Select
          options={entities.map((e) => ({ value: e, label: e }))}
          value={entity}
          onValueChange={setEntity}
          placeholder="Choose an entity"
          disabled={entities.length === 0}
        />
      </Field>
      <Field label="Records (JSON array)" error={errors.records} required>
        <Textarea
          mono
          rows={10}
          value={records}
          onChange={(e) => setRecords(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}

function CreateTargetDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const adapters = useAdapters();
  const secrets = useSecrets(tenant.id);
  const create = useCreateTargetConnection(tenant.id);
  const [f, setF] = useState({
    name: '',
    adapter: '',
    base_url: 'https://',
    client_id: '',
    client_secret_ref: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<keyof typeof f> = {};
  if (!/^[a-z][a-z0-9-]{2,99}$/.test(f.name))
    clientErrors.name = 'Use 3–100 lowercase letters, digits and hyphens.';
  if (!f.adapter) clientErrors.adapter = 'Choose a target adapter.';
  if (!/^https?:\/\/\S+$/.test(f.base_url) || f.base_url === 'https://')
    clientErrors.base_url = 'Enter the API base URL (HTTPS).';
  if (!f.client_id.trim()) clientErrors.client_id = 'Enter the OAuth2 client id.';
  if (!f.client_secret_ref)
    clientErrors.client_secret_ref = 'Choose the secret holding the client secret.';
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const targets = (adapters.data ?? []).filter(
    (a) => a.type === 'target_adapter' && a.contract_valid && a.status === 'published',
  );
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    if (create.error) create.reset();
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add target connection"
      submitLabel="Add connection"
      pending={create.isPending}
      error={create.error}
      fields={['name', 'adapter', 'base_url', 'client_id', 'client_secret_ref']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          { ...f, client_id: f.client_id.trim() },
          {
            onSuccess: (c) => {
              toast.success(`Connection ${c.name} added`);
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Name" error={errors.name} required>
        <Input mono value={f.name} onChange={(e) => set('name', e.target.value.toLowerCase())} />
      </Field>
      <Field label="Target adapter" error={errors.adapter} required>
        <Select
          options={targets.map((a) => ({ value: a.ref, label: `${a.title} (${a.ref})` }))}
          value={f.adapter}
          onValueChange={(v) => set('adapter', v)}
          placeholder="Choose an adapter"
        />
      </Field>
      <Field label="API base URL" error={errors.base_url} required>
        <Input mono value={f.base_url} onChange={(e) => set('base_url', e.target.value)} />
      </Field>
      <Field label="Client id" error={errors.client_id} required>
        <Input
          mono
          value={f.client_id}
          onChange={(e) => set('client_id', e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field
        label="Client secret"
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
        error={errors.client_secret_ref}
        required
      >
        <Select
          options={(secrets.data ?? []).map((x) => ({ value: x.reference, label: x.reference }))}
          value={f.client_secret_ref}
          onValueChange={(v) => set('client_secret_ref', v)}
          placeholder={(secrets.data?.length ?? 0) === 0 ? 'No secrets yet' : 'Choose a secret'}
          disabled={(secrets.data?.length ?? 0) === 0}
        />
      </Field>
    </FormDialog>
  );
}
