import { ArrowRight, ArrowRightLeft, Globe } from 'lucide-react';
import { useState } from 'react';
import { useMoveRegion, useRegionMoves, useRegions } from '@/api/tenancy';
import type { RegionMove, Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, reasonError, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  Spinner,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
  type Tone,
} from '@/ui';
import s from '../shared.module.css';
import { can, regionMoveError, regionMoveJobId, regionMoveTables } from './model';
import { JobProgress } from '@/app/JobProgress';
import { tenantKeys } from '@/api/tenancy';
import { useQueryClient } from '@tanstack/react-query';
import styles from './RegionTab.module.css';

const MOVE_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

function moveStatus(status: string) {
  return MOVE_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export function RegionTab({ tenant }: { tenant: Tenant }) {
  const moves = useRegionMoves(tenant.id);
  const regions = useRegions();
  const [moving, setMoving] = useState(false);
  const canMove = can(tenant, 'tenant:region_migrate');
  const regionLabel = (code: string) => regions.data?.find((r) => r.code === code)?.name ?? code;
  const current = regions.data?.find((r) => r.code === tenant.region_code);

  return (
    <div className={s.stack}>
      <Card aria-labelledby="region-title">
        <CardHeader
          titleId="region-title"
          title="Region"
          description="Where this tenant's database lives."
          actions={
            canMove ? (
              <Button
                size="sm"
                leadingIcon={<ArrowRightLeft aria-hidden="true" />}
                onClick={() => setMoving(true)}
                disabled={tenant.status !== 'active'}
              >
                Move region
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          <KeyValueList
            items={[
              {
                key: 'region',
                label: 'Current region',
                value: (
                  <>
                    {tenant.region_name ?? tenant.region_code}{' '}
                    <Mono className={s.muted}>({tenant.region_code})</Mono>
                  </>
                ),
              },
              { key: 'jurisdiction', label: 'Jurisdiction', value: current?.jurisdiction },
            ]}
          />
          {canMove && tenant.status !== 'active' ? (
            <p className={`${s.muted} ${s.small}`}>
              Only active tenants can move region. This tenant is {tenant.status}.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card flush aria-labelledby="moves-title">
        <CardHeader
          titleId="moves-title"
          title="Region migrations"
          description="Every move copies each table to the new region, checks row counts match, switches over, then removes the old storage."
        />
        <CardBody>
          {moves.isPending ? (
            <div style={{ padding: 'var(--space-5)' }} aria-busy="true">
              <span className="sr-only">Loading region migrations…</span>
              <Skeleton height="3rem" />
            </div>
          ) : moves.isError ? (
            <ApiErrorView
              error={moves.error}
              title="Could not load region migrations"
              onRetry={() => void moves.refetch()}
              retrying={moves.isFetching}
              compact
            />
          ) : moves.data.length === 0 ? (
            <EmptyState
              compact
              icon={<Globe />}
              title="No region migrations"
              body="This tenant has stayed in the region it was created in."
            />
          ) : (
            <ol className={styles.moves}>
              {moves.data.map((move) => (
                <MoveItem key={move.id} move={move} regionLabel={regionLabel} />
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      {moving ? <MoveRegionDialog tenant={tenant} onClose={() => setMoving(false)} /> : null}
    </div>
  );
}

function MoveItem({ move, regionLabel }: { move: RegionMove; regionLabel: (c: string) => string }) {
  const status = moveStatus(move.status);
  const tables = regionMoveTables(move.detail);
  const error = regionMoveError(move.detail);
  const jobId = regionMoveJobId(move.detail);
  const qc = useQueryClient();
  const active = move.status === 'queued' || move.status === 'running';
  return (
    <li className={styles.move}>
      <div className={styles.moveHeader}>
        <span className={styles.route}>
          {regionLabel(move.from_region)}
          <ArrowRight aria-label="to" className={styles.arrow} />
          {regionLabel(move.to_region)}
        </span>
        <StatusPill tone={status.tone} pulse={move.status === 'running'}>
          {status.label}
        </StatusPill>
      </div>
      <p className={s.small}>
        <span className={s.muted}>Reason: </span>
        {move.reason}
      </p>
      <p className={`${s.muted} ${s.small}`}>
        Requested <Timestamp value={move.requested_at} />
        {move.completed_at ? (
          <>
            {' '}
            · finished <Timestamp value={move.completed_at} />
          </>
        ) : null}
      </p>
      {jobId && active ? (
        <JobProgress
          jobId={jobId}
          title="Region move"
          compact
          onFinished={() => void qc.invalidateQueries({ queryKey: tenantKeys.all })}
        />
      ) : null}
      {error ? (
        <Callout tone="danger" title="The move failed and the tenant stayed where it was">
          <Mono>{error}</Mono>
        </Callout>
      ) : null}
      {tables.length > 0 ? (
        <table className={styles.counts}>
          <caption className="sr-only">Row counts per table</caption>
          <thead>
            <tr>
              <th scope="col">Table</th>
              <th scope="col">Source rows</th>
              <th scope="col">Target rows</th>
              <th scope="col">Check</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => {
              const ok = t.source === t.target;
              return (
                <tr key={t.table}>
                  <th scope="row">
                    <Mono>{t.table}</Mono>
                  </th>
                  <td>{Number.isNaN(t.source) ? '—' : t.source.toLocaleString()}</td>
                  <td>{Number.isNaN(t.target) ? '—' : t.target.toLocaleString()}</td>
                  <td>
                    <StatusPill tone={ok ? 'success' : 'danger'}>
                      {ok ? 'Match' : 'Mismatch'}
                    </StatusPill>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

interface MoveForm {
  to_region: string;
  reason: string;
}

function MoveRegionDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const regions = useRegions();
  const move = useMoveRegion(tenant.id);
  const [form, setForm] = useState<MoveForm>({ to_region: '', reason: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<keyof MoveForm> = {};
  if (!form.to_region) clientErrors.to_region = 'Choose the destination region.';
  const reason = reasonError(form.reason);
  if (reason) clientErrors.reason = reason;
  const errors = mergeFieldErrors(clientErrors, move.error, submitted);
  const options = (regions.data ?? [])
    .filter((r) => r.code !== tenant.region_code)
    .map((r) => ({ value: r.code, label: `${r.name} (${r.code}) · ${r.jurisdiction}` }));
  const target = regions.data?.find((r) => r.code === form.to_region);

  function set(key: keyof MoveForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (move.error) move.reset();
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Move ${tenant.name} to another region`}
      description="The tenant's data is copied to the new region and every table is verified by row count before switching. The old storage is then removed. If anything fails, the tenant stays where it is."
      submitLabel="Move region"
      pending={move.isPending}
      error={move.error}
      fields={['to_region', 'reason']}
      progress={
        <span className={`${s.row} ${s.muted}`}>
          <Spinner />
          Copying and verifying every table{target ? ` in ${target.name}` : ''}. Keep this window
          open.
        </span>
      }
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        move.mutate(
          { to_region: form.to_region, reason: form.reason.trim() },
          {
            onSuccess: (result) => {
              if (result.status === 'queued' || result.status === 'running') {
                toast.info(`Moving ${tenant.name} to ${target?.name ?? result.to_region}`, {
                  description: 'The move runs in the background. Progress shows below.',
                });
              } else if (result.status === 'failed') {
                toast.error('Region move failed', {
                  description:
                    regionMoveError(result.detail) ?? 'The tenant stayed in its original region.',
                });
              } else {
                toast.success(`${tenant.name} moved to ${target?.name ?? result.to_region}`, {
                  description: `${regionMoveTables(result.detail).length} tables copied and verified.`,
                });
              }
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Destination region"
        error={errors.to_region ?? (regions.isError ? 'Regions could not be loaded.' : undefined)}
        required
      >
        <Select
          options={options}
          value={form.to_region}
          onValueChange={(v) => set('to_region', v)}
          placeholder={regions.isPending ? 'Loading regions…' : 'Choose a region'}
          disabled={regions.isPending}
        />
      </Field>
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={3}
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
