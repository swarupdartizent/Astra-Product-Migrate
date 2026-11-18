import { RefreshCw, Trash, Wand } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useApplyWorkbenchEdits,
  usePlanOverview,
  usePlanWorkbench,
  useSolveWaves,
} from '@/api/planning';
import type { WorkbenchEdit, WorkbenchEditResult } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  IconButton,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
} from '@/ui';
import s from '../shared.module.css';
import plan from './Plan.module.css';
import { WorkbenchGraph } from './WorkbenchGraph';
import { describeEdit, editErrors, upsertEdit, type PendingEdit } from './workbench-model';
import { WorkbenchTasks } from './WorkbenchTasks';
import { WorkbenchTimeline } from './WorkbenchTimeline';

type View = 'timeline' | 'tasks' | 'graph';

/**
 * The planning workbench (E16.F2.S1): the plan as one view — a timeline of waves, the task list
 * and the dependency graph. Edits collect in a pending list and are applied together; the
 * constraint solver then re-runs, so the result shows at once which constraints break.
 */
export function WorkbenchView({ project }: { project: Project }) {
  const q = usePlanWorkbench(project.id);
  const overview = usePlanOverview(project.id);
  const apply = useApplyWorkbenchEdits(project.id);
  const solve = useSolveWaves(project.id);
  const [pending, setPending] = useState<PendingEdit[]>([]);
  const nextId = useRef(1);
  const [result, setResult] = useState<WorkbenchEditResult | null>(null);
  const [announce, setAnnounce] = useState('');
  const [view, setView] = useState<View>('timeline');

  // Warn before leaving the page with unapplied changes.
  useEffect(() => {
    if (pending.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending.length]);

  const items = q.data?.items;
  const names = useMemo(() => new Map((items ?? []).map((i) => [i.key, i.element])), [items]);
  const name = (k: string) => names.get(k) ?? k;

  const addEdit = (edit: WorkbenchEdit) => {
    const next = upsertEdit(pending, edit, nextId.current++);
    setPending(next);
    apply.reset();
    setAnnounce(`${describeEdit(edit, name)}. ${pendingText(next.length)}.`);
  };
  const removeEdit = (id: number) => {
    const next = pending.filter((p) => p.id !== id);
    setPending(next);
    apply.reset();
    setAnnounce(`Pending change removed. ${pendingText(next.length)}.`);
  };

  if (q.isPending) return <Skeleton height="16rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the planning workbench"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const wb = q.data;
  const maxTaskHours = overview.data?.ready ? overview.data.max_task_hours : null;
  const errs = editErrors(apply.error, pending);
  const mapped = errs.byId.size > 0;

  return (
    <div className={s.stack}>
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
      <Card aria-labelledby="wb-head">
        <CardHeader
          titleId="wb-head"
          title="Planning workbench"
          description="The waves, tasks and dependencies in one place. Changes collect below and are applied together; the wave solver then runs again on the changed plan."
          actions={
            wb.plan ? (
              <StatusPill tone={wb.plan.fits ? 'success' : 'danger'}>
                {wb.plan.fits
                  ? 'The plan fits'
                  : `${String(wb.plan.broken.length)} broken constraint(s)`}
              </StatusPill>
            ) : (
              <StatusPill tone="neutral">Not solved yet</StatusPill>
            )
          }
        />
        <CardBody className={s.stackSm}>
          {wb.stale ? (
            <Callout
              tone="warning"
              title="The plan changed after the last solve"
              action={
                wb.can_edit ? (
                  <Button
                    size="sm"
                    leadingIcon={<RefreshCw aria-hidden="true" />}
                    loading={solve.isPending}
                    onClick={() =>
                      solve.mutate(undefined, {
                        onSuccess: (r) =>
                          setAnnounce(
                            r.fits
                              ? 'Solved again: the plan fits.'
                              : `Solved again: ${String(r.broken.length)} broken constraint(s).`,
                          ),
                      })
                    }
                  >
                    Re-solve
                  </Button>
                ) : null
              }
            >
              Scope, dependencies, tasks, waves or pins changed since the waves were solved, so the
              placement below may be out of date.
            </Callout>
          ) : null}
          <FormError error={solve.error} />
          {!wb.can_edit ? (
            <p className={`${s.muted} ${s.small}`}>
              You can read the plan. A migration lead changes it.
            </p>
          ) : (
            <PendingChanges
              pending={pending}
              name={name}
              errors={errs.byId}
              applying={apply.isPending}
              onRemove={removeEdit}
              onDiscard={() => {
                setPending([]);
                apply.reset();
                setAnnounce('All pending changes discarded.');
              }}
              onApply={() => {
                setResult(null);
                apply.mutate(
                  pending.map((p) => p.edit),
                  {
                    onSuccess: (out) => {
                      setResult(out);
                      setPending([]);
                      setAnnounce(applyText(out));
                    },
                    onError: (e) => {
                      const n = editErrors(e, pending).byId.size;
                      setAnnounce(
                        n
                          ? `Nothing was saved: ${String(n)} pending change(s) need attention.`
                          : 'Nothing was saved: the changes could not be applied.',
                      );
                    },
                  },
                );
              }}
            />
          )}
          {mapped ? (
            <Callout tone="danger" title="Nothing was saved">
              Fix or remove the highlighted pending change, then apply again.
              {errs.other.length ? (
                <ul className={s.small}>
                  {errs.other.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : (
            <FormError error={apply.error} />
          )}
          {result ? <ApplyResult out={result} /> : null}
        </CardBody>
      </Card>
      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList aria-label="Workbench views">
          <Tab value="timeline">Timeline</Tab>
          <Tab value="tasks">Task list</Tab>
          <Tab value="graph">Dependency graph</Tab>
        </TabsList>
        <TabPanel value="timeline">
          <WorkbenchTimeline wb={wb} pending={pending} name={name} onEdit={addEdit} />
        </TabPanel>
        <TabPanel value="tasks">
          <WorkbenchTasks
            project={project}
            canEdit={wb.can_edit}
            roles={wb.roles}
            maxTaskHours={maxTaskHours}
            pending={pending}
            onEdit={addEdit}
          />
        </TabPanel>
        <TabPanel value="graph">
          <WorkbenchGraph
            project={project}
            wb={wb}
            pending={pending}
            name={name}
            onEdit={addEdit}
            onUndo={removeEdit}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function pendingText(n: number): string {
  return n === 1 ? '1 pending change' : `${String(n)} pending changes`;
}

function applyText(out: WorkbenchEditResult): string {
  const head = `Applied ${pendingText(out.applied.length).replace(' pending', '')}.`;
  if (out.solve_error) return `${head} The solver could not run: ${out.solve_error}`;
  if (!out.plan) return head;
  return out.plan.fits
    ? `${head} The plan fits.`
    : `${head} The plan does not fit: ${String(out.plan.broken.length)} broken constraint(s).`;
}

function PendingChanges({
  pending,
  name,
  errors,
  applying,
  onRemove,
  onDiscard,
  onApply,
}: {
  pending: PendingEdit[];
  name: (k: string) => string;
  errors: Map<number, string>;
  applying: boolean;
  onRemove: (id: number) => void;
  onDiscard: () => void;
  onApply: () => void;
}) {
  return (
    <section aria-labelledby="wb-pending" className={s.stackSm}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <h3 id="wb-pending" className={s.cellPrimary}>
          {pending.length === 0 ? 'No pending changes' : pendingText(pending.length)}
        </h3>
        <span className={s.row}>
          <Button size="sm" variant="ghost" onClick={onDiscard} disabled={pending.length === 0}>
            Discard all
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Wand aria-hidden="true" />}
            loading={applying}
            disabled={pending.length === 0}
            onClick={onApply}
          >
            Apply and re-solve
          </Button>
        </span>
      </div>
      {pending.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>
          Move items between waves, change tasks, or add and remove dependencies below. Nothing is
          saved until you apply; if one change is invalid, none is saved.
        </p>
      ) : (
        <ol className={plan.pendingList} aria-label="Pending changes">
          {pending.map((p, i) => {
            const err = errors.get(p.id);
            const text = describeEdit(p.edit, name);
            return (
              <li key={p.id} className={plan.pendingItem} data-error={err ? 'true' : undefined}>
                <span className={plan.pendingText}>
                  <span className="sr-only">Change {i + 1}: </span>
                  {text}
                  {err ? <span className={plan.pendingError}>{err}</span> : null}
                </span>
                <IconButton
                  size="sm"
                  label={`Remove pending change ${String(i + 1)}: ${text}`}
                  icon={<Trash aria-hidden="true" />}
                  onClick={() => onRemove(p.id)}
                />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ApplyResult({ out }: { out: WorkbenchEditResult }) {
  const p = out.plan;
  return (
    <Callout
      tone={out.solve_error || (p && !p.fits) ? 'warning' : 'success'}
      title={`Applied ${pendingText(out.applied.length).replace(' pending', '')}`}
    >
      <ul className={s.small}>
        {out.applied.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className={s.small}>
        {out.solve_error
          ? `The changes are saved, but the solver could not run: ${out.solve_error}`
          : p
            ? p.fits
              ? 'The solver ran again: every item fits the waves.'
              : `The solver ran again: the plan does not fit. ${String(p.broken.length)} broken constraint(s) and the options to fix them are on the timeline.`
            : 'The solver ran again.'}
      </p>
    </Callout>
  );
}
