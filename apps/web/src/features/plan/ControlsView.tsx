import { useControls } from '@/api/planning';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  KeyValueList,
  Mono,
  Skeleton,
  StatusPill,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { humanize } from './model';

export function ControlsView({ project }: { project: Project }) {
  const q = useControls(project.id);
  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the control matrix"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const m = q.data;
  return (
    <div className={s.stack}>
      <Callout
        tone={m.complete ? 'success' : 'warning'}
        title={m.complete ? 'Every control is planned' : 'Controls are not fully planned'}
      >
        {m.complete
          ? 'Each control has a task that operates it and the gates where it applies.'
          : 'Some controls have no operating task yet (generate tasks) or no gate.'}{' '}
        Compliance packs: {m.packs.length ? m.packs.join(', ') : 'none in the blueprint'}.
      </Callout>
      {m.controls.length === 0 ? (
        <EmptyState title="No controls" body="The blueprint's compliance packs add no controls." />
      ) : (
        m.controls.map((c) => (
          <Card key={c.control} aria-labelledby={`ctl-${c.control}`}>
            <CardHeader
              titleId={`ctl-${c.control}`}
              title={c.title}
              description={
                <span className={s.row}>
                  <Mono className={s.xs}>{c.control}</Mono>
                  <Badge>{humanize(c.type)}</Badge>
                  {c.compliance_critical ? <Badge tone="danger">Compliance critical</Badge> : null}
                  {c.two_person_approval ? <Badge tone="accent">Two-person approval</Badge> : null}
                </span>
              }
              actions={
                <StatusPill tone={c.control_task_exists ? 'success' : 'warning'}>
                  {c.control_task_exists ? 'Operating task planned' : 'No operating task'}
                </StatusPill>
              }
            />
            <CardBody className={s.stackSm}>
              <p className={s.small}>{c.rule}</p>
              <KeyValueList
                items={[
                  { key: 'pack', label: 'Pack', value: <Mono className={s.xs}>{c.pack}</Mono> },
                  { key: 'evidence', label: 'Evidence required', value: c.evidence_required },
                  { key: 'placement', label: 'Placement', value: humanize(c.placement) },
                  {
                    key: 'gates',
                    label: 'Gates',
                    value: c.gates.length ? c.gates.map(humanize).join(', ') : 'None',
                  },
                  { key: 'role', label: 'Operated by', value: humanize(c.role) },
                  {
                    key: 'governs',
                    label: 'Tasks it governs',
                    value: c.task_count.toLocaleString(),
                  },
                  { key: 'src', label: 'Sources', value: c.sources.join('; ') || null },
                ]}
              />
              {c.tasks.length > 0 ? (
                <details>
                  <summary className={s.small}>Governed tasks</summary>
                  <ul className={styles.plainList}>
                    {c.tasks.map((t) => (
                      <li key={t}>
                        <Mono className={s.xs}>{t}</Mono>
                      </li>
                    ))}
                    {c.task_count > c.tasks.length ? (
                      <li className={s.muted}>and {c.task_count - c.tasks.length} more</li>
                    ) : null}
                  </ul>
                </details>
              ) : null}
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}
