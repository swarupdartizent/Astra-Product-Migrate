import { Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEstimates, useGenerateTasks, useTasks } from '@/api/planning';
import type { PlanTask, RangeWithTasks } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { formatRange, humanize } from './model';
import { Pager } from './PlanShared';

const ALL = '__all__';
const PAGE = 50;
type Rollup = 'by_stream' | 'by_segment' | 'by_wave' | 'by_role';

export function TasksView({ project, canManage }: { project: Project; canManage: boolean }) {
  const generate = useGenerateTasks(project.id);
  return (
    <div className={s.stack}>
      <EstimatesCard project={project} />
      <Card aria-labelledby="tasks-gen">
        <CardHeader
          titleId="tasks-gen"
          title="Work breakdown"
          description="Each scope item becomes tasks from its estimation rule, split so no task's likely estimate exceeds the blueprint's maximum. Every estimate is a range, with the rule and past work behind it."
          actions={
            canManage ? (
              <Button
                leadingIcon={<Sparkles aria-hidden="true" />}
                loading={generate.isPending}
                onClick={() =>
                  generate.mutate(undefined, {
                    onSuccess: (r) => toast.success(`${String(r.tasks)} task(s) generated`),
                  })
                }
              >
                Generate tasks
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          <FormError error={generate.error} />
          {generate.data && generate.data.unestimated.length > 0 ? (
            <Callout
              tone="warning"
              title={`${String(generate.data.unestimated.length)} scope item(s) have no estimation rule`}
            >
              They have no tasks yet. Add a rule to an estimation pack, or decide them differently.
              <details>
                <summary>Show them</summary>
                <ul className={styles.plainList}>
                  {generate.data.unestimated.map((k) => (
                    <li key={k}>
                      <Mono className={s.xs}>{k}</Mono>
                    </li>
                  ))}
                </ul>
              </details>
            </Callout>
          ) : null}
          {generate.data && generate.data.over_limit.length > 0 ? (
            <Callout tone="warning">
              {generate.data.over_limit.length} task(s) are still over{' '}
              {generate.data.max_task_hours} hours.
            </Callout>
          ) : null}
        </CardBody>
      </Card>
      <TaskTable project={project} />
    </div>
  );
}

function EstimatesCard({ project }: { project: Project }) {
  const q = useEstimates(project.id);
  const [by, setBy] = useState<Rollup>('by_stream');
  if (q.isPending) return <Skeleton height="8rem" />;
  if (q.isError) return <ApiErrorView error={q.error} title="Could not load estimates" compact />;
  const e = q.data;
  const total = 'likely' in e.total ? (e.total as RangeWithTasks) : null;
  const rows = Object.entries(e[by]).sort((a, b) => b[1].likely - a[1].likely);
  return (
    <Card aria-labelledby="est-head">
      <CardHeader
        titleId="est-head"
        title={`Estimate: ${formatRange(total)}`}
        description={total ? `${total.tasks.toLocaleString()} estimated task(s).` : 'No tasks yet.'}
      />
      <CardBody className={s.stack}>
        {e.unestimated_tasks > 0 ? (
          <Callout tone="warning">
            {e.unestimated_tasks} task(s) have no estimate and are not counted.
          </Callout>
        ) : null}
        <ul className={styles.plainList} aria-label="Estimation packs">
          {e.estimation.map((p) => (
            <li key={p.pack} className={s.row}>
              <Mono className={s.small}>{p.pack}</Mono>
              {p.calibrated ? (
                <Badge tone="success">Calibrated</Badge>
              ) : (
                <Badge tone="warning">UNCALIBRATED</Badge>
              )}
              <span className={`${s.muted} ${s.xs}`}>{p.basis}</span>
            </li>
          ))}
        </ul>
        <SegmentedControl
          label="Roll up by"
          value={by}
          onValueChange={setBy}
          options={[
            { value: 'by_stream', label: 'Stream' },
            { value: 'by_segment', label: 'Segment' },
            { value: 'by_wave', label: 'Wave' },
            { value: 'by_role', label: 'Role' },
          ]}
        />
        {rows.length === 0 ? (
          <p className={s.muted}>Nothing to roll up.</p>
        ) : (
          <KeyValueList
            items={rows.map(([k, r]) => ({
              key: k,
              label: by === 'by_segment' || by === 'by_wave' ? k : humanize(k),
              value: `${formatRange(r)} · ${String(r.tasks)} task(s)`,
            }))}
          />
        )}
      </CardBody>
    </Card>
  );
}

function TaskTable({ project }: { project: Project }) {
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<PlanTask | null>(null);
  const tasks = useTasks(project.id, {
    ...(role ? { role } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: PAGE,
  });
  const columns = useMemo(() => {
    const col = createDataTableColumns<PlanTask>();
    return col.columns([
      col.accessor('title', {
        header: 'Task',
        size: 300,
        cell: (info) => (
          <span className={s.cellStack}>
            <span style={{ whiteSpace: 'normal' }}>{info.getValue()}</span>
            {!info.row.original.approved ? (
              <span className={`${s.xs}`} style={{ color: 'var(--color-warning-text)' }}>
                Scope decision not approved yet
              </span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('role', {
        header: 'Role',
        size: 150,
        cell: (info) => humanize(info.getValue()),
      }),
      col.accessor((t) => t.likely ?? -1, {
        id: 'range',
        header: 'Estimate',
        size: 190,
        cell: (info) => formatRange(info.row.original),
      }),
      col.accessor((t) => t.wave ?? '', {
        id: 'wave',
        header: 'Wave',
        size: 90,
        cell: (info) => info.row.original.wave ?? '—',
      }),
      col.accessor((t) => t.depends_on.length, {
        id: 'deps',
        header: 'Waits for',
        size: 90,
        meta: { align: 'end' },
      }),
    ]);
  }, []);
  return (
    <Card flush aria-labelledby="tasks-table">
      <CardHeader
        titleId="tasks-table"
        title="Tasks"
        description="Select a task for the evidence behind its estimate."
      />
      <div className={s.filters} style={{ padding: 'var(--space-3) var(--space-5)' }}>
        <Field label="Role">
          <Select
            size="sm"
            options={[
              { value: ALL, label: 'All roles' },
              ...(tasks.data?.roles ?? []).map((r) => ({ value: r, label: humanize(r) })),
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
      ) : (
        <DataTable
          label="Plan tasks"
          data={tasks.data?.items}
          columns={columns}
          getRowId={(t) => t.key}
          loading={tasks.isPending}
          onRowClick={setOpen}
          maxHeight="32rem"
          empty={<EmptyState compact title="No tasks" />}
        />
      )}
      {tasks.data ? (
        <Pager offset={offset} limit={PAGE} total={tasks.data.total} onOffset={setOffset} />
      ) : null}
      {open ? <TaskSheet task={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

export function TaskSheet({ task: t, onClose }: { task: PlanTask; onClose: () => void }) {
  const ev = t.evidence;
  const cal = ev.calibration ?? {};
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={t.title}
      description={`${humanize(t.role)} · ${formatRange(t)}`}
      size="lg"
    >
      <div className={s.stack}>
        <KeyValueList
          items={[
            { key: 'key', label: 'Task key', value: <Mono className={s.xs}>{t.key}</Mono> },
            { key: 'element', label: 'Element', value: <Mono>{t.element}</Mono> },
            { key: 'disp', label: 'Disposition', value: humanize(t.disposition) },
            { key: 'part', label: 'Part', value: `${String(t.part)} of ${String(t.parts)}` },
            { key: 'wave', label: 'Wave', value: t.wave },
          ]}
        />
        <section aria-label="Estimate evidence">
          <h3 className={styles.sectionTitle}>Why this estimate</h3>
          {ev.rule ? (
            <KeyValueList
              items={[
                { key: 'rule', label: 'Estimation rule', value: <Mono>{ev.rule}</Mono> },
                { key: 'pack', label: 'Pack', value: ev.pack ? <Mono>{ev.pack}</Mono> : null },
                {
                  key: 'size',
                  label: 'Size',
                  value: ev.size !== undefined ? `${String(ev.size)} ${ev.unit ?? ''}` : null,
                },
                {
                  key: 'share',
                  label: 'Share of the rule for this activity',
                  value: ev.share !== undefined ? `${String(Math.round(ev.share * 100))}%` : null,
                },
                {
                  key: 'cal',
                  label: 'Calibration',
                  value:
                    cal.factor !== undefined
                      ? `Factor ${String(cal.factor)} from ${String(cal.samples ?? 0)} past task(s)${cal.note ? `: ${cal.note}` : ''}`
                      : 'Not calibrated by past work',
                },
                {
                  key: 'src',
                  label: 'Rule sources',
                  value: ev.rule_sources?.length ? ev.rule_sources.join('; ') : null,
                },
              ]}
            />
          ) : (
            <p className={s.muted}>{ev.note ?? 'No estimation rule covers this task.'}</p>
          )}
          {cal.past_tasks && cal.past_tasks.length > 0 ? (
            <details>
              <summary className={s.small}>Past tasks behind the calibration</summary>
              <ul className={styles.plainList}>
                {cal.past_tasks.map((p) => (
                  <li key={p}>
                    <Mono className={s.xs}>{p}</Mono>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
        <section aria-label="Waits for">
          <h3 className={styles.sectionTitle}>Waits for ({t.depends_on.length})</h3>
          {t.depends_on.length ? (
            <ul className={styles.plainList}>
              {t.depends_on.map((d) => (
                <li key={d}>
                  <Mono className={s.xs}>{d}</Mono>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>Nothing.</p>
          )}
        </section>
      </div>
    </Sheet>
  );
}
