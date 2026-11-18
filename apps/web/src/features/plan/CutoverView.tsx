import { Check, ClipboardList, Scale, Timer } from 'lucide-react';
import { useState } from 'react';
import {
  useChooseCutover,
  useCoexistence,
  useCompareCutover,
  useGenerateRunbook,
  usePlanOverview,
  useRecordRehearsal,
  useRunbook,
  useSetCoexistence,
} from '@/api/planning';
import type {
  CoexistenceIn,
  CutoverAssumptions,
  CutoverComparisonOption,
  CutoverOption,
} from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
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
import styles from '../discovery/Discovery.module.css';
import {
  CUTOVER_LABELS,
  cutoverLabel,
  humanize,
  minLength,
  parseTimings,
  validateCoexistence,
} from './model';
import plan from './Plan.module.css';

function factorText(v: unknown): string {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return JSON.stringify(v);
}

const ASSUMPTION_FIELDS: { key: keyof CutoverAssumptions; label: string; help: string }[] = [
  { key: 'extract_hours', label: 'Final extract (hours)', help: 'Default 2.' },
  {
    key: 'reconciliation_minutes_per_entity',
    label: 'Reconciliation per entity (minutes)',
    help: 'Default 30.',
  },
  { key: 'switch_minutes', label: 'Switch-over (minutes)', help: 'Default 60.' },
  { key: 'parallel_run_weeks', label: 'Parallel run (weeks)', help: 'Default 4.' },
  {
    key: 'parallel_hours_per_day',
    label: 'Parallel run effort (hours per day)',
    help: 'Default 4.',
  },
];

export function CutoverView({ project, canManage }: { project: Project; canManage: boolean }) {
  return (
    <div className={s.stack}>
      <CompareCard project={project} canManage={canManage} />
      <RunbookCard project={project} canManage={canManage} />
      <CoexistenceCard project={project} canManage={canManage} />
    </div>
  );
}

function CompareCard({ project, canManage }: { project: Project; canManage: boolean }) {
  const overview = usePlanOverview(project.id);
  const compare = useCompareCutover(project.id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [choosing, setChoosing] = useState<CutoverOption | null>(null);
  const assumptions: CutoverAssumptions = {};
  let bad: string | null = null;
  for (const f of ASSUMPTION_FIELDS) {
    const v = values[f.key]?.trim();
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) bad = `${f.label} must be zero or more.`;
    else assumptions[f.key] = n;
  }
  const choice = overview.data?.ready ? overview.data.cutover_choice : null;
  const data = compare.data;
  return (
    <Card aria-labelledby="cut-compare">
      <CardHeader
        titleId="cut-compare"
        title="Cutover strategy"
        description="Whole estate, phased and parallel run side by side: windows, duration, effort, risk and the constraints each one meets or breaks. Leave an assumption empty to use its default."
      />
      <CardBody className={s.stack}>
        {choice ? (
          <Callout tone="info" title={`Chosen: ${cutoverLabel(choice.option)}`}>
            {choice.by}, <Timestamp value={choice.at} />: “{choice.reason}”
          </Callout>
        ) : (
          <p className={s.muted}>No strategy chosen yet.</p>
        )}
        <form
          className={s.stackSm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!bad) compare.mutate(assumptions);
          }}
        >
          <div className={s.grid2}>
            {ASSUMPTION_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} help={f.help}>
                <Input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
          {bad ? <Callout tone="danger">{bad}</Callout> : null}
          <span>
            <Button
              type="submit"
              variant="primary"
              leadingIcon={<Scale aria-hidden="true" />}
              loading={compare.isPending}
            >
              Compare options
            </Button>
          </span>
        </form>
        <FormError error={compare.error} />
        {data ? (
          <>
            <KeyValueList
              items={[
                {
                  key: 'win',
                  label: 'Allowed cutover window',
                  value:
                    data.inputs.window_hours !== null
                      ? `${String(data.inputs.window_hours)} h`
                      : 'Not set in the blueprint',
                },
                {
                  key: 'rpm',
                  label: 'Target load rate',
                  value:
                    data.inputs.requests_per_minute !== null
                      ? `${String(data.inputs.requests_per_minute)} requests per minute`
                      : 'Unknown',
                },
                {
                  key: 'blocked',
                  label: 'Target loads',
                  value: data.inputs.loads_blocked
                    ? 'Blocked: the load API is not documented'
                    : 'Available',
                },
                {
                  key: 'ent',
                  label: 'Entities',
                  value: data.inputs.entities.length.toLocaleString(),
                },
                { key: 'waves', label: 'Waves', value: data.inputs.waves.join(', ') || 'None' },
              ]}
            />
            <div className={plan.options}>
              {data.options.map((o) => (
                <OptionCard
                  key={o.option}
                  o={o}
                  chosen={choice?.option === o.option}
                  canChoose={canManage}
                  onChoose={() => setChoosing(o.option)}
                />
              ))}
            </div>
          </>
        ) : null}
      </CardBody>
      {choosing ? (
        <ChooseDialog
          project={project}
          option={choosing}
          assumptions={assumptions}
          onClose={() => setChoosing(null)}
        />
      ) : null}
    </Card>
  );
}

function OptionCard({
  o,
  chosen,
  canChoose,
  onChoose,
}: {
  o: CutoverComparisonOption;
  chosen: boolean;
  canChoose: boolean;
  onChoose: () => void;
}) {
  return (
    <section
      className={plan.option}
      data-ok={o.ok}
      data-chosen={chosen}
      aria-label={cutoverLabel(o.option)}
    >
      <span className={s.row}>
        <strong>{cutoverLabel(o.option)}</strong>
        {chosen ? <Badge tone="accent">Chosen</Badge> : null}
        <StatusPill tone={o.ok ? 'success' : 'warning'}>
          {o.ok ? 'Meets constraints' : 'Breaks constraints'}
        </StatusPill>
      </span>
      <span className={`${s.muted} ${s.xs}`}>{CUTOVER_LABELS[o.option].meaning}</span>
      <KeyValueList
        items={[
          { key: 'win', label: 'Windows', value: String(o.windows) },
          {
            key: 'longest',
            label: 'Longest window',
            value: `${String(o.longest_window_hours)} h${o.durations_known ? '' : ' (some durations unknown)'}`,
          },
          {
            key: 'elapsed',
            label: 'Elapsed',
            value: o.elapsed_days !== null ? `${String(o.elapsed_days)} days` : null,
          },
          { key: 'effort', label: 'Effort', value: `${String(o.effort_hours)} h` },
          { key: 'risk', label: 'Risk', value: `${String(o.risk)} of 5` },
          { key: 'steps', label: 'Runbook steps', value: String(o.steps) },
        ]}
      />
      <ul className={styles.plainList} aria-label="Constraints">
        {o.constraints.map((c) => (
          <li key={c.constraint} className={s.small}>
            {c.ok ? '✓' : '✗'} <strong>{humanize(c.constraint)}</strong>: {c.detail}
          </li>
        ))}
      </ul>
      <details>
        <summary className={s.small}>Risk factors</summary>
        <ul className={styles.plainList}>
          {o.risk_factors.map((f) => (
            <li key={f.factor} className={s.xs}>
              {humanize(f.factor)}: {factorText(f.value)}. {f.detail}
            </li>
          ))}
        </ul>
      </details>
      {canChoose ? (
        <span>
          <Button size="sm" leadingIcon={<Check aria-hidden="true" />} onClick={onChoose}>
            Choose {cutoverLabel(o.option)}
          </Button>
        </span>
      ) : null}
    </section>
  );
}

function ChooseDialog({
  project,
  option,
  assumptions,
  onClose,
}: {
  project: Project;
  option: CutoverOption;
  assumptions: CutoverAssumptions;
  onClose: () => void;
}) {
  const choose = useChooseCutover(project.id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = minLength(reason, 15, 'Say why');
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Choose ${cutoverLabel(option)}`}
      description="The choice is recorded with your reason, the assumptions and the comparison it was chosen from."
      submitLabel="Record choice"
      pending={choose.isPending}
      error={choose.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        choose.mutate(
          { option, reason: reason.trim(), assumptions },
          {
            onSuccess: () => {
              toast.success('Cutover strategy recorded');
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help="At least 15 characters."
        error={submitted ? err : undefined}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={4000}
        />
      </Field>
    </FormDialog>
  );
}

function RunbookCard({ project, canManage }: { project: Project; canManage: boolean }) {
  const q = useRunbook(project.id);
  const gen = useGenerateRunbook(project.id);
  const [rehearsing, setRehearsing] = useState(false);
  return (
    <Card aria-labelledby="runbook">
      <CardHeader
        titleId="runbook"
        title="Runbook"
        description="The cutover steps of the chosen strategy, with go/no-go checks and rollback. Rehearsal timings replace planned durations; the first estimate and the history are kept."
        actions={
          canManage ? (
            <span className={s.row}>
              <Button
                leadingIcon={<ClipboardList aria-hidden="true" />}
                loading={gen.isPending}
                onClick={() =>
                  gen.mutate(undefined, { onSuccess: () => toast.success('Runbook generated') })
                }
              >
                Generate runbook
              </Button>
              <Button
                leadingIcon={<Timer aria-hidden="true" />}
                onClick={() => setRehearsing(true)}
                disabled={!q.data?.steps.length}
              >
                Record rehearsal
              </Button>
            </span>
          ) : null
        }
      />
      <CardBody className={s.stackSm}>
        <FormError error={gen.error} />
        {q.isPending ? (
          <Skeleton height="6rem" />
        ) : q.isError ? (
          <ApiErrorView error={q.error} title="Could not load the runbook" compact />
        ) : q.data.steps.length === 0 ? (
          <EmptyState
            compact
            title="No runbook yet"
            body="Choose a cutover strategy, then generate the runbook."
          />
        ) : (
          <>
            <p className={s.small}>
              {q.data.option ? `${cutoverLabel(q.data.option)}: ` : ''}
              {q.data.planned_hours} planned hour(s) excluding rollback.
            </p>
            {q.data.unknown_durations.length > 0 ? (
              <Callout tone="warning">
                {q.data.unknown_durations.length} step(s) have no known duration yet: rehearse them.
              </Callout>
            ) : null}
            <div style={{ overflowX: 'auto' }}>
              <table className={plan.loadGrid} aria-label="Runbook steps">
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Role</th>
                    <th scope="col">Planned</th>
                    <th scope="col">First estimate</th>
                    <th scope="col">Rehearsals</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.steps.map((st) => (
                    <tr key={st.key}>
                      <th scope="row" style={{ fontWeight: 'normal' }}>
                        {st.title}
                        <br />
                        <Mono className={s.xs}>{st.key}</Mono>
                        {st.basis ? (
                          <span className={`${s.muted} ${s.xs}`}> · {st.basis}</span>
                        ) : null}
                      </th>
                      <td>
                        <Badge
                          tone={
                            st.kind === 'go_no_go'
                              ? 'accent'
                              : st.kind === 'rollback'
                                ? 'warning'
                                : 'neutral'
                          }
                        >
                          {st.kind === 'go_no_go' ? 'Go/no-go' : humanize(st.kind)}
                        </Badge>
                      </td>
                      <td>{humanize(st.role)}</td>
                      <td>
                        {st.planned_minutes !== null
                          ? `${String(st.planned_minutes)} min`
                          : 'Unknown'}
                      </td>
                      <td>
                        {st.estimate_minutes !== null
                          ? `${String(st.estimate_minutes)} min`
                          : 'Unknown'}
                      </td>
                      <td className={s.xs}>
                        {st.rehearsals.length
                          ? st.rehearsals
                              .map((r) => `${r.rehearsal}: ${String(r.minutes)} min`)
                              .join('; ')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardBody>
      {rehearsing && q.data ? (
        <RehearsalDialog
          project={project}
          keys={q.data.steps.map((x) => x.key)}
          onClose={() => setRehearsing(false)}
        />
      ) : null}
    </Card>
  );
}

function RehearsalDialog({
  project,
  keys,
  onClose,
}: {
  project: Project;
  keys: string[];
  onClose: () => void;
}) {
  const rec = useRecordRehearsal(project.id);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseTimings(text, keys);
  const client: Partial<Record<'name' | 'timings', string>> = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,59}$/.test(name))
    client.name = 'Use 2–60 letters, digits, spaces, dots, - or _.';
  if (parsed.error) client.timings = parsed.error;
  const errors = mergeFieldErrors(client, rec.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Record rehearsal timings"
      submitLabel="Record timings"
      size="lg"
      pending={rec.isPending}
      error={rec.error}
      fields={['name', 'timings']}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        rec.mutate(
          { name: name.trim(), timings: parsed.timings },
          {
            onSuccess: () => {
              toast.success('Rehearsal recorded');
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Rehearsal name"
        help="For example Dress rehearsal 1."
        error={errors.name}
        required
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </Field>
      <Field
        label="Timings"
        help="One per line: step key = minutes taken."
        error={errors.timings}
        required
      >
        <Textarea
          mono
          rows={8}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={keys
            .slice(0, 3)
            .map((k) => `${k} = 30`)
            .join('\n')}
        />
      </Field>
    </FormDialog>
  );
}

function CoexistenceCard({ project, canManage }: { project: Project; canManage: boolean }) {
  const q = useCoexistence(project.id);
  const [setting, setSetting] = useState<string | null>(null);
  return (
    <Card aria-labelledby="coex">
      <CardHeader
        titleId="coex"
        title="Coexistence"
        description="In a phased cutover, every shared entity needs a system of record, an end date and an exit reconciliation in every phase but the last."
        actions={
          q.data ? (
            <StatusPill tone={q.data.complete ? 'success' : 'danger'}>
              {q.data.complete ? 'Complete' : 'Incomplete'}
            </StatusPill>
          ) : null
        }
      />
      <CardBody className={s.stackSm}>
        {q.isPending ? (
          <Skeleton height="5rem" />
        ) : q.isError ? (
          <ApiErrorView error={q.error} title="Could not load coexistence rules" compact />
        ) : q.data.needed.length === 0 ? (
          <p className={s.muted}>
            No coexistence rules are needed with the current waves and entities.
          </p>
        ) : (
          <>
            {q.data.warnings.length > 0 ? (
              <ul className={styles.plainList} aria-label="Coexistence problems">
                {q.data.warnings.map((w, i) => (
                  <li key={`${w.key}:${String(i)}`} className={s.small}>
                    <Badge tone={w.level === 'error' ? 'danger' : 'warning'}>
                      {w.level === 'error' ? 'Error' : 'Warning'}
                    </Badge>{' '}
                    <Mono className={s.xs}>{w.key}</Mono> {w.detail}
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className={styles.gapList}>
              {q.data.needed.map((k) => {
                const r = q.data.rules[k];
                return (
                  <li key={k} className={styles.gap}>
                    <span className={s.row} style={{ width: '100%' }}>
                      <Mono className={s.small}>{k}</Mono>
                      {r ? (
                        <span className={s.small}>
                          System of record: {r.system_of_record} until {r.end_date}
                        </span>
                      ) : (
                        <Badge tone="danger">No rule</Badge>
                      )}
                      {canManage ? (
                        <span style={{ marginLeft: 'auto' }}>
                          <Button size="sm" onClick={() => setSetting(k)}>
                            {r ? 'Edit rule' : 'Set rule'}
                          </Button>
                        </span>
                      ) : null}
                    </span>
                    {r ? (
                      <span className={`${s.muted} ${s.xs}`}>
                        Exit reconciliation: {r.exit_reconciliation}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardBody>
      {setting && q.data ? (
        <CoexistenceDialog
          project={project}
          pair={setting}
          current={q.data.rules[setting] ?? null}
          onClose={() => setSetting(null)}
        />
      ) : null}
    </Card>
  );
}

function CoexistenceDialog({
  project,
  pair,
  current,
  onClose,
}: {
  project: Project;
  pair: string;
  current: Partial<CoexistenceIn> | null;
  onClose: () => void;
}) {
  const save = useSetCoexistence(project.id);
  const i = pair.lastIndexOf(':');
  const entity = pair.slice(0, i);
  const wave = pair.slice(i + 1);
  const [sor, setSor] = useState<string>(current?.system_of_record ?? '');
  const [end, setEnd] = useState(current?.end_date ?? '');
  const [exit, setExit] = useState(current?.exit_reconciliation ?? '');
  const [submitted, setSubmitted] = useState(false);
  const client = validateCoexistence({
    system_of_record: sor === 'source' || sor === 'target' ? sor : undefined,
    end_date: end,
    exit_reconciliation: exit,
  });
  const errors = mergeFieldErrors(client, save.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Coexistence: ${entity} after wave ${wave}`}
      submitLabel="Save rule"
      pending={save.isPending}
      error={save.error}
      fields={['entity', 'wave', 'system_of_record', 'end_date', 'exit_reconciliation']}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        save.mutate(
          {
            entity,
            wave,
            system_of_record: sor as 'source' | 'target',
            end_date: end,
            exit_reconciliation: exit.trim(),
          },
          {
            onSuccess: () => {
              toast.success('Coexistence rule saved');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="System of record" error={errors.system_of_record} required>
        <Select
          options={[
            { value: 'source', label: 'Source system' },
            { value: 'target', label: 'Target system' },
          ]}
          value={sor}
          onValueChange={setSor}
          placeholder="Choose"
        />
      </Field>
      <Field label="End date" error={errors.end_date} required>
        <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </Field>
      <Field
        label="Exit reconciliation"
        help="How both systems are proved to agree when coexistence ends. At least 10 characters."
        error={errors.exit_reconciliation}
        required
      >
        <Textarea
          rows={3}
          value={exit}
          onChange={(e) => setExit(e.target.value)}
          maxLength={4000}
        />
      </Field>
    </FormDialog>
  );
}
