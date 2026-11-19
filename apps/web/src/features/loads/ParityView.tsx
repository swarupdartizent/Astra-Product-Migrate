import { CircleCheck, Plus, Scale, ShieldCheck, Trash } from 'lucide-react';
import { useId, useRef, useState, type RefObject } from 'react';
import { isApiError } from '@/api/errors';
import { useDecideCases, useParityCases, useParityRuns, useStartParityRun } from '@/api/loads';
import {
  FIELD_TYPES,
  PARITY_KINDS,
  type ParityCase,
  type ParityCasePage,
  type ParityFieldType,
  type ParityFile,
  type ParityKind,
  type ParityRun,
} from '@/api/loads-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { reasonError } from '@/lib/forms';
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
  IconButton,
  Input,
  Mono,
  RadioCards,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import { toBase64 } from '../packs/model';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import {
  CASE_KIND_LABELS,
  caseStatus,
  FIELD_TYPE_LABELS,
  formatAmount,
  formatDifference,
  isZero,
  pairKey,
  PARITY_KIND_HELP,
  PARITY_KIND_LABELS,
  parityErrors,
  parityFileError,
  specOf,
  valueText,
  type FieldRow,
  type ParityForm,
} from './model';
import { DiffMark, Stat, Why } from './Parts';

const ALL = '__all__';
const PAGE = 100;

/**
 * Parity (E14.F2): compare result files produced by both systems case by case; every difference
 * keeps its inputs and both outputs, and a person approves it (recorded) or marks it fixed.
 */
export function ParityView({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [kind, setKind] = useState<ParityKind | ''>('');
  const runs = useParityRuns(project.id, kind);
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const canStart = project.permissions.includes('stage:manage');
  const why = canStart ? null : 'Starting a comparison needs stage management on this project.';
  const select = (id: string) => {
    onSelect(id);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  return (
    <div className={s.stack}>
      <Card aria-labelledby="parity-head">
        <CardHeader
          titleId="parity-head"
          title="Parity"
          description="Compare results from both systems: re-rated policies, report outputs, workflow replays or a closed accounting period. Amounts compare to the cent; cases missing on either side are differences. A run passes when nothing is open."
          actions={
            <Button
              variant="primary"
              leadingIcon={<Scale aria-hidden="true" />}
              disabled={!!why}
              aria-describedby={why ? 'parity-start-why' : undefined}
              onClick={() => setOpen(true)}
            >
              Start a comparison
            </Button>
          }
        />
        {why ? (
          <CardBody>
            <Why id="parity-start-why">{why}</Why>
          </CardBody>
        ) : null}
      </Card>
      <div className={styles.layout}>
        <Card flush aria-labelledby="parity-list-head">
          <CardHeader titleId="parity-list-head" title="Comparisons" />
          <div className={styles.filters} role="group" aria-label="Filter comparisons">
            <Field label="Kind">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'All' },
                  ...PARITY_KINDS.map((k) => ({ value: k, label: PARITY_KIND_LABELS[k] })),
                ]}
                value={kind || ALL}
                onValueChange={(v) => setKind(v === ALL ? '' : (v as ParityKind))}
              />
            </Field>
          </div>
          <div className={styles.bar}>
            <span className={s.muted} aria-live="polite">
              {runs.data ? `${runs.data.length.toLocaleString()} comparison(s)` : 'Loading…'}
            </span>
          </div>
          {runs.isError ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <ApiErrorView
                error={runs.error}
                title="Could not load comparisons"
                compact
                onRetry={() => void runs.refetch()}
              />
            </div>
          ) : runs.isPending ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <Skeleton height="6rem" />
            </div>
          ) : runs.data.length === 0 ? (
            <EmptyState
              compact
              title="No comparisons"
              body="Upload result files from both systems to compare them."
            />
          ) : (
            <ul className={styles.list} aria-label="Parity comparisons" aria-busy={runs.isFetching}>
              {runs.data.map((r) => (
                <li key={r.id} className={styles.row}>
                  <button
                    type="button"
                    className={styles.rowButton}
                    aria-current={r.id === selected ? 'true' : undefined}
                    onClick={() => select(r.id)}
                  >
                    <span className={styles.rowTitle}>{r.name}</span>
                    <span className={s.badges}>
                      <StatusPill tone={r.summary.passed ? 'success' : 'danger'}>
                        {r.summary.passed ? 'Passed' : `${String(r.summary.open)} open`}
                      </StatusPill>
                      <Badge>{PARITY_KIND_LABELS[r.kind]}</Badge>
                    </span>
                    <span className={styles.rowMeta}>
                      <span>{r.summary.cases.toLocaleString()} case(s)</span>
                      <span>{r.summary.differences.toLocaleString()} difference(s)</span>
                      {r.created_at ? <Timestamp value={r.created_at} /> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <ParityPanel key={selected ?? ''} project={project} id={selected} headingRef={headingRef} />
      </div>
      {open ? (
        <StartParityDialog
          project={project}
          onClose={() => setOpen(false)}
          onStarted={(r) => {
            setOpen(false);
            select(r.id);
          }}
        />
      ) : null}
    </div>
  );
}

function ParityPanel({
  project,
  id,
  headingRef,
}: {
  project: Project;
  id: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const [status, setStatus] = useState('open');
  const [offset, setOffset] = useState(0);
  const q = useParityCases(project.id, id, status, offset);
  const run = q.data?.run;
  return (
    <Card aria-labelledby="parity-detail-head">
      <CardHeader
        titleId="parity-detail-head"
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {id === null ? 'Comparison detail' : run ? run.name : 'Loading the comparison…'}
          </span>
        }
        description={
          run ? (
            <span className={s.badges}>
              <StatusPill tone={run.summary.passed ? 'success' : 'danger'}>
                {run.summary.passed ? 'Passed' : 'Not passed'}
              </StatusPill>
              <Badge>{PARITY_KIND_LABELS[run.kind]}</Badge>
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {id === null ? (
          <EmptyState
            compact
            title="Select a comparison"
            body="Choose a comparison to see its differences and decide them."
          />
        ) : q.isPending ? (
          <Skeleton height="18rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load the comparison"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : (
          <ParityBody
            project={project}
            page={q.data}
            status={status}
            onStatus={(v) => {
              setStatus(v);
              setOffset(0);
            }}
            offset={offset}
            onOffset={setOffset}
            fetching={q.isFetching}
          />
        )}
      </CardBody>
    </Card>
  );
}

function ParityBody({
  project,
  page,
  status,
  onStatus,
  offset,
  onOffset,
  fetching,
}: {
  project: Project;
  page: ParityCasePage;
  status: string;
  onStatus: (v: string) => void;
  offset: number;
  onOffset: (n: number) => void;
  fetching: boolean;
}) {
  const r = page.run;
  const sum = r.summary;
  const decide = useDecideCases(project.id, r.id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const noteErr = reasonError(note);
  const openItems = page.items.filter((c) => c.status === 'open');
  const decideWhy = !page.can_decide
    ? 'Deciding differences needs review resolution on this project.'
    : picked.size === 0
      ? 'Select open differences first.'
      : null;
  const totals = Object.entries(sum.totals);
  const submit = (action: 'approve' | 'fixed') => {
    setTried(true);
    if (noteErr) return;
    const cases = page.items
      .filter((c) => picked.has(pairKey(c.key, c.field)))
      .map((c) => ({ key: c.key, field: c.field }));
    decide.mutate(
      { cases, action, note: note.trim() },
      {
        onSuccess: (res) => {
          toast.success(
            `${String(res.decided)} difference(s) ${action === 'approve' ? 'approved' : 'marked fixed'}; ${String(res.open)} open`,
          );
          setPicked(new Set());
          setNote('');
          setTried(false);
        },
      },
    );
  };
  const pickedHere = openItems.filter((c) => picked.has(pairKey(c.key, c.field))).length;
  return (
    <>
      <div className={styles.stats} role="status" aria-live="polite">
        <Stat label="Cases" value={sum.cases.toLocaleString()} />
        <Stat
          label="Differences"
          value={sum.differences.toLocaleString()}
          tone={sum.differences ? 'danger' : 'success'}
        />
        <Stat
          label="Open"
          value={sum.open.toLocaleString()}
          tone={sum.open ? 'danger' : 'success'}
        />
        <Stat
          label="Result"
          value={sum.passed ? 'Passed' : 'Not passed'}
          tone={sum.passed ? 'success' : 'danger'}
        />
      </div>
      <p className={`${s.muted} ${s.small}`}>
        Created by {r.created_by ?? 'unknown'}
        {r.created_at ? (
          <>
            {' '}
            <Timestamp value={r.created_at} />
          </>
        ) : null}
        . Keys <Mono className={s.xs}>{r.spec.keys.join(', ')}</Mono>. Source SHA-256{' '}
        <Mono className={s.xs}>{r.source_sha256.slice(0, 12)}…</Mono>, target{' '}
        <Mono className={s.xs}>{r.target_sha256.slice(0, 12)}…</Mono>.
      </p>
      {totals.length ? (
        <section className={styles.section} aria-labelledby="parity-totals">
          <h3 id="parity-totals" className={styles.sectionTitle}>
            Totals (to the cent)
          </h3>
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Grand totals"
          >
            <table className={styles.table}>
              <caption className="sr-only">Grand total of each money field in both systems</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col" className={styles.num}>
                    Source
                  </th>
                  <th scope="col" className={styles.num}>
                    Target
                  </th>
                  <th scope="col" className={styles.num}>
                    Difference
                  </th>
                </tr>
              </thead>
              <tbody>
                {totals.map(([f, t]) => {
                  const bad = !isZero(t.difference);
                  return (
                    <tr key={f} data-diff={bad || undefined}>
                      <th scope="row">
                        <Mono className={s.xs}>{f}</Mono>
                      </th>
                      <td className={styles.num}>{formatAmount(t.source)}</td>
                      <td className={styles.num}>{formatAmount(t.target)}</td>
                      <td className={styles.num}>
                        {formatDifference(t.difference)}
                        {bad ? (
                          <>
                            {' '}
                            <DiffMark />
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className={styles.section} aria-labelledby="parity-cases">
        <h3 id="parity-cases" className={styles.sectionTitle}>
          Differences ({page.total.toLocaleString()})
        </h3>
        <div className={s.row}>
          <Field label="Status">
            <Select
              size="sm"
              options={[
                { value: 'open', label: 'Open' },
                { value: 'approved', label: 'Approved' },
                { value: 'fixed', label: 'Fixed' },
                { value: ALL, label: 'All' },
              ]}
              value={status || ALL}
              onValueChange={(v) => onStatus(v === ALL ? '' : v)}
            />
          </Field>
          {openItems.length && page.can_decide ? (
            <Field label="Select every open difference on this page" inline>
              <Checkbox
                checked={
                  pickedHere === openItems.length ? true : pickedHere ? 'indeterminate' : false
                }
                onCheckedChange={(v) =>
                  setPicked((p) => {
                    const n = new Set(p);
                    for (const c of openItems) {
                      if (v === true) n.add(pairKey(c.key, c.field));
                      else n.delete(pairKey(c.key, c.field));
                    }
                    return n;
                  })
                }
              />
            </Field>
          ) : null}
        </div>
        {page.items.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>No differences with this status.</p>
        ) : (
          <ul className={styles.plainList} aria-label="Parity differences" aria-busy={fetching}>
            {page.items.map((c) => (
              <CaseItem
                key={pairKey(c.key, c.field)}
                item={c}
                picked={picked.has(pairKey(c.key, c.field))}
                selectable={page.can_decide && c.status === 'open'}
                onPick={(on) =>
                  setPicked((p) => {
                    const n = new Set(p);
                    if (on) n.add(pairKey(c.key, c.field));
                    else n.delete(pairKey(c.key, c.field));
                    return n;
                  })
                }
              />
            ))}
          </ul>
        )}
        {page.total > PAGE ? (
          <div className={s.row}>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => onOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <span className={s.muted}>
              {offset + 1}–{offset + page.items.length} of {page.total.toLocaleString()}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset + PAGE >= page.total}
              onClick={() => onOffset(offset + PAGE)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </section>
      <section className={styles.section} aria-labelledby="parity-decide">
        <h3 id="parity-decide" className={styles.sectionTitle}>
          Decide selected differences ({picked.size})
        </h3>
        <Field
          label="Decision note"
          required
          help="At least 10 characters. Recorded with your name."
          error={
            (tried ? noteErr : undefined) ??
            (isApiError(decide.error) ? decide.error.fieldErrors.note : undefined)
          }
          disabled={!page.can_decide}
        >
          <Textarea
            rows={2}
            value={note}
            maxLength={2000}
            disabled={!page.can_decide}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <div className={s.row}>
          <Button
            variant="primary"
            leadingIcon={<ShieldCheck aria-hidden="true" />}
            disabled={!!decideWhy}
            loading={decide.isPending && decide.variables.action === 'approve'}
            aria-describedby={decideWhy ? 'decide-why' : undefined}
            onClick={() => submit('approve')}
          >
            Approve selected
          </Button>
          <Button
            leadingIcon={<CircleCheck aria-hidden="true" />}
            disabled={!!decideWhy}
            loading={decide.isPending && decide.variables.action === 'fixed'}
            aria-describedby={decideWhy ? 'decide-why' : undefined}
            onClick={() => submit('fixed')}
          >
            Mark selected fixed
          </Button>
          {decideWhy ? <Why id="decide-why">{decideWhy}</Why> : null}
        </div>
        <FormError error={decide.error} fields={['note']} />
      </section>
    </>
  );
}

function CaseItem({
  item: c,
  picked,
  selectable,
  onPick,
}: {
  item: ParityCase;
  picked: boolean;
  selectable: boolean;
  onPick: (on: boolean) => void;
}) {
  const st = caseStatus(c.status);
  const label = `${c.key} ${c.field === '*' ? '(whole case)' : c.field}`;
  const inputs = Object.entries(c.inputs);
  return (
    <li className={`${styles.row} ${styles.failure}`}>
      {selectable ? (
        <Checkbox
          checked={picked}
          onCheckedChange={(v) => onPick(v === true)}
          aria-label={`Select ${label}`}
        />
      ) : null}
      <div className={styles.case} style={{ flex: 1, minWidth: 0 }}>
        <span className={s.badges}>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
          <Badge>{CASE_KIND_LABELS[c.kind] ?? c.kind}</Badge>
          <strong>
            <Mono className={s.small}>{c.key}</Mono>
          </strong>
          {c.field !== '*' ? <Mono className={s.xs}>{c.field}</Mono> : null}
        </span>
        <div className={styles.outputs}>
          <div className={styles.output}>
            <span className={styles.outputLabel}>Source output</span>
            <Mono className={s.small}>
              {c.source_value ?? (c.kind === 'missing_in_source' ? 'Missing' : '—')}
            </Mono>
          </div>
          <div className={styles.output}>
            <span className={styles.outputLabel}>Target output</span>
            <Mono className={s.small}>
              {c.target_value ?? (c.kind === 'missing_in_target' ? 'Missing' : '—')}
            </Mono>
          </div>
        </div>
        {inputs.length ? (
          <span className={s.small}>
            Inputs:{' '}
            {inputs.map(([k, v], i) => (
              <span key={k}>
                {i ? ', ' : ''}
                {k} <Mono className={s.xs}>{valueText(v)}</Mono>
              </span>
            ))}
          </span>
        ) : null}
        {c.decided_by ? (
          <span className={`${s.small} ${s.muted}`}>
            {st.label} by {c.decided_by}
            {c.decided_at ? (
              <>
                {' '}
                <Timestamp value={c.decided_at} />
              </>
            ) : null}
            {c.note ? `: “${c.note}”` : ''}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- start dialog

const EMPTY_ROW: FieldRow = { name: '', type: 'money', target_name: '' };

interface Picked {
  file: File | null;
  error: string | null;
}

function StartParityDialog({
  project,
  onClose,
  onStarted,
}: {
  project: Project;
  onClose: () => void;
  onStarted: (r: ParityRun) => void;
}) {
  const start = useStartParityRun(project.id);
  const [f, setF] = useState<ParityForm>({
    kind: '',
    name: '',
    keys: '',
    inputs: '',
    fields: [{ ...EMPTY_ROW }],
  });
  const [src, setSrc] = useState<Picked>({ file: null, error: null });
  const [tgt, setTgt] = useState<Picked>({ file: null, error: null });
  const [submitted, setSubmitted] = useState(false);
  const [reading, setReading] = useState(false);
  const { form, rows } = parityErrors(f);
  const server = isApiError(start.error) ? start.error.fieldErrors : {};
  const fileErr = (p: Picked) => p.error ?? (p.file ? null : 'Choose a .csv or .json file.');
  const err = (k: keyof typeof form, ...fields: string[]) =>
    (submitted ? form[k] : undefined) ?? fields.map((x) => server[x]).find(Boolean);
  const set = (patch: Partial<ParityForm>) => setF((x) => ({ ...x, ...patch }));
  const setRow = (i: number, patch: Partial<FieldRow>) =>
    set({ fields: f.fields.map((r, n) => (n === i ? { ...r, ...patch } : r)) });
  const read = async (file: File): Promise<ParityFile> => ({
    name: file.name,
    content_base64: toBase64(new Uint8Array(await file.arrayBuffer())),
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Start a parity comparison"
      description="Upload the same results produced by both systems. The files are compared case by case and kept only as SHA-256 digests with the differences."
      submitLabel="Compare"
      size="lg"
      pending={start.isPending || reading}
      error={start.error}
      fields={[
        'kind',
        'name',
        'spec',
        'source',
        'target',
        'source.name',
        'target.name',
        'source.content_base64',
        'target.content_base64',
      ]}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(form).length || Object.keys(rows).length || fileErr(src) || fileErr(tgt))
          return;
        if (!src.file || !tgt.file) return;
        setReading(true);
        Promise.all([read(src.file), read(tgt.file)])
          .then(([source, target]) => {
            setReading(false);
            start.mutate(
              { kind: f.kind as ParityKind, name: f.name.trim(), spec: specOf(f), source, target },
              {
                onSuccess: (r) => {
                  toast.success(
                    r.summary.passed
                      ? 'Parity passed'
                      : `${String(r.summary.differences)} difference(s) found`,
                  );
                  onStarted(r);
                },
              },
            );
          })
          .catch(() => {
            setReading(false);
            setSrc((p) => ({ ...p, error: 'The file could not be read.' }));
          });
      }}
    >
      <RadioCards
        legend="What the files contain"
        options={PARITY_KINDS.map((k) => ({
          value: k,
          label: PARITY_KIND_LABELS[k],
          description: PARITY_KIND_HELP[k],
        }))}
        value={f.kind}
        onValueChange={(k) => set({ kind: k })}
        error={err('kind', 'kind')}
      />
      <Field label="Name" required error={err('name', 'name')}>
        <Input value={f.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field
        label="Key fields"
        required
        help="Comma separated; together they identify each case once in each file (for example policy_no)."
        error={err('keys', 'spec.keys', 'spec')}
      >
        <Input mono value={f.keys} onChange={(e) => set({ keys: e.target.value })} />
      </Field>
      <fieldset className={s.stackSm} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={styles.subTitle}>Compared fields</legend>
        {err('fields', 'spec.fields') ? (
          <p className={s.small} style={{ color: 'var(--color-danger-text)' }} role="alert">
            {err('fields', 'spec.fields')}
          </p>
        ) : null}
        {f.fields.map((r, i) => (
          <FieldRowEditor
            key={i}
            index={i}
            row={r}
            error={submitted ? rows[i] : undefined}
            canRemove={f.fields.length > 1}
            onChange={(p) => setRow(i, p)}
            onRemove={() => set({ fields: f.fields.filter((_, n) => n !== i) })}
          />
        ))}
        <div>
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Plus aria-hidden="true" />}
            disabled={f.fields.length >= 100}
            onClick={() => set({ fields: [...f.fields, { ...EMPTY_ROW }] })}
          >
            Add a field
          </Button>
        </div>
      </fieldset>
      <Field
        label="Input fields shown with each difference"
        help="Optional, comma separated (for example state, effective_date)."
        error={err('inputs', 'spec.inputs')}
      >
        <Input mono value={f.inputs} onChange={(e) => set({ inputs: e.target.value })} />
      </Field>
      <div className={styles.uploads}>
        <FilePick
          label="Source results"
          picked={src}
          onPick={setSrc}
          error={submitted ? fileErr(src) : src.error}
          serverError={server['source.content_base64'] ?? server['source.name'] ?? server.source}
        />
        <FilePick
          label="Target results"
          picked={tgt}
          onPick={setTgt}
          error={submitted ? fileErr(tgt) : tgt.error}
          serverError={server['target.content_base64'] ?? server['target.name'] ?? server.target}
        />
      </div>
    </FormDialog>
  );
}

function FieldRowEditor({
  index,
  row,
  error,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: FieldRow;
  error: string | undefined;
  canRemove: boolean;
  onChange: (p: Partial<FieldRow>) => void;
  onRemove: () => void;
}) {
  const n = String(index + 1);
  return (
    <div className={styles.fieldRow} data-error={error ? true : undefined}>
      <div className={styles.fieldGrid}>
        <Field label={`Field ${n} name`} required error={error}>
          <Input
            mono
            value={row.name}
            maxLength={200}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>
        <Field label={`Field ${n} type`}>
          <Select
            options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))}
            value={row.type}
            onValueChange={(v) => onChange({ type: v as ParityFieldType })}
          />
        </Field>
        <Field label={`Field ${n} name in target`} help="Only when it differs">
          <Input
            mono
            value={row.target_name}
            maxLength={200}
            onChange={(e) => onChange({ target_name: e.target.value })}
          />
        </Field>
        <IconButton
          label={`Remove field ${n}`}
          icon={<Trash aria-hidden="true" />}
          variant="ghost"
          disabled={!canRemove}
          onClick={onRemove}
        />
      </div>
    </div>
  );
}

function FilePick({
  label,
  picked,
  onPick,
  error,
  serverError,
}: {
  label: string;
  picked: Picked;
  onPick: (p: Picked) => void;
  error: string | null;
  serverError: string | undefined;
}) {
  const id = useId();
  const shown = error ?? serverError ?? null;
  return (
    <div className={styles.upload} data-error={shown ? true : undefined}>
      <label htmlFor={id} className={styles.subTitle}>
        {label}
      </label>
      <span id={`${id}-help`} className={`${s.muted} ${s.xs}`}>
        CSV with a header row, or a JSON array of objects. Up to 40 MB.
      </span>
      <input
        id={id}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        className={styles.fileInput}
        aria-invalid={shown ? true : undefined}
        aria-describedby={[`${id}-help`, shown ? `${id}-err` : null].filter(Boolean).join(' ')}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          onPick({ file, error: file ? (parityFileError(file) ?? null) : null });
        }}
      />
      {picked.file && !picked.error ? (
        <span className={s.small}>
          {picked.file.name} ({(picked.file.size / 1024).toFixed(1)} KB)
        </span>
      ) : null}
      {shown ? (
        <Callout tone="danger" live>
          <span id={`${id}-err`}>{shown}</span>
        </Callout>
      ) : null}
    </div>
  );
}
