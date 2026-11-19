import { RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/api/errors';
import { useLoadRecords, useLoadRun, useReload, useTriageRecord } from '@/api/loads';
import {
  FAILED_STATUSES,
  TRIAGE_STATES,
  type FailedStatus,
  type LoadRecord,
  type LoadRun,
  type LoadRunDetail,
  type RecordQuery,
  type SettableTriage,
  type TriageState,
} from '@/api/loads-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { reasonError } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PlainText,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import {
  checkFixedPayload,
  FAILED_LABELS,
  pairKey,
  recordStatus,
  reloadBlockedReason,
  TRIAGE_LABELS,
  triageLabel,
} from './model';
import { RunPicker, Why } from './Parts';

const ALL = '__all__';
const PAGE = 100;

/**
 * The error queue of one run (E13.F1.S2): records the target rejected, validation stopped, or
 * that could not be sent. Filter, assign an owner, triage, enter a fixed payload with the same
 * columns, then reload only the chosen records.
 */
export function ErrorQueueView({
  project,
  runs,
  runsPending,
  runId,
  onRun,
  onReloaded,
}: {
  project: Project;
  runs: LoadRun[];
  runsPending: boolean;
  runId: string | null;
  onRun: (id: string) => void;
  onReloaded: (id: string) => void;
}) {
  const run = useLoadRun(project.id, runId);
  const [status, setStatus] = useState<FailedStatus | ''>('');
  const [table, setTable] = useState('');
  const [triage, setTriage] = useState<TriageState | ''>('');
  const [owner, setOwner] = useState('');
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const dOwner = useDebouncedValue(owner.trim(), 300);
  const dText = useDebouncedValue(text.trim(), 300);
  const query: RecordQuery = {
    ...(status ? { status } : {}),
    ...(table ? { table } : {}),
    ...(triage ? { triage } : {}),
    ...(dOwner ? { owner: dOwner } : {}),
    ...(dText ? { q: dText } : {}),
    offset,
    limit: PAGE,
  };
  const records = useLoadRecords(project.id, runId, query);
  const [picked, setPicked] = useState<Map<string, LoadRecord>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const reload = useReload(project.id, runId ?? '');
  const r = run.data;
  const reloadWhy = r
    ? reloadBlockedReason(r, project.permissions.includes('stage:manage'))
    : 'Loading the run…';
  const facets = records.data?.by_status ?? {};
  const failedTotal = FAILED_STATUSES.reduce((n, st) => n + (facets[st] ?? 0), 0);
  const tables = Object.keys(r?.summary.tables ?? {});
  const resetPage = () => {
    setOffset(0);
    setOpen(null);
  };
  const toggle = (rec: LoadRecord, on: boolean) =>
    setPicked((m) => {
      const n = new Map(m);
      if (on) n.set(pairKey(rec.table, rec.key), rec);
      else n.delete(pairKey(rec.table, rec.key));
      return n;
    });
  const items = records.data?.items ?? [];
  const pickedHere = items.filter((x) => picked.has(pairKey(x.table, x.key))).length;
  const openRecord = items.find((x) => pairKey(x.table, x.key) === open) ?? null;

  if (!runsPending && runs.length === 0) {
    return (
      <EmptyState
        title="No load runs yet"
        body="Start a rehearsal on the Load runs section first."
      />
    );
  }
  return (
    <div className={s.stack}>
      <Card aria-labelledby="queue-head">
        <CardHeader
          titleId="queue-head"
          title="Error queue"
          description="Records the target rejected (with its HTTP status and reason), records a blocking validation rule stopped, and records that could not be sent."
        />
        <CardBody className={s.stackSm}>
          <div className={s.filters}>
            <RunPicker runs={runs} value={runId} onChange={onRun} />
          </div>
          <div role="status" aria-live="polite" className={s.badges}>
            {FAILED_STATUSES.map((st) => (
              <Badge key={st} tone={(facets[st] ?? 0) > 0 ? recordStatus(st).tone : 'neutral'}>
                {FAILED_LABELS[st]}: {(facets[st] ?? 0).toLocaleString()}
              </Badge>
            ))}
          </div>
        </CardBody>
      </Card>
      <div className={styles.layout}>
        <Card flush aria-labelledby="records-head">
          <CardHeader titleId="records-head" title="Failed records" />
          <div className={styles.filters} role="group" aria-label="Filter failed records">
            <Field label="Status">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: `All failed (${failedTotal.toLocaleString()})` },
                  ...FAILED_STATUSES.map((st) => ({
                    value: st,
                    label: `${FAILED_LABELS[st]} (${(facets[st] ?? 0).toLocaleString()})`,
                  })),
                ]}
                value={status || ALL}
                onValueChange={(v) => {
                  setStatus(v === ALL ? '' : (v as FailedStatus));
                  resetPage();
                }}
              />
            </Field>
            <Field label="Table">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'All tables' },
                  ...tables.map((t) => ({ value: t, label: t })),
                ]}
                value={table || ALL}
                onValueChange={(v) => {
                  setTable(v === ALL ? '' : v);
                  resetPage();
                }}
              />
            </Field>
            <Field label="Triage">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'Any' },
                  ...TRIAGE_STATES.map((t) => ({ value: t, label: TRIAGE_LABELS[t] })),
                ]}
                value={triage || ALL}
                onValueChange={(v) => {
                  setTriage(v === ALL ? '' : (v as TriageState));
                  resetPage();
                }}
              />
            </Field>
            <Field label="Owner" help="Exact name">
              <Input
                size="sm"
                value={owner}
                maxLength={200}
                onChange={(e) => {
                  setOwner(e.target.value);
                  resetPage();
                }}
              />
            </Field>
            <Field label="Search" help="Record key or reason">
              <Input
                size="sm"
                type="search"
                value={text}
                maxLength={200}
                onChange={(e) => {
                  setText(e.target.value);
                  resetPage();
                }}
              />
            </Field>
          </div>
          <div className={styles.bar}>
            <span className={s.muted} aria-live="polite">
              {records.data
                ? `${records.data.total.toLocaleString()} record(s)${picked.size ? `, ${String(picked.size)} selected` : ''}`
                : 'Loading…'}
            </span>
            <span className={s.row}>
              <Button
                size="sm"
                variant="primary"
                leadingIcon={<RotateCcw aria-hidden="true" />}
                disabled={!!reloadWhy || picked.size === 0}
                loading={reload.isPending}
                aria-describedby="reload-why"
                onClick={() =>
                  reload.mutate(
                    [...picked.values()].map((x) => ({ table: x.table, key: x.key })),
                    {
                      onSuccess: (nr) => {
                        toast.success(`Reload started as run ${String(nr.number)}`);
                        setPicked(new Map());
                        onReloaded(nr.id);
                      },
                    },
                  )
                }
              >
                Reload selected
              </Button>
            </span>
          </div>
          <div style={{ padding: 'var(--space-2) var(--space-4)' }}>
            <Why id="reload-why">
              {reloadWhy ??
                (picked.size === 0
                  ? 'Select failed records to reload them (their fixed payload when one is entered).'
                  : `Reloads ${String(picked.size)} record(s) as a new run with the same approved code.`)}
            </Why>
            <FormError error={reload.error} />
          </div>
          {records.isError ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <ApiErrorView
                error={records.error}
                title="Could not load the error queue"
                compact
                onRetry={() => void records.refetch()}
              />
            </div>
          ) : records.isPending || runId === null ? (
            <div style={{ padding: 'var(--space-4)' }} className={s.stackSm}>
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              title="No failed records"
              body={
                failedTotal
                  ? 'Nothing matches these filters.'
                  : 'Every record of this run was accepted.'
              }
            />
          ) : (
            <>
              {!reloadWhy ? (
                <div className={styles.bar}>
                  <Field label="Select every record on this page" inline>
                    <Checkbox
                      checked={
                        pickedHere === items.length ? true : pickedHere ? 'indeterminate' : false
                      }
                      onCheckedChange={(v) => {
                        for (const x of items) toggle(x, v === true);
                      }}
                    />
                  </Field>
                </div>
              ) : null}
              <ul
                className={styles.list}
                aria-label="Failed records"
                aria-busy={records.isFetching}
              >
                {items.map((rec) => {
                  const k = pairKey(rec.table, rec.key);
                  const st = recordStatus(rec.status);
                  return (
                    <li key={k} className={styles.row}>
                      <Checkbox
                        checked={picked.has(k)}
                        disabled={!!reloadWhy}
                        onCheckedChange={(v) => toggle(rec, v === true)}
                        aria-label={
                          reloadWhy
                            ? `Select ${rec.table} ${rec.key} (not selectable: ${reloadWhy})`
                            : `Select ${rec.table} ${rec.key}`
                        }
                      />
                      <button
                        type="button"
                        className={styles.rowButton}
                        aria-current={open === k ? 'true' : undefined}
                        onClick={() => setOpen(k)}
                      >
                        <span className={styles.rowTitle}>
                          <Mono className={s.xs}>{rec.table}</Mono> {rec.key}
                        </span>
                        <span className={s.badges}>
                          <StatusPill tone={st.tone}>{st.label}</StatusPill>
                          {rec.http_status ? <Badge>HTTP {rec.http_status}</Badge> : null}
                          <Badge>{triageLabel(rec.triage)}</Badge>
                          {rec.fixed_payload ? <Badge tone="info">Fixed payload</Badge> : null}
                        </span>
                        <span className={styles.rowMeta}>
                          {rec.owner ? <span>Owner {rec.owner}</span> : <span>No owner</span>}
                          {rec.reason ? <span>{rec.reason.slice(0, 140)}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className={styles.bar}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE))}
                >
                  Previous
                </Button>
                <span className={s.muted}>
                  {offset + 1}–{offset + items.length} of {records.data.total.toLocaleString()}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={offset + PAGE >= records.data.total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Card>
        <Card aria-labelledby="record-detail-head">
          <CardHeader
            titleId="record-detail-head"
            title={openRecord ? `${openRecord.table} ${openRecord.key}` : 'Record detail'}
          />
          <CardBody className={s.stack}>
            {openRecord && r ? (
              <RecordDetail key={open ?? ''} project={project} run={r} record={openRecord} />
            ) : (
              <EmptyState
                compact
                title="Select a record"
                body="Choose a failed record to see its payload, the target’s answer and the validation failures, and to triage it."
              />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function RecordDetail({
  project,
  run,
  record: rec,
}: {
  project: Project;
  run: LoadRunDetail;
  record: LoadRecord;
}) {
  const triage = useTriageRecord(project.id, run.id);
  const fix = useTriageRecord(project.id, run.id);
  const [owner, setOwner] = useState(rec.owner ?? '');
  const [state, setState] = useState<SettableTriage>(
    rec.triage === 'reloaded' ? 'open' : (rec.triage as SettableTriage),
  );
  const [note, setNote] = useState(rec.note ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [json, setJson] = useState(JSON.stringify(rec.fixed_payload ?? rec.payload, null, 2));
  const [fixTried, setFixTried] = useState(false);
  const can = run.can_triage;
  const locked = rec.triage === 'reloaded';
  const why = !can
    ? 'Working the error queue needs review resolution on this project.'
    : locked
      ? 'The record was reloaded in a later run; triage it there.'
      : null;
  const noteErr = state === 'wont_fix' ? reasonError(note) : undefined;
  const fixed = checkFixedPayload(json, rec.payload);
  const fixErr = 'error' in fixed ? fixed.error : undefined;
  const server = isApiError(triage.error) ? triage.error.fieldErrors : {};
  const fixServer = isApiError(fix.error)
    ? (fix.error.fieldErrors.key ?? fix.error.fieldErrors.fixed_payload)
    : undefined;
  const st = recordStatus(rec.status);
  return (
    <>
      <KeyValueList
        items={[
          { key: 'st', label: 'Status', value: <StatusPill tone={st.tone}>{st.label}</StatusPill> },
          {
            key: 'http',
            label: 'Target HTTP status',
            value: rec.http_status ? String(rec.http_status) : 'Not sent',
          },
          { key: 'reason', label: 'Reason', value: rec.reason ?? '—' },
          { key: 'src', label: 'Source key', value: rec.source_key ?? '—' },
          ...(rec.segment ? [{ key: 'seg', label: 'Segment', value: rec.segment }] : []),
          { key: 'tri', label: 'Triage', value: triageLabel(rec.triage) },
          ...(rec.note ? [{ key: 'note', label: 'Note', value: rec.note }] : []),
        ]}
      />
      <section className={styles.section} aria-labelledby="rec-failures">
        <h3 id="rec-failures" className={styles.sectionTitle}>
          Validation failures ({rec.failures.length})
        </h3>
        {rec.failures.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>No validation failure.</p>
        ) : (
          <ul className={styles.plainList} aria-label="Validation failures">
            {rec.failures.map((f, i) => (
              <li
                key={`${f.rule}:${String(i)}`}
                className={styles.failure}
                data-severity={f.severity}
              >
                <span className={s.badges}>
                  <StatusPill tone={f.severity === 'blocking' ? 'danger' : 'warning'}>
                    {f.severity === 'blocking' ? 'Blocking' : 'Warning'}
                  </StatusPill>
                  <Badge>{f.kind}</Badge>
                  <Mono className={s.xs}>{f.rule}</Mono>
                  {f.column ? (
                    <span className={s.small}>
                      Column <Mono className={s.xs}>{f.column}</Mono>
                    </span>
                  ) : null}
                </span>
                <span className={s.small}>{f.message}</span>
                <span className={s.small}>
                  <strong>Proposed fix:</strong> {f.fix}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section} aria-labelledby="rec-payload">
        <h3 id="rec-payload" className={styles.sectionTitle}>
          Payload
        </h3>
        <PlainText label={`Payload of ${rec.key}`}>
          {JSON.stringify(rec.payload, null, 2)}
        </PlainText>
      </section>
      <section className={styles.section} aria-labelledby="rec-triage">
        <h3 id="rec-triage" className={styles.sectionTitle}>
          Triage
        </h3>
        {why ? <Callout tone="info">{why}</Callout> : null}
        <Field label="Owner" help="Who works this record (a name or email)." error={server.owner}>
          <Input
            value={owner}
            maxLength={200}
            disabled={!!why}
            onChange={(e) => setOwner(e.target.value)}
          />
        </Field>
        <Field label="Triage state">
          <Select
            options={(['open', 'fixed', 'wont_fix'] as const).map((t) => ({
              value: t,
              label: TRIAGE_LABELS[t],
            }))}
            value={state}
            onValueChange={(v) => setState(v as SettableTriage)}
            disabled={!!why}
          />
        </Field>
        <Field
          label="Note"
          required={state === 'wont_fix'}
          help={
            state === 'wont_fix'
              ? 'Say why it will not be fixed: at least 10 characters.'
              : undefined
          }
          error={(submitted ? noteErr : undefined) ?? server.note}
        >
          <Textarea
            rows={2}
            value={note}
            maxLength={2000}
            disabled={!!why}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className={s.row}>
          <Button
            leadingIcon={<Save aria-hidden="true" />}
            disabled={!!why}
            loading={triage.isPending}
            aria-describedby={why ? 'triage-why' : undefined}
            onClick={() => {
              setSubmitted(true);
              if (noteErr) return;
              triage.mutate(
                {
                  table: rec.table,
                  key: rec.key,
                  ...(owner.trim() ? { owner: owner.trim() } : {}),
                  triage: state,
                  ...(note.trim() ? { note: note.trim() } : {}),
                },
                { onSuccess: () => toast.success('Triage saved') },
              );
            }}
          >
            Save triage
          </Button>
          {why ? <Why id="triage-why">{why}</Why> : null}
        </div>
        <FormError error={triage.error} fields={['owner', 'note']} />
      </section>
      <section className={styles.section} aria-labelledby="rec-fix">
        <h3 id="rec-fix" className={styles.sectionTitle}>
          Fixed payload
        </h3>
        <p className={`${s.muted} ${s.small}`}>
          Edit the values; the columns stay the same as the original record. A reload sends the
          fixed payload instead of the original.
        </p>
        <Field
          label="Fixed payload (JSON)"
          error={
            (fixTried || json !== JSON.stringify(rec.fixed_payload ?? rec.payload, null, 2)
              ? fixErr
              : undefined) ?? fixServer
          }
        >
          <Textarea
            mono
            className={styles.json}
            rows={10}
            value={json}
            disabled={!!why}
            spellCheck={false}
            onChange={(e) => setJson(e.target.value)}
          />
        </Field>
        <div className={s.row}>
          <Button
            leadingIcon={<Save aria-hidden="true" />}
            disabled={!!why}
            loading={fix.isPending}
            onClick={() => {
              setFixTried(true);
              if (!('value' in fixed)) return;
              fix.mutate(
                { table: rec.table, key: rec.key, fixed_payload: fixed.value },
                { onSuccess: () => toast.success('Fixed payload saved') },
              );
            }}
          >
            Save fixed payload
          </Button>
        </div>
        <FormError error={fix.error} fields={['key', 'fixed_payload']} />
      </section>
    </>
  );
}
