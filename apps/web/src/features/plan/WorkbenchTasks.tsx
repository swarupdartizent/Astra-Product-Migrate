import { Pencil, Search } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTasks } from '@/api/planning';
import type { PlanTask, WorkbenchEdit } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  Skeleton,
  Textarea,
} from '@/ui';
import s from '../shared.module.css';
import { formatRange, humanize } from './model';
import plan from './Plan.module.css';
import { Pager } from './PlanShared';
import {
  pendingTask,
  taskForm,
  validateTaskEdit,
  type PendingEdit,
  type TaskEditForm,
} from './workbench-model';

const ALL = '__all__';
const PAGE = 50;

/** Tasks with inline edits of role and estimate, each with a reason. Changes go to the pending list. */
export function WorkbenchTasks({
  project,
  canEdit,
  roles,
  maxTaskHours,
  pending,
  onEdit,
}: {
  project: Project;
  canEdit: boolean;
  roles: string[];
  maxTaskHours: number | null;
  pending: PendingEdit[];
  onEdit: (e: WorkbenchEdit) => void;
}) {
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const tasks = useTasks(project.id, {
    ...(role ? { role } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: PAGE,
  });
  const cols = canEdit ? 6 : 5;
  return (
    <Card flush aria-labelledby="wb-tasks">
      <CardHeader
        titleId="wb-tasks"
        title="Task list"
        description="Change a task’s role or estimate with a reason. The change is kept with the generated values and survives task regeneration while the task exists."
      />
      <div className={s.filters} style={{ padding: 'var(--space-3) var(--space-5)' }}>
        <Field label="Role">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All roles' },
              ...roles.map((r) => ({ value: r, label: humanize(r) })),
            ]}
            value={role || ALL}
            onValueChange={(v) => {
              setRole(v === ALL ? '' : v);
              setOffset(0);
            }}
          />
        </Field>
        <Field label="Title contains">
          <Input
            size="sm"
            type="search"
            startAdornment={<Search />}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </Field>
      </div>
      {tasks.isError ? (
        <ApiErrorView
          error={tasks.error}
          title="Could not load tasks"
          compact
          onRetry={() => void tasks.refetch()}
        />
      ) : tasks.isPending ? (
        <Skeleton height="12rem" />
      ) : tasks.data.items.length === 0 ? (
        <EmptyState
          compact
          title="No tasks"
          body="Generate tasks on the Tasks and estimates section."
        />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className={plan.taskTable}>
            <caption className="sr-only">Plan tasks</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Role</th>
                <th scope="col">Estimate</th>
                <th scope="col">Wave</th>
                <th scope="col">Changed</th>
                {canEdit ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {tasks.data.items.map((t) => {
                const pe = pendingTask(pending, t.key);
                return (
                  <Fragment key={t.key}>
                    <tr>
                      <td style={{ minWidth: '16rem' }}>
                        <span className={s.cellStack}>
                          <span>{t.title}</span>
                          <Mono className={`${s.xs} ${s.muted}`}>{t.key}</Mono>
                        </span>
                      </td>
                      <td>{humanize(t.role)}</td>
                      <td>{formatRange(t)}</td>
                      <td>{t.wave ?? '—'}</td>
                      <td style={{ minWidth: '14rem' }}>
                        <Changes task={t} pendingEdit={pe} />
                      </td>
                      {canEdit ? (
                        <td>
                          <Button
                            size="sm"
                            variant="ghost"
                            leadingIcon={<Pencil aria-hidden="true" />}
                            aria-expanded={editing === t.key}
                            aria-label={`Edit task ${t.title}`}
                            onClick={() => setEditing(editing === t.key ? null : t.key)}
                          >
                            Edit
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                    {editing === t.key ? (
                      <tr className={plan.taskEditRow}>
                        <td colSpan={cols}>
                          <TaskEditor
                            task={t}
                            roles={roles}
                            maxTaskHours={maxTaskHours}
                            onCancel={() => setEditing(null)}
                            onSave={(e) => {
                              onEdit(e);
                              setEditing(null);
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tasks.data ? (
        <Pager offset={offset} limit={PAGE} total={tasks.data.total} onOffset={setOffset} />
      ) : null}
    </Card>
  );
}

function Changes({
  task: t,
  pendingEdit,
}: {
  task: PlanTask;
  pendingEdit: Extract<WorkbenchEdit, { op: 'task' }> | undefined;
}) {
  const o = t.override;
  return (
    <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
      {o ? (
        <>
          <span>
            <Badge tone="info">Changed by {o.by}</Badge>
          </span>
          <span className={`${s.xs} ${s.muted}`}>
            Generated: {humanize(o.original.role)}, {formatRange(o.original)}
          </span>
          <span className={s.xs}>“{o.reason}”</span>
        </>
      ) : null}
      {pendingEdit ? (
        <span>
          <Badge tone="accent">
            Pending:{' '}
            {[
              pendingEdit.role ? humanize(pendingEdit.role) : null,
              pendingEdit.low !== undefined ||
              pendingEdit.likely !== undefined ||
              pendingEdit.high !== undefined
                ? formatRange({
                    low: pendingEdit.low ?? t.low,
                    likely: pendingEdit.likely ?? t.likely,
                    high: pendingEdit.high ?? t.high,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </Badge>
        </span>
      ) : null}
      {!o && !pendingEdit ? <span className={s.muted}>No</span> : null}
    </span>
  );
}

function TaskEditor({
  task,
  roles,
  maxTaskHours,
  onCancel,
  onSave,
}: {
  task: PlanTask;
  roles: string[];
  maxTaskHours: number | null;
  onCancel: () => void;
  onSave: (e: Extract<WorkbenchEdit, { op: 'task' }>) => void;
}) {
  const [f, setF] = useState<TaskEditForm>(() => taskForm(task));
  const [submitted, setSubmitted] = useState(false);
  const v = validateTaskEdit(f, task, maxTaskHours);
  const errors = submitted ? v.errors : {};
  const set = (k: keyof TaskEditForm, val: string) => setF((p) => ({ ...p, [k]: val }));
  return (
    <form
      noValidate
      aria-label={`Change task ${task.title}`}
      className={s.stackSm}
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (v.edit) onSave(v.edit);
      }}
    >
      <div className={plan.taskEditGrid}>
        <Field label="Role" error={errors.role}>
          <Select
            options={roles.map((r) => ({ value: r, label: humanize(r) }))}
            value={f.role}
            onValueChange={(r) => set('role', r)}
          />
        </Field>
        {(['low', 'likely', 'high'] as const).map((k) => (
          <Field
            key={k}
            label={`${humanize(k)} (hours)`}
            error={errors[k]}
            help={
              k === 'likely' && maxTaskHours !== null
                ? `At most ${String(maxTaskHours)}.`
                : undefined
            }
          >
            <Input
              type="number"
              min={0}
              step="0.5"
              inputMode="decimal"
              value={f[k]}
              onChange={(e) => set(k, e.target.value)}
            />
          </Field>
        ))}
      </div>
      <Field label="Reason" help="Required, at least 10 characters." error={errors.reason} required>
        <Textarea
          rows={2}
          maxLength={2000}
          value={f.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
      </Field>
      <span className={`${s.xs} ${s.muted}`}>
        Generated values:{' '}
        {task.override
          ? `${humanize(task.override.original.role)}, ${formatRange(task.override.original)}`
          : `${humanize(task.role)}, ${formatRange(task)}`}
      </span>
      <div className={s.row}>
        <Button type="submit" variant="primary">
          Add to pending changes
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
