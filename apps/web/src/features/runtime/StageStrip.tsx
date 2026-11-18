import { Bot, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useMoveStage, useStages } from '@/api/runtime';
import type { Project, ProjectStage, StageStatus } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import {
  Callout,
  Field,
  IconButton,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
  Tooltip,
} from '@/ui';
import s from '../shared.module.css';
import { gateRefusal, STAGE_STATUS_OPTIONS, stageStatus } from './model';
import styles from './Runtime.module.css';

/** The project's six lifecycle stages, with who last changed each (a person or an agent). */
export function StageStrip({ project }: { project: Project }) {
  const stages = useStages(project.id);
  const canManage = project.permissions.includes('stage:manage');
  const [editing, setEditing] = useState<ProjectStage | null>(null);

  if (stages.isPending) return <Skeleton height="5rem" />;
  if (stages.isError) {
    return (
      <ApiErrorView
        error={stages.error}
        title="Could not load stages"
        compact
        onRetry={() => void stages.refetch()}
      />
    );
  }
  return (
    <section aria-label="Lifecycle stages" className={styles.stagesWrap}>
      <ol className={styles.stages}>
        {stages.data.map((st, i) => {
          const status = stageStatus(st.status);
          return (
            <li key={st.stage} className={styles.stage} data-status={st.status}>
              <div className={styles.stageHead}>
                <span className={styles.stageNumber} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.stageTitle}>{st.title}</span>
                {canManage ? (
                  <Tooltip content="Change status">
                    <IconButton
                      size="sm"
                      label={`Change ${st.title} status`}
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => setEditing(st)}
                    />
                  </Tooltip>
                ) : null}
              </div>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
              {st.note ? <p className={styles.stageNote}>{st.note}</p> : null}
              {st.updated_by ? (
                <p className={styles.stageMeta}>
                  {st.updated_by_type === 'agent' ? (
                    <Bot
                      aria-label="Agent"
                      style={{ display: 'inline', width: '0.75rem', verticalAlign: '-0.1em' }}
                    />
                  ) : null}{' '}
                  {st.updated_by}
                  {st.updated_by_type === 'agent' ? ' (agent)' : ''}
                  {st.updated_at ? (
                    <>
                      {' · '}
                      <Timestamp value={st.updated_at} />
                    </>
                  ) : null}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {editing ? (
        <StageDialog project={project} stage={editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}

function StageDialog({
  project,
  stage,
  onClose,
}: {
  project: Project;
  stage: ProjectStage;
  onClose: () => void;
}) {
  const move = useMoveStage(project.id);
  const [status, setStatus] = useState<StageStatus>(stage.status as StageStatus);
  const [note, setNote] = useState(stage.note);
  const refusal = gateRefusal(move.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Change ${stage.title}`}
      description="Stage gates are checked by the platform, not by people or agents: a change the evidence does not support is refused, and the attempt is recorded."
      submitLabel="Save stage"
      pending={move.isPending}
      error={refusal ? null : move.error}
      fields={['status', 'note']}
      onSubmit={() =>
        move.mutate(
          { stage: stage.stage, status, note: note.trim() },
          {
            onSuccess: () => {
              toast.success(`${stage.title}: ${stageStatus(status).label}`);
              onClose();
            },
          },
        )
      }
    >
      <Field label="Status" required>
        <Select
          options={STAGE_STATUS_OPTIONS}
          value={status}
          onValueChange={(v) => {
            setStatus(v as StageStatus);
            if (move.error) move.reset();
          }}
        />
      </Field>
      <Field label="Note" help="Optional. Shown on the stage.">
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
        />
      </Field>
      {refusal ? (
        <Callout tone="danger" title="The stage gate refused this change" live>
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {refusal.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <p className={`${s.muted} ${s.xs}`}>Current: {stageStatus(stage.status).label}</p>
    </FormDialog>
  );
}
