import { Link, useNavigate } from '@tanstack/react-router';
import { Layers3, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAdapters } from '@/api/adapters';
import { useBaseline, useBaselines, useCreateBaseline } from '@/api/targets';
import type { Baseline, BaselineObject } from '@/api/types';
import { isApiError } from '@/api/errors';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { usePermissions } from '@/app/permissions';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';

export function SyntheticBadge({ synthetic }: { synthetic: boolean }) {
  return synthetic ? (
    <Badge tone="warning">Synthetic: not the vendor&apos;s real baseline</Badge>
  ) : (
    <Badge tone="success">Vendor baseline</Badge>
  );
}

export function BaselinesPage() {
  useDocumentTitle('Target baselines');
  const baselines = useBaselines();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const columns = useMemo(() => {
    const col = createDataTableColumns<Baseline>();
    return col.columns([
      col.accessor('name', {
        header: 'Baseline',
        size: 260,
        cell: (info) => (
          <span className={s.cellStack}>
            <Link
              to="/baselines/$baselineId"
              params={{ baselineId: info.row.original.id }}
              className={s.cellLink}
              onClick={(e) => e.stopPropagation()}
            >
              {info.getValue()}
            </Link>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.adapter_name}</Mono>
          </span>
        ),
      }),
      col.accessor('product_version', { header: 'Product version', size: 140 }),
      col.accessor('synthetic', {
        header: 'Kind',
        size: 230,
        cell: (info) => <SyntheticBadge synthetic={info.getValue()} />,
      }),
      col.accessor('object_count', { header: 'Objects', size: 100, meta: { align: 'end' } }),
      col.accessor('provided_by', {
        header: 'Provided',
        size: 200,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.getValue()}</span>
            <span className={`${s.muted} ${s.xs}`}>
              <Timestamp value={info.row.original.provided_on} format="absolute" />
            </span>
          </span>
        ),
      }),
      col.accessor('pinned_projects', { header: 'Projects', size: 90, meta: { align: 'end' } }),
    ]);
  }, []);
  return (
    <>
      <PageHeader
        title="Target baselines"
        description="The target product's metadata as delivered, stored by name and never changed. A project is pinned to one baseline; a new version of the metadata is a new baseline with a new name."
        actions={
          can('baseline:manage') ? (
            <Button
              variant="primary"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => setAdding(true)}
            >
              Add baseline
            </Button>
          ) : null
        }
      />
      <Card flush aria-label="Baselines">
        <CardBody>
          {baselines.isError ? (
            <ApiErrorView
              error={baselines.error}
              title="Could not load baselines"
              onRetry={() => void baselines.refetch()}
            />
          ) : (
            <DataTable
              label="Target baselines"
              data={baselines.data}
              columns={columns}
              getRowId={(b) => b.id}
              loading={baselines.isPending}
              onRowClick={(b) =>
                void navigate({ to: '/baselines/$baselineId', params: { baselineId: b.id } })
              }
              empty={<EmptyState compact icon={<Layers3 />} title="No baselines" />}
            />
          )}
        </CardBody>
      </Card>
      {adding ? <AddBaselineDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function AddBaselineDialog({ onClose }: { onClose: () => void }) {
  const adapters = useAdapters();
  const create = useCreateBaseline();
  const navigate = useNavigate();
  const [f, setF] = useState({ adapter_name: '', name: '', baseline_yaml: '', synthetic: false });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'adapter_name' | 'name' | 'baseline_yaml'> = {};
  if (!f.adapter_name) clientErrors.adapter_name = 'Choose the target adapter.';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,99}$/.test(f.name))
    clientErrors.name = 'Use 2–100 letters, digits, spaces, dots, dashes or underscores.';
  if (f.baseline_yaml.trim().length < 10)
    clientErrors.baseline_yaml = 'Paste the baseline in astra.baseline/v1 format.';
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const yamlErrors = isApiError(create.error)
    ? create.error.fieldErrorList.filter((e) => e.field.startsWith('baseline_yaml.'))
    : [];
  const targetNames = [
    ...new Set((adapters.data ?? []).filter((a) => a.type === 'target_adapter').map((a) => a.name)),
  ];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add a target baseline"
      description="Baselines never change once stored. If the vendor delivers new metadata, add it as a new baseline with a new name."
      submitLabel="Store baseline"
      size="lg"
      pending={create.isPending}
      error={yamlErrors.length ? null : create.error}
      fields={['adapter_name', 'name', 'baseline_yaml', 'synthetic']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          { ...f, name: f.name.trim() },
          {
            onSuccess: (b) => {
              toast.success(`Baseline ${b.name} stored`, {
                description: `${b.object_count} objects.`,
              });
              onClose();
              void navigate({ to: '/baselines/$baselineId', params: { baselineId: b.id } });
            },
          },
        );
      }}
    >
      <div className={s.grid2}>
        <Field label="Target adapter" error={errors.adapter_name} required>
          <Select
            options={targetNames.map((n) => ({ value: n, label: n }))}
            value={f.adapter_name}
            onValueChange={(v) => setF((x) => ({ ...x, adapter_name: v }))}
            placeholder="Choose an adapter"
          />
        </Field>
        <Field label="Name" error={errors.name} required>
          <Input
            value={f.name}
            onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))}
            maxLength={100}
          />
        </Field>
      </div>
      <Field
        label="Baseline (YAML or JSON, astra.baseline/v1)"
        error={errors.baseline_yaml}
        required
      >
        <Textarea
          mono
          rows={14}
          value={f.baseline_yaml}
          onChange={(e) => setF((x) => ({ ...x, baseline_yaml: e.target.value }))}
          spellCheck={false}
        />
      </Field>
      {yamlErrors.length > 0 ? (
        <Callout tone="danger" title="The baseline does not match astra.baseline/v1" live>
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {yamlErrors.map((e, i) => (
              <li key={i}>
                <Mono className={s.small}>{e.field.replace(/^baseline_yaml\./, '')}</Mono>:{' '}
                {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Field
        label="Synthetic: not the vendor's real baseline"
        help="Mark test or invented metadata so nobody mistakes it for the vendor's."
        inline
      >
        <Checkbox
          checked={f.synthetic}
          onCheckedChange={(v) => setF((x) => ({ ...x, synthetic: v === true }))}
        />
      </Field>
    </FormDialog>
  );
}

const PAGE = 100;

export function BaselineDetailPage({ baselineId }: { baselineId: string }) {
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const detail = useBaseline(baselineId, {
    ...(type ? { object_type: type } : {}),
    offset,
    limit: PAGE,
  });
  useDocumentTitle(detail.data ? detail.data.baseline.name : 'Baseline');
  const columns = useMemo(() => {
    const col = createDataTableColumns<BaselineObject>();
    return col.columns([
      col.accessor('name', {
        header: 'Object',
        size: 280,
        cell: (info) => (
          <span className={s.cellStack}>
            <Mono className={s.small}>
              {info.row.original.schema ? `${info.row.original.schema}.` : ''}
              {info.getValue()}
            </Mono>
            <span className={`${s.muted} ${s.xs}`}>{info.row.original.type}</span>
          </span>
        ),
      }),
      col.display({
        id: 'columns',
        header: 'Columns',
        size: 460,
        cell: (info) => {
          const cols = info.row.original.columns ?? [];
          if (!cols.length) return <span className={s.muted}>—</span>;
          return (
            <span className={s.small} style={{ whiteSpace: 'normal' }}>
              {cols.map((c) => [c.name, c.type].filter(Boolean).map(String).join(' ')).join(', ')}
            </span>
          );
        },
      }),
    ]);
  }, []);
  if (detail.isPending) return <Skeleton height="16rem" />;
  if (detail.isError) {
    return (
      <ApiErrorView
        error={detail.error}
        title="Could not load this baseline"
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const b = detail.data.baseline;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Target baselines', to: '/baselines' }, { label: b.name }]}
        title={b.name}
        meta={<SyntheticBadge synthetic={b.synthetic} />}
        description={
          <>
            <Mono>{b.adapter_name}</Mono> · product version {b.product_version}
          </>
        }
      />
      <div className={s.stack}>
        {b.synthetic ? (
          <Callout tone="warning" title="Synthetic baseline">
            This is not the vendor&apos;s real baseline. Plans and deltas built on it are
            illustrative.
          </Callout>
        ) : null}
        <Card aria-labelledby="bl-about">
          <CardHeader titleId="bl-about" title="About" />
          <CardBody>
            <KeyValueList
              items={[
                { key: 'by', label: 'Provided by', value: b.provided_by },
                {
                  key: 'on',
                  label: 'Provided on',
                  value: <Timestamp value={b.provided_on} format="absolute" />,
                },
                {
                  key: 'objects',
                  label: 'Objects',
                  value: Object.entries(b.objects_by_type)
                    .map(([t, n]) => `${t}: ${n}`)
                    .join(', '),
                },
                {
                  key: 'stored',
                  label: 'Stored',
                  value: (
                    <>
                      <Timestamp value={b.created_at} />
                      {b.created_by ? ` by ${b.created_by}` : ''}
                    </>
                  ),
                },
                { key: 'digest', label: 'Digest', value: <Mono className={s.xs}>{b.digest}</Mono> },
                { key: 'pins', label: 'Pinned by projects', value: b.pinned_projects },
              ]}
            />
          </CardBody>
        </Card>
        <Card flush aria-labelledby="bl-objects">
          <CardHeader
            titleId="bl-objects"
            title={`Objects (${detail.data.total.toLocaleString()})`}
            actions={
              <div style={{ width: '14rem' }}>
                <Field label="Object type" hideLabel>
                  <Select
                    size="sm"
                    options={[
                      { value: '__all__', label: 'All types' },
                      ...Object.keys(b.objects_by_type).map((t) => ({ value: t, label: t })),
                    ]}
                    value={type || '__all__'}
                    onValueChange={(v) => {
                      setType(v === '__all__' ? '' : v);
                      setOffset(0);
                    }}
                  />
                </Field>
              </div>
            }
          />
          <CardBody>
            <DataTable
              label="Baseline objects"
              data={detail.data.objects}
              columns={columns}
              getRowId={(o) => `${o.type}:${o.schema ?? ''}:${o.name}`}
            />
          </CardBody>
          <div className={s.center} style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <span className={`${s.muted} ${s.small}`} role="status">
              {detail.data.total === 0
                ? '0'
                : `${offset + 1}–${Math.min(offset + PAGE, detail.data.total)}`}{' '}
              of {detail.data.total}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + PAGE >= detail.data.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
