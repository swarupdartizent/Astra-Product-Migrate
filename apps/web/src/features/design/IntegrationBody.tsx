import { Play, Plus, Trash } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useDesignOverview, useRunIntegrationTest, useSetIntegrationTest } from '@/api/design';
import type { DesignItemDetail, IntegrationTestRun } from '@/api/design-types';
import { isApiError } from '@/api/errors';
import { useTargetConnections } from '@/api/targets';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import type { FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Field,
  IconButton,
  Input,
  KeyValueList,
  Mono,
  Select,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Design.module.css';
import {
  EMPTY_STEP,
  HTTP_METHODS,
  MECHANISM_KIND,
  stepErrorsFromApi,
  stepFormsOf,
  str,
  strList,
  validateSteps,
  type HttpMethodName,
  type StepField,
  type StepForm,
} from './model';
import { Pair } from './Parts';

/**
 * An interface's target design: direction, mechanism, the tables it touches, its end-to-end test
 * (edited here, run against a target connection) and, for desktop-only links, replace or retire.
 */
export function IntegrationBody({
  project,
  item: it,
  onUnsaved,
}: {
  project: Project;
  item: DesignItemDetail;
  onUnsaved: (why: string | null) => void;
}) {
  const src = it.source;
  const tgt = it.target ?? {};
  const retire = tgt.retire === true;
  const touches = (Array.isArray(tgt.touches) ? tgt.touches : []) as {
    source: string;
    target: string | null;
  }[];
  const hosts = strList(src.hosts);
  return (
    <>
      {it.desktop || retire ? (
        <Callout tone="warning" title="Desktop-only link: replace or retire">
          {str(tgt.replacement) ? (
            <>
              Proposed: <strong>{str(tgt.replacement)}</strong>.{' '}
            </>
          ) : null}
          {retire
            ? 'Approving retires the link with this replacement; choosing “Design a browser replacement” in the review queue reopens it here for a design and an end-to-end test.'
            : 'A person chose to design a browser replacement instead of retiring it. Define its end-to-end test before approval.'}
        </Callout>
      ) : null}
      <Pair
        retire={retire}
        source={
          <KeyValueList
            items={[
              { key: 'n', label: 'Interface', value: <Mono>{str(src.name)}</Mono> },
              { key: 'k', label: 'Kind', value: str(src.kind) },
              {
                key: 'd',
                label: 'Direction',
                value: <Badge tone="info">{str(src.direction)}</Badge>,
              },
              { key: 'p', label: 'Program', value: str(src.program) },
              { key: 'h', label: 'Hosts', value: hosts.length ? hosts.join(', ') : null },
              {
                key: 'v',
                label: 'Calls a day',
                value:
                  typeof src.per_day === 'number' ? Math.round(src.per_day).toLocaleString() : null,
              },
              { key: 'f', label: 'Found by', value: str(src.source) },
            ]}
          />
        }
        target={
          it.target ? (
            <KeyValueList
              items={[
                {
                  key: 'm',
                  label: 'Mechanism',
                  value: str(tgt.label) ?? str(tgt.mechanism) ?? 'None',
                },
                {
                  key: 'k',
                  label: 'Kind',
                  value: MECHANISM_KIND[str(tgt.mechanism_kind) ?? ''] ?? str(tgt.mechanism_kind),
                },
                ...(retire
                  ? [{ key: 'r', label: 'Replacement', value: str(tgt.replacement) }]
                  : []),
                ...(str(tgt.design)
                  ? [{ key: 'd', label: 'Reviewer’s design', value: str(tgt.design) }]
                  : []),
              ]}
            />
          ) : (
            <p className={s.muted}>No target: the stream is blocked.</p>
          )
        }
      />
      {touches.length > 0 ? (
        <section className={styles.section} aria-labelledby={`touch-${it.key}`}>
          <h3 id={`touch-${it.key}`} className={styles.sectionTitle}>
            Tables it touches ({touches.length})
          </h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className="sr-only">Source tables and their mapped target tables</caption>
              <thead>
                <tr>
                  <th scope="col">Source table</th>
                  <th scope="col">Target table</th>
                </tr>
              </thead>
              <tbody>
                {touches.map((t) => (
                  <tr key={t.source}>
                    <td>
                      <Mono className={s.xs}>{t.source}</Mono>
                    </td>
                    <td>
                      {t.target ? (
                        <Mono className={s.xs}>{t.target}</Mono>
                      ) : (
                        <span className={s.muted}>Not mapped yet</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {retire ? (
        <p className={`${s.muted} ${s.small}`}>A retired link needs no end-to-end test.</p>
      ) : it.target ? (
        <>
          <TestEditor project={project} item={it} onUnsaved={onUnsaved} />
          <TestRunner project={project} item={it} />
        </>
      ) : null}
    </>
  );
}

function TestEditor({
  project,
  item: it,
  onUnsaved,
}: {
  project: Project;
  item: DesignItemDetail;
  onUnsaved: (why: string | null) => void;
}) {
  const save = useSetIntegrationTest(project.id);
  const saved = stepFormsOf(it.tests);
  // With no saved test, the editor starts from one empty step; that alone is not a change.
  const baseline = saved.length ? saved : [EMPTY_STEP];
  const [steps, setSteps] = useState<StepForm[]>(baseline);
  const [submitted, setSubmitted] = useState(false);
  const [announce, setAnnounce] = useState('');
  const dirty = JSON.stringify(steps) !== JSON.stringify(baseline);
  const decided = it.status === 'approved' || it.status === 'rejected';
  const why = !it.can_decide
    ? (it.cannot_decide_reason ?? 'You cannot change this interface.')
    : decided
      ? `The interface is ${it.status}; its test cannot change here.`
      : null;
  useEffect(() => {
    onUnsaved(dirty && !why ? 'Save the end-to-end test first: it has unsaved changes.' : null);
  }, [dirty, why, onUnsaved]);
  useEffect(() => () => onUnsaved(null), [onUnsaved]);

  const v = validateSteps(steps);
  const server = stepErrorsFromApi(save.error);
  const errorsOf = (i: number): FieldErrors<StepField> => ({
    ...(submitted ? v.errors[i] : {}),
    ...server[i],
  });
  const inline = isApiError(save.error)
    ? save.error.fieldErrorList.map((f) => f.field).filter((f) => /^steps\.\d+\.\w+/.test(f))
    : [];
  const set = (i: number, patch: Partial<StepForm>) => {
    setSteps((prev) => prev.map((st, j) => (j === i ? { ...st, ...patch } : st)));
    if (save.error) save.reset();
  };
  return (
    <section className={styles.section} aria-labelledby={`test-${it.key}`}>
      <h3 id={`test-${it.key}`} className={styles.sectionTitle}>
        End-to-end test
      </h3>
      <p className={`${s.muted} ${s.small}`}>
        HTTP steps run in order against a target connection. Each step names its expected status and
        the keys its JSON response must hold. The interface is approved only once a test is defined.
      </p>
      {it.tests && it.tests.length > 0 ? null : (
        <Callout tone="warning">No test is defined yet.</Callout>
      )}
      <ol className={styles.plainList} aria-label="Test steps">
        {steps.map((st, i) => (
          <StepRow
            key={i}
            index={i}
            step={st}
            errors={errorsOf(i)}
            disabled={!!why}
            canRemove={steps.length > 1}
            onChange={(p) => set(i, p)}
            onRemove={() => {
              setSteps((prev) => prev.filter((_, j) => j !== i));
              setAnnounce(`Step ${String(i + 1)} removed. ${String(steps.length - 1)} step(s).`);
            }}
          />
        ))}
      </ol>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {submitted && v.form ? <Callout tone="danger">{v.form}</Callout> : null}
      <div className={s.row}>
        <Button
          size="sm"
          leadingIcon={<Plus aria-hidden="true" />}
          disabled={!!why || steps.length >= 20}
          onClick={() => {
            setSteps((prev) => [...prev, { ...EMPTY_STEP }]);
            setAnnounce(`Step ${String(steps.length + 1)} added.`);
          }}
        >
          Add step
        </Button>
        <Button
          variant="primary"
          disabled={!!why || !dirty}
          loading={save.isPending}
          onClick={() => {
            setSubmitted(true);
            if (!v.steps) {
              setAnnounce('The test has problems; nothing was saved.');
              return;
            }
            const toSave = v.steps;
            save.mutate(
              { key: it.key, steps: toSave },
              {
                onSuccess: () => {
                  toast.success('End-to-end test saved');
                  setSubmitted(false);
                  // Show what was saved in the API's own form (bodies as formatted JSON).
                  setSteps(stepFormsOf(toSave));
                },
              },
            );
          }}
        >
          Save test
        </Button>
        {dirty && !why ? <Badge tone="warning">Unsaved changes</Badge> : null}
        {why ? <span className={`${s.muted} ${s.small}`}>{why}</span> : null}
      </div>
      <FormError error={save.error} fields={inline} />
    </section>
  );
}

function StepRow({
  index,
  step: st,
  errors,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  step: StepForm;
  errors: FieldErrors<StepField>;
  disabled: boolean;
  canRemove: boolean;
  onChange: (p: Partial<StepForm>) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const hasError = Object.values(errors).some(Boolean);
  return (
    <li className={styles.step} data-error={hasError}>
      <div className={styles.stepHead}>
        <span className={styles.subTitle}>Step {n}</span>
        <IconButton
          size="sm"
          variant="ghost"
          label={`Remove step ${String(n)}`}
          icon={<Trash aria-hidden="true" />}
          disabled={disabled || !canRemove}
          onClick={onRemove}
        />
      </div>
      <div className={styles.stepGrid}>
        <Field label={`Step ${String(n)} name`} error={errors.name} required>
          <Input
            value={st.name}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </Field>
        <Field label={`Step ${String(n)} method`} error={errors.method}>
          <Select
            options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
            value={st.method}
            disabled={disabled}
            onValueChange={(v) => onChange({ method: v as HttpMethodName })}
          />
        </Field>
        <Field
          label={`Step ${String(n)} path`}
          error={errors.path}
          required
          help="Starts with /; the connection supplies the host."
        >
          <Input
            mono
            value={st.path}
            maxLength={500}
            disabled={disabled}
            onChange={(e) => onChange({ path: e.target.value })}
          />
        </Field>
      </div>
      <div className={styles.stepGrid2}>
        <Field
          label={`Step ${String(n)} body (JSON)`}
          error={errors.body}
          help="Leave empty for no body."
        >
          <Textarea
            mono
            rows={3}
            value={st.body}
            disabled={disabled}
            onChange={(e) => onChange({ body: e.target.value })}
          />
        </Field>
        <Field label={`Step ${String(n)} expected status`} error={errors.expect_status} required>
          <Input
            inputMode="numeric"
            value={st.expect_status}
            maxLength={3}
            disabled={disabled}
            onChange={(e) => onChange({ expect_status: e.target.value })}
          />
        </Field>
        <Field
          label={`Step ${String(n)} expected response keys`}
          error={errors.expect_keys}
          help="Comma-separated, for example id, status."
        >
          <Input
            mono
            value={st.expect_keys}
            disabled={disabled}
            onChange={(e) => onChange({ expect_keys: e.target.value })}
          />
        </Field>
      </div>
    </li>
  );
}

function TestRunner({ project, item: it }: { project: Project; item: DesignItemDetail }) {
  const overview = useDesignOverview(project.id);
  const conns = useTargetConnections(project.tenant_id);
  const run = useRunIntegrationTest(project.id);
  const [connectionId, setConnectionId] = useState('');
  const selectId = useId();
  const canRun = overview.data?.can_build ?? false;
  const why = !canRun
    ? 'Running a test needs stage management on this project.'
    : !it.tests || it.tests.length === 0
      ? 'Save a test definition first.'
      : !connectionId
        ? 'Choose a target connection.'
        : null;
  const latest: IntegrationTestRun | null = run.data ?? it.last_test ?? null;
  const history = it.test_runs ?? [];
  return (
    <section className={styles.section} aria-labelledby={`run-${it.key}`}>
      <h3 id={`run-${it.key}`} className={styles.sectionTitle}>
        Run the test
      </h3>
      <p className={`${s.muted} ${s.small}`}>
        Runs every step against the chosen target connection (use a sandbox). Every call is logged
        with the target’s other calls.
      </p>
      {conns.isError ? (
        <ApiErrorView error={conns.error} title="Could not list target connections" compact />
      ) : null}
      <div className={s.row} style={{ alignItems: 'flex-end' }}>
        <Field label="Target connection" controlId={selectId}>
          <Select
            options={(conns.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.name} (${c.base_url})`,
            }))}
            value={connectionId}
            onValueChange={setConnectionId}
            placeholder={
              conns.isPending
                ? 'Loading…'
                : (conns.data ?? []).length === 0
                  ? 'No target connections'
                  : 'Choose a connection'
            }
          />
        </Field>
        <Button
          leadingIcon={<Play aria-hidden="true" />}
          disabled={!!why}
          loading={run.isPending}
          aria-describedby={why ? `runwhy-${it.key}` : undefined}
          onClick={() => run.mutate({ key: it.key, target_connection_id: connectionId })}
        >
          Run test
        </Button>
      </div>
      {why ? (
        <p id={`runwhy-${it.key}`} className={`${s.muted} ${s.small}`}>
          {why}
        </p>
      ) : null}
      <FormError error={run.error} />
      <div role="status" aria-live="polite">
        {latest ? <RunResult run={latest} fresh={!!run.data} /> : null}
      </div>
      {history.length > 1 ? (
        <details>
          <summary className={s.small}>Earlier runs ({history.length - 1})</summary>
          <ul className={styles.bullets}>
            {history
              .slice(0, -1)
              .reverse()
              .map((r) => (
                <li key={r.at}>
                  {r.blocked ? 'Blocked' : r.passed ? 'Passed' : 'Failed'} on {r.connection} by{' '}
                  {r.by} <Timestamp value={r.at} />
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function RunResult({ run: r, fresh }: { run: IntegrationTestRun; fresh: boolean }) {
  const passed = r.steps.filter((x) => x.passed).length;
  return (
    <div className={s.stackSm}>
      <Callout
        tone={r.blocked ? 'warning' : r.passed ? 'success' : 'danger'}
        title={
          r.blocked
            ? 'The test run was blocked'
            : r.passed
              ? `Test passed: ${String(passed)} of ${String(r.steps.length)} step(s)`
              : `Test failed: ${String(passed)} of ${String(r.steps.length)} step(s) passed`
        }
      >
        {r.blocked ? <p>{r.blocked}</p> : null}
        <p className={s.small}>
          {fresh ? 'Just run' : 'Last run'} on <strong>{r.connection}</strong> by {r.by}{' '}
          <Timestamp value={r.at} />
        </p>
      </Callout>
      {r.steps.length > 0 ? (
        <ol className={styles.plainList} aria-label="Step results">
          {r.steps.map((st, i) => (
            <li key={`${String(i)}:${st.step}`} className={styles.result} data-passed={st.passed}>
              <span className={s.row}>
                <StatusPill tone={st.passed ? 'success' : 'danger'}>
                  {st.passed ? 'Passed' : 'Failed'}
                </StatusPill>
                <strong>{st.step}</strong>
                <span className={`${s.muted} ${s.xs}`}>
                  HTTP {st.status === null ? 'no response' : String(st.status)}
                </span>
              </span>
              {st.problems.length > 0 ? (
                <ul className={styles.bullets}>
                  {st.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
