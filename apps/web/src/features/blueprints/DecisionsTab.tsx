import { Scale } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';
import { useDecide, useDecisions } from '@/api/blueprints';
import type { Decision, Project, SettingValueType } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  EmptyState,
  Field,
  Mono,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { formatSettingValue, strictnessWords } from '../packs/model';
import { Sources } from '../packs/PackContentTables';
import {
  choosesLessStrict,
  conflictContext,
  conflictOptions,
  looseningContext,
  validateDecision,
  type DecideFormErrors,
} from './decisions';
import styles from './Blueprint.module.css';

const STATUS = {
  open: { label: 'Open', tone: 'warning' },
  decided: { label: 'Decided', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
} as const;

export function DecisionsTab({ project }: { project: Project }) {
  const decisions = useDecisions(project.id);
  if (decisions.isPending) return <Skeleton height="12rem" />;
  if (decisions.isError) {
    return (
      <ApiErrorView
        error={decisions.error}
        title="Could not load decisions"
        onRetry={() => void decisions.refetch()}
      />
    );
  }
  const open = decisions.data.filter((d) => d.status === 'open');
  const closed = decisions.data.filter((d) => d.status !== 'open');
  if (decisions.data.length === 0) {
    return (
      <EmptyState
        icon={<Scale />}
        title="No decisions"
        body="Conflicting pack settings and loosening overrides appear here when a version is saved."
      />
    );
  }
  return (
    <div className={s.stack}>
      <p className={`${s.muted} ${s.small}`}>
        Nothing here is decided automatically. Each conflict and each loosening is decided by a
        named person, with a reason, and recorded in the audit log.
      </p>
      {open.length > 0 ? (
        <section aria-labelledby="open-decisions" className={s.stack}>
          <h2 id="open-decisions" className={s.cellPrimary}>
            Open ({open.length})
          </h2>
          {open.map((d) => (
            <DecisionCard key={d.id} project={project} decision={d} />
          ))}
        </section>
      ) : null}
      {closed.length > 0 ? (
        <section aria-labelledby="closed-decisions" className={s.stack}>
          <h2 id="closed-decisions" className={s.cellPrimary}>
            Decided ({closed.length})
          </h2>
          {closed.map((d) => (
            <DecisionCard key={d.id} project={project} decision={d} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function DecisionCard({ project, decision: d }: { project: Project; decision: Decision }) {
  const conflict = conflictContext(d);
  const loosening = looseningContext(d);
  const st = STATUS[d.status];
  return (
    <Card
      aria-label={`${d.kind === 'setting_conflict' ? 'Setting conflict' : 'Loosening request'}: ${d.subject}`}
    >
      <CardHeader
        title={
          <span className={s.row}>
            <Badge>
              {d.kind === 'setting_conflict' ? 'Setting conflict' : 'Loosening request'}
            </Badge>
            <Mono>{d.subject}</Mono>
          </span>
        }
        description={
          <>
            Raised <Timestamp value={d.created_at} />
            {d.requested_by_name ? ` by ${d.requested_by_name}` : ''}
          </>
        }
        actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
      />
      <CardBody className={styles.decision}>
        {conflict ? (
          <>
            <p className={s.small}>
              {strictnessWords(conflict.stricter)}.{' '}
              {conflict.strictest !== null
                ? `Stricter value: ${formatSettingValue(conflict.strictest, conflict.unit)}. `
                : ''}
              <strong>No default is applied.</strong>
            </p>
            <ul style={{ listStyle: 'none' }} className={s.stackSm}>
              {conflict.values.map((v) => (
                <li key={v.pack} className={s.cellStack}>
                  <span>
                    <strong>{formatSettingValue(v.value, conflict.unit)}</strong>{' '}
                    <span className={s.muted}>from {v.pack}</span>
                  </span>
                  {v.description ? (
                    <span className={`${s.muted} ${s.small}`}>{v.description}</span>
                  ) : null}
                  {v.sources && v.sources.length > 0 ? <Sources sources={v.sources} /> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {loosening ? (
          <>
            <p>
              Requested value <strong>{formatSettingValue(loosening.value)}</strong> instead of the
              packs&apos; <strong>{formatSettingValue(loosening.effective)}</strong>
              {loosening.packs?.length ? (
                <span className={s.muted}> ({loosening.packs.join(', ')})</span>
              ) : null}
              .
            </p>
            {loosening.reason ? (
              <p className={s.small}>
                <span className={s.muted}>Requester&apos;s reason: </span>“{loosening.reason}”
              </p>
            ) : null}
          </>
        ) : null}
        {d.status !== 'open' ? (
          <Callout tone={d.status === 'decided' ? 'success' : 'danger'}>
            {d.status === 'decided' ? 'Decided' : 'Rejected'} by {d.decided_by_name ?? 'unknown'}
            {d.decided_at ? (
              <>
                {' '}
                <Timestamp value={d.decided_at} />
              </>
            ) : null}
            {d.chosen_value !== null && conflict ? (
              <>
                {' '}
                · chose <strong>{formatSettingValue(d.chosen_value, conflict.unit)}</strong>
              </>
            ) : null}
            {d.reason ? <>. “{d.reason}”</> : null}
          </Callout>
        ) : d.can_decide ? (
          <DecideForm project={project} decision={d} />
        ) : (
          <p className={`${s.muted} ${s.small}`}>
            {d.kind === 'setting_conflict'
              ? 'A compliance curator or migration lead on this project decides this conflict.'
              : 'A named approver on this project decides this request.'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function DecideForm({ project, decision: d }: { project: Project; decision: Decision }) {
  const decide = useDecide(project.id);
  const conflict = conflictContext(d);
  const name = useId();
  const [chosen, setChosen] = useState<SettingValueType | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<DecideFormErrors>({});
  const lessStrict = conflict ? choosesLessStrict(conflict, chosen) : false;

  function submit(approve: boolean) {
    const next = validateDecision(d.kind, chosen, reason);
    setErrors(next);
    if (next.chosen || next.reason) return;
    decide.mutate(
      {
        id: d.id,
        body: {
          reason: reason.trim(),
          ...(d.kind === 'setting_conflict' ? { chosen_value: chosen } : { approve }),
        },
      },
      {
        onSuccess: () =>
          toast.success(
            d.kind === 'setting_conflict'
              ? 'Decision recorded'
              : approve
                ? 'Loosening approved'
                : 'Loosening rejected',
          ),
      },
    );
  }

  return (
    <form
      className={s.stackSm}
      noValidate
      onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        submit(true);
      }}
    >
      {conflict ? (
        <fieldset
          className={s.stackSm}
          style={{ border: 0, padding: 0, margin: 0 }}
          aria-describedby={errors.chosen ? `${name}-err` : undefined}
        >
          <legend className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
            Choose the value for this project
          </legend>
          {conflictOptions(conflict).map((o) => (
            <label key={String(o.value)} className={styles.valueChoice}>
              <input
                type="radio"
                name={name}
                checked={chosen === o.value}
                onChange={() => setChosen(o.value)}
              />
              <span className={s.cellStack}>
                <strong>
                  {formatSettingValue(o.value, conflict.unit)}
                  {conflict.strictest !== null && o.value === conflict.strictest
                    ? ' (stricter)'
                    : ''}
                </strong>
                <span className={`${s.muted} ${s.small}`}>Set by {o.packs.join(', ')}</span>
              </span>
            </label>
          ))}
          {errors.chosen ? (
            <p id={`${name}-err`} className={styles.inlineError}>
              {errors.chosen}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {lessStrict ? (
        <Callout tone="warning" title="This weakens a pack's rule" live>
          You are choosing the less strict value. It needs a different person from the one who
          raised the conflict, and the reason is kept in the audit log.
        </Callout>
      ) : null}
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </Field>
      <FormError error={decide.error} fields={['reason', 'chosen_value']} />
      <CardFooter style={{ margin: '0 calc(var(--space-5) * -1) calc(var(--space-4) * -1)' }}>
        {d.kind === 'loosening' ? (
          <>
            <Button variant="danger" loading={decide.isPending} onClick={() => submit(false)}>
              Reject loosening
            </Button>
            <Button type="submit" variant="primary" loading={decide.isPending}>
              Approve loosening
            </Button>
          </>
        ) : (
          <Button type="submit" variant="primary" loading={decide.isPending}>
            Record decision
          </Button>
        )}
      </CardFooter>
    </form>
  );
}
