import { Check, Download, FileUp, Lock, X } from 'lucide-react';
import { useId, useState } from 'react';
import { saveBlob } from '@/api/client';
import { isApiError } from '@/api/errors';
import {
  useDecideBaseline,
  useExportPlan,
  useImportActuals,
  usePlanBaselines,
  usePlanDiff,
  useProposeBaseline,
} from '@/api/planning';
import type { PlanBaseline } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
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
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { toBase64 } from '../packs/model';
import { baselineStatus, formatRange, humanize, minLength } from './model';

export function BaselinesView({
  project,
  canManage,
  canApprove,
}: {
  project: Project;
  canManage: boolean;
  canApprove: boolean;
}) {
  const q = usePlanBaselines(project.id);
  const [proposing, setProposing] = useState(false);
  const [deciding, setDeciding] = useState<{ b: PlanBaseline; approve: boolean } | null>(null);
  const [diffId, setDiffId] = useState<string | null>(null);
  const pending = q.data?.find((b) => b.status === 'proposed');
  return (
    <div className={s.stack}>
      <Card aria-labelledby="bl-head">
        <CardHeader
          titleId="bl-head"
          title="Plan baselines"
          description="A baseline freezes the plan. It shows its changes against the approved one and needs a second person to approve it: whoever proposed it cannot approve it."
          actions={
            canManage ? (
              <Button
                leadingIcon={<Lock aria-hidden="true" />}
                onClick={() => setProposing(true)}
                disabled={!!pending}
              >
                Propose baseline
              </Button>
            ) : null
          }
        />
        <CardBody>
          {q.isPending ? (
            <Skeleton height="6rem" />
          ) : q.isError ? (
            <ApiErrorView error={q.error} title="Could not load baselines" compact />
          ) : q.data.length === 0 ? (
            <EmptyState compact title="No baselines yet" />
          ) : (
            <ul className={styles.gapList} aria-label="Baselines">
              {q.data.map((b) => {
                const st = baselineStatus(b.status);
                return (
                  <li key={b.id} className={styles.gap}>
                    <span className={s.row} style={{ width: '100%' }}>
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      <strong>Baseline {b.number}</strong>
                      <span className={`${s.muted} ${s.xs}`}>
                        proposed by {b.proposed_by ?? 'unknown'} <Timestamp value={b.created_at} />
                      </span>
                      <span style={{ marginLeft: 'auto' }} className={s.row}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDiffId(b.id)}
                          aria-pressed={diffId === b.id}
                        >
                          Compare with the current plan
                        </Button>
                        {b.status === 'proposed' && canApprove ? (
                          <>
                            <Button
                              size="sm"
                              leadingIcon={<X aria-hidden="true" />}
                              onClick={() => setDeciding({ b, approve: false })}
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              leadingIcon={<Check aria-hidden="true" />}
                              onClick={() => setDeciding({ b, approve: true })}
                            >
                              Approve
                            </Button>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className={s.small}>“{b.reason}”</span>
                    <span className={`${s.muted} ${s.xs}`}>
                      {formatRange(b.summary.hours)} ·{' '}
                      {Object.entries(b.summary.items ?? {})
                        .map(([k, n]) => `${String(n)} ${humanize(k).toLowerCase()}`)
                        .join(', ')}
                      {b.changes.against !== undefined
                        ? ` · against baseline ${String(b.changes.against)}: ${String(b.changes.added ?? 0)} added, ${String(b.changes.removed ?? 0)} removed, ${String(b.changes.changed ?? 0)} changed`
                        : ''}
                    </span>
                    <Mono className={s.xs}>{b.digest}</Mono>
                    {b.decided_at ? (
                      <span className={`${s.muted} ${s.xs}`}>
                        Decided by {b.decided_by ?? 'unknown'} <Timestamp value={b.decided_at} />
                        {b.decision_note ? `: “${b.decision_note}”` : ''}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {diffId ? <DiffCard project={project} baselineId={diffId} /> : null}
      <ExportCard project={project} />
      {canManage ? <ActualsCard project={project} /> : null}
      {proposing ? <ProposeDialog project={project} onClose={() => setProposing(false)} /> : null}
      {deciding ? (
        <DecideDialog
          project={project}
          baseline={deciding.b}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </div>
  );
}

function ProposeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const propose = useProposeBaseline(project.id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = minLength(reason, 10, 'Say what this baseline is for');
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Propose a plan baseline"
      submitLabel="Propose baseline"
      pending={propose.isPending}
      error={propose.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        propose.mutate(reason.trim(), {
          onSuccess: (b) => {
            toast.success(`Baseline ${String(b.number)} proposed`);
            onClose();
          },
        });
      }}
    >
      <Field
        label="Reason"
        help="At least 10 characters."
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

function DecideDialog({
  project,
  baseline,
  approve,
  onClose,
}: {
  project: Project;
  baseline: PlanBaseline;
  approve: boolean;
  onClose: () => void;
}) {
  const decide = useDecideBaseline(project.id);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = minLength(note, 10, 'Add a note');
  const e = decide.error;
  const coexistence = isApiError(e) && e.status === 409 ? e.fieldErrorList : [];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`${approve ? 'Approve' : 'Reject'} baseline ${String(baseline.number)}`}
      description={
        approve
          ? 'Approving replaces the approved baseline. A phased plan needs complete coexistence rules.'
          : undefined
      }
      submitLabel={approve ? 'Approve baseline' : 'Reject baseline'}
      tone={approve ? 'default' : 'danger'}
      pending={decide.isPending}
      error={coexistence.length ? null : e}
      fields={['note']}
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        decide.mutate(
          { id: baseline.id, approve, note: note.trim() },
          {
            onSuccess: () => {
              toast.success(approve ? 'Baseline approved' : 'Baseline rejected');
              onClose();
            },
          },
        );
      }}
    >
      {coexistence.length && isApiError(e) ? (
        <Callout tone="danger" title={e.title} live>
          {e.detail}
          <ul className={styles.plainList}>
            {coexistence.map((x) => (
              <li key={x.field}>
                <Mono className={s.xs}>{x.field}</Mono> {x.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Field
        label="Note"
        help="At least 10 characters."
        error={submitted ? err : undefined}
        required
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

function show(v: unknown): string {
  if (v === undefined) return '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function DiffCard({ project, baselineId }: { project: Project; baselineId: string }) {
  const q = usePlanDiff(project.id, baselineId);
  if (q.isPending) return <Skeleton height="8rem" />;
  if (q.isError) return <ApiErrorView error={q.error} title="Could not compare" compact />;
  const d = q.data;
  return (
    <Card aria-labelledby="bl-diff">
      <CardHeader
        titleId="bl-diff"
        title={`Current plan against baseline ${String(d.baseline.number)}`}
        description={
          d.same
            ? 'Nothing changed.'
            : `${String(d.counts.added)} added, ${String(d.counts.removed)} removed, ${String(d.counts.changed)} changed.`
        }
      />
      {!d.same ? (
        <CardBody className={s.stackSm}>
          <KeyValueList
            items={Object.entries(d.by_kind).map(([k, c]) => ({
              key: k,
              label: humanize(k),
              value: `${String(c.added)} added, ${String(c.removed)} removed, ${String(c.changed)} changed`,
            }))}
          />
          {d.added.length ? (
            <details>
              <summary className={s.small}>Added ({d.added.length})</summary>
              <PlainText label="Added items">{d.added.join('\n')}</PlainText>
            </details>
          ) : null}
          {d.removed.length ? (
            <details>
              <summary className={s.small}>Removed ({d.removed.length})</summary>
              <PlainText label="Removed items">{d.removed.join('\n')}</PlainText>
            </details>
          ) : null}
          {d.changed.length ? (
            <details>
              <summary className={s.small}>Changed ({d.changed.length})</summary>
              <PlainText label="Changed items">
                {d.changed
                  .map(
                    (c) =>
                      `${c.item}\n${c.fields.map((f) => `  ${f.field}: ${show(f.before)} -> ${show(f.after)}`).join('\n')}`,
                  )
                  .join('\n')}
              </PlainText>
            </details>
          ) : null}
        </CardBody>
      ) : null}
    </Card>
  );
}

function ExportCard({ project }: { project: Project }) {
  const exp = useExportPlan(project.id);
  const [format, setFormat] = useState<'jira' | 'ado'>('jira');
  const [target, setTarget] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = target.trim()
    ? undefined
    : format === 'jira'
      ? 'Enter the project key.'
      : 'Enter the area path.';
  return (
    <Card aria-labelledby="bl-export">
      <CardHeader
        titleId="bl-export"
        title="Export tasks"
        description="Tasks as CSV for a work-tracking tool. Task keys stay stable, so imported actuals match them later."
      />
      <CardBody>
        <form
          className={s.filters}
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (err) return;
            exp.mutate({ format, target: target.trim() }, { onSuccess: (r) => saveBlob(r) });
          }}
        >
          <Field label="Format">
            <Select
              options={[
                { value: 'jira', label: 'Jira CSV' },
                { value: 'ado', label: 'Azure DevOps CSV' },
              ]}
              value={format}
              onValueChange={(v) => setFormat(v as 'jira' | 'ado')}
            />
          </Field>
          <Field
            label={format === 'jira' ? 'Project key' : 'Area path'}
            error={submitted ? err : undefined}
            required
          >
            <Input
              mono
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              maxLength={200}
            />
          </Field>
          <span style={{ alignSelf: 'end' }}>
            <Button
              type="submit"
              leadingIcon={<Download aria-hidden="true" />}
              loading={exp.isPending}
            >
              Download CSV
            </Button>
          </span>
        </form>
        <FormError error={exp.error} />
      </CardBody>
    </Card>
  );
}

function ActualsCard({ project }: { project: Project }) {
  const imp = useImportActuals(project.id);
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const server = isApiError(imp.error)
    ? (imp.error.fieldErrors.content_base64 ?? imp.error.fieldErrors.filename)
    : undefined;
  return (
    <Card aria-labelledby="bl-actuals">
      <CardHeader
        titleId="bl-actuals"
        title="Import actual effort"
        description="Logged hours from a work-tracking export (CSV), matched by task key. Actuals calibrate later estimates."
      />
      <CardBody className={s.stackSm}>
        <label htmlFor={inputId} className={s.cellPrimary}>
          CSV file
        </label>
        <input
          id={inputId}
          type="file"
          accept=".csv"
          aria-invalid={error || server ? true : undefined}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
            if (imp.error) imp.reset();
          }}
        />
        {error || server ? (
          <Callout tone="danger" live>
            {error ?? server}
          </Callout>
        ) : null}
        <FormError error={server ? null : imp.error} />
        {imp.data ? (
          <Callout
            tone={imp.data.unmatched.length ? 'warning' : 'success'}
            title={`${String(imp.data.matched)} of ${String(imp.data.rows)} row(s) matched a task`}
          >
            {imp.data.hours} hour(s) recorded.
            {imp.data.unmatched.length
              ? ` Not matched: ${imp.data.unmatched.slice(0, 20).join(', ')}${imp.data.unmatched.length > 20 ? ', …' : ''}`
              : ''}
          </Callout>
        ) : null}
      </CardBody>
      <CardFooter>
        <Button
          leadingIcon={<FileUp aria-hidden="true" />}
          loading={imp.isPending}
          onClick={() => {
            const problem = !file
              ? 'Choose a CSV file.'
              : !/\.csv$/i.test(file.name)
                ? 'Choose a .csv file.'
                : file.size > 25 * 1024 * 1024
                  ? 'Imports are limited to 25 MB.'
                  : null;
            if (problem || !file) {
              setError(problem);
              return;
            }
            void file
              .arrayBuffer()
              .then((buf) =>
                imp.mutate({ filename: file.name, content_base64: toBase64(new Uint8Array(buf)) }),
              );
          }}
        >
          Import actuals
        </Button>
      </CardFooter>
    </Card>
  );
}
