import { CircleCheck, UserCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { isApiError } from '@/api/errors';
import { useBreaks, useUpdateBreak } from '@/api/loads';
import type { BreakOrigin, BreakStatus, LoadRun, ReconBreak } from '@/api/loads-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { reasonError } from '@/lib/forms';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import { BREAK_STATUS, formatAmount, formatDifference, isUuid, runLabel } from './model';
import { DiffMark, PersonField, Why } from './Parts';

const ALL = '__all__';

/**
 * Reconciliation breaks (E14.F1.S2, E15.F1.S2): every difference in counts or amounts. A break
 * has a named owner and closes only with a reason of at least ten characters.
 */
export function BreaksView({
  project,
  runs,
  runId,
  onRun,
}: {
  project: Project;
  runs: LoadRun[];
  runId: string | null;
  onRun: (id: string | null) => void;
}) {
  const [origin, setOrigin] = useState<BreakOrigin | ''>('');
  const [status, setStatus] = useState<BreakStatus | ''>('open');
  const list = useBreaks(project.id, {
    ...(origin ? { origin } : {}),
    ...(status ? { status } : {}),
    ...(runId ? { load_run_id: runId } : {}),
  });
  const canResolve = project.permissions.includes('review:resolve');
  return (
    <Card flush aria-labelledby="breaks-head">
      <CardHeader
        titleId="breaks-head"
        title="Reconciliation breaks"
        description="Each difference in record counts or measured amounts between source, transformed and accepted records, or between the live source and the target during coexistence."
      />
      <div className={styles.filters} role="group" aria-label="Filter breaks">
        <Field label="Origin">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All' },
              { value: 'load', label: 'Load runs' },
              { value: 'coexistence', label: 'Coexistence' },
            ]}
            value={origin || ALL}
            onValueChange={(v) => setOrigin(v === ALL ? '' : (v as BreakOrigin))}
          />
        </Field>
        <Field label="Status">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All' },
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
            ]}
            value={status || ALL}
            onValueChange={(v) => setStatus(v === ALL ? '' : (v as BreakStatus))}
          />
        </Field>
        <Field label="Load run">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All runs' },
              ...runs.map((r) => ({ value: r.id, label: runLabel(r) })),
            ]}
            value={runId ?? ALL}
            onValueChange={(v) => onRun(v === ALL ? null : v)}
          />
        </Field>
      </div>
      <div className={styles.bar}>
        <span className={s.muted} aria-live="polite">
          {list.data ? `${list.data.length.toLocaleString()} break(s)` : 'Loading…'}
        </span>
      </div>
      {list.isError ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <ApiErrorView
            error={list.error}
            title="Could not load the breaks"
            compact
            onRetry={() => void list.refetch()}
          />
        </div>
      ) : list.isPending ? (
        <div style={{ padding: 'var(--space-4)' }}>
          <Skeleton height="8rem" />
        </div>
      ) : list.data.length === 0 ? (
        <EmptyState compact title="No breaks" body="Nothing matches these filters." />
      ) : (
        <ul
          className={styles.plainList}
          aria-label="Reconciliation breaks"
          aria-busy={list.isFetching}
        >
          {list.data.map((b) => (
            <BreakItem
              key={b.id}
              project={project}
              item={b}
              runNumber={runs.find((r) => r.id === b.load_run_id)?.number ?? null}
              canResolve={canResolve}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One break with its values, owner and the actions to name an owner and close it. */
export function BreakItem({
  project,
  item: b,
  runNumber,
  canResolve,
}: {
  project: Project;
  item: ReconBreak;
  runNumber: number | null;
  canResolve: boolean;
}) {
  const update = useUpdateBreak(project.id);
  const close = useUpdateBreak(project.id);
  const [owner, setOwner] = useState(b.owner_user_id ?? '');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const base = useId();
  const st = BREAK_STATUS[b.status];
  const ownerServer = isApiError(update.error) ? update.error.fieldErrors.owner_user_id : undefined;
  const closeServer = isApiError(close.error)
    ? (close.error.fieldErrors.close_reason ?? close.error.fieldErrors.owner_user_id)
    : undefined;
  const reasonErr = reasonError(reason);
  const ownerChanged = owner !== '' && owner !== (b.owner_user_id ?? '');
  const ownerWhy = !canResolve
    ? 'Naming an owner needs review resolution on this project.'
    : owner === ''
      ? 'Choose a person first.'
      : !isUuid(owner)
        ? 'Enter a valid user ID.'
        : !ownerChanged
          ? 'This person is already the owner.'
          : null;
  const closeWhy = !canResolve
    ? 'Closing a break needs review resolution on this project.'
    : !b.owner_user_id
      ? 'A break has an owner until it is closed: name one first.'
      : null;
  const title = `${b.scope}: ${b.measure}`;
  return (
    <li className={styles.breakCard}>
      <span className={s.badges}>
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
        <Badge>
          {b.origin === 'load' ? (runNumber ? `Run ${String(runNumber)}` : 'Load') : 'Coexistence'}
        </Badge>
      </span>
      <strong>
        <Mono className={s.small}>{b.scope}</Mono>: {b.measure}
      </strong>
      {b.detail ? <span className={s.small}>{b.detail}</span> : null}
      <KeyValueList
        items={[
          { key: 'sv', label: 'Expected', value: formatAmount(b.source_value) },
          { key: 'tv', label: 'Found', value: formatAmount(b.target_value) },
          {
            key: 'd',
            label: 'Difference',
            value: (
              <>
                {formatDifference(b.difference)} <DiffMark />
              </>
            ),
          },
          {
            key: 'o',
            label: 'Owner',
            value: b.owner ?? `Nobody named (expected role: ${b.owner_role ?? 'any'})`,
          },
          ...(b.created_at
            ? [{ key: 'c', label: 'Raised', value: <Timestamp value={b.created_at} /> }]
            : []),
          ...(b.status === 'closed'
            ? [
                {
                  key: 'cl',
                  label: 'Closed',
                  value: (
                    <>
                      by {b.closed_by ?? 'unknown'}
                      {b.closed_at ? (
                        <>
                          {' '}
                          <Timestamp value={b.closed_at} />
                        </>
                      ) : null}
                      : “{b.close_reason}”
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {b.status === 'open' ? (
        <div className={s.grid2}>
          <div className={s.stackSm}>
            <PersonField
              label={`Owner of ${title}`}
              value={owner}
              currentName={b.owner}
              onChange={setOwner}
              error={ownerServer}
              disabled={!canResolve}
            />
            <div className={s.row}>
              <Button
                size="sm"
                leadingIcon={<UserCheck aria-hidden="true" />}
                disabled={!!ownerWhy}
                loading={update.isPending}
                aria-describedby={ownerWhy ? `${base}-ow` : undefined}
                onClick={() =>
                  update.mutate(
                    { id: b.id, body: { owner_user_id: owner } },
                    { onSuccess: (nb) => toast.success(`Owner named: ${nb.owner ?? 'saved'}`) },
                  )
                }
              >
                Name owner
              </Button>
              {ownerWhy ? <Why id={`${base}-ow`}>{ownerWhy}</Why> : null}
            </div>
            <FormError error={update.error} fields={['owner_user_id']} />
          </div>
          <div className={s.stackSm}>
            <Field
              label={`Reason to close ${title}`}
              required
              help="At least 10 characters. Say why the difference is resolved or accepted."
              error={(tried ? reasonErr : undefined) ?? closeServer}
              disabled={!!closeWhy}
            >
              <Textarea
                rows={2}
                value={reason}
                maxLength={4000}
                disabled={!!closeWhy}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className={s.row}>
              <Button
                size="sm"
                leadingIcon={<CircleCheck aria-hidden="true" />}
                disabled={!!closeWhy}
                loading={close.isPending}
                aria-describedby={closeWhy ? `${base}-cw` : undefined}
                onClick={() => {
                  setTried(true);
                  if (reasonErr) return;
                  close.mutate(
                    { id: b.id, body: { close_reason: reason.trim() } },
                    { onSuccess: () => toast.success('Break closed') },
                  );
                }}
              >
                Close break
              </Button>
              {closeWhy ? <Why id={`${base}-cw`}>{closeWhy}</Why> : null}
            </div>
            <FormError error={close.error} fields={['close_reason', 'owner_user_id']} />
          </div>
        </div>
      ) : null}
    </li>
  );
}
