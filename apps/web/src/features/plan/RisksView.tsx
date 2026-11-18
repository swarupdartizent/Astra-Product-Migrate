import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useAddRisk, useRisks, useUpdateRisk } from '@/api/planning';
import type { Risk, RiskPatch } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { minLength, riskStatus, riskTone } from './model';
import { PersonPicker } from './PlanShared';

const SCALE = ['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }));

export function RisksView({ project, canManage }: { project: Project; canManage: boolean }) {
  const q = useRisks(project.id);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Risk | null>(null);
  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView error={q.error} title="Could not load risks" onRetry={() => void q.refetch()} />
    );
  }
  const proposed = q.data.filter((r) => r.status === 'proposed');
  return (
    <div className={s.stack}>
      {proposed.length > 0 ? (
        <Callout
          tone="warning"
          title={`${String(proposed.length)} risk(s) proposed by the planner`}
        >
          The planner found these when it generated tasks. A person accepts or rejects each one,
          with a reason.
        </Callout>
      ) : null}
      <Card aria-labelledby="risks-head">
        <CardHeader
          titleId="risks-head"
          title={`Risk register (${String(q.data.length)})`}
          description="Sorted by score (likelihood × impact, each 1 to 5)."
          actions={
            canManage ? (
              <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setAdding(true)}>
                Record a risk
              </Button>
            ) : null
          }
        />
        <CardBody>
          {q.data.length === 0 ? (
            <EmptyState compact title="No risks recorded" />
          ) : (
            <ul className={styles.gapList} aria-label="Risks">
              {q.data.map((r) => {
                const st = riskStatus(r.status);
                return (
                  <li
                    key={r.key}
                    className={styles.gap}
                    data-state={r.status === 'proposed' ? 'open-blocking' : undefined}
                  >
                    <span className={s.row} style={{ width: '100%' }}>
                      <Badge tone={riskTone(r.score)}>Score {r.score}</Badge>
                      <strong>{r.title}</strong>
                      <Mono className={s.xs}>{r.key}</Mono>
                      <span style={{ marginLeft: 'auto' }} className={s.row}>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        {canManage && r.status !== 'rejected' && r.status !== 'closed' ? (
                          <IconButton
                            size="sm"
                            label={
                              r.status === 'proposed'
                                ? `Decide risk ${r.title}`
                                : `Update risk ${r.title}`
                            }
                            icon={<Pencil aria-hidden="true" />}
                            onClick={() => setEditing(r)}
                          />
                        ) : null}
                      </span>
                    </span>
                    {r.detail ? <span className={s.small}>{r.detail}</span> : null}
                    <span className={`${s.muted} ${s.xs}`}>
                      Likelihood {r.likelihood} · impact {r.impact} · owner{' '}
                      {r.owner_name ?? 'not assigned'}
                      {r.mitigation_task ? ` · mitigated by ${r.mitigation_task}` : ''} · from{' '}
                      {r.source === 'person' ? 'a person' : r.source}
                    </span>
                    {r.decision ? (
                      <span className={`${s.muted} ${s.xs}`}>
                        {r.decision.by}: “{r.decision.note}”
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {adding ? <AddRiskDialog project={project} onClose={() => setAdding(false)} /> : null}
      {editing ? (
        <EditRiskDialog project={project} risk={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function AddRiskDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const add = useAddRisk(project.id);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [likelihood, setLikelihood] = useState('3');
  const [impact, setImpact] = useState('3');
  const [owner, setOwner] = useState('');
  const [task, setTask] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<
    'title' | 'detail' | 'likelihood' | 'impact' | 'owner_user_id' | 'mitigation_task'
  > = {};
  const t = minLength(title, 5, 'Name the risk');
  if (t) client.title = t;
  const errors = mergeFieldErrors(client, add.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Record a risk"
      description="A risk a person records goes straight into the register as accepted."
      submitLabel="Record risk"
      size="lg"
      pending={add.isPending}
      error={add.error}
      fields={['title', 'detail', 'likelihood', 'impact', 'owner_user_id', 'mitigation_task']}
      onSubmit={() => {
        setSubmitted(true);
        if (t) return;
        add.mutate(
          {
            title: title.trim(),
            detail: detail.trim(),
            likelihood: Number(likelihood),
            impact: Number(impact),
            owner_user_id: owner || null,
            mitigation_task: task.trim() || null,
          },
          {
            onSuccess: () => {
              toast.success('Risk recorded');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Title" error={errors.title} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      </Field>
      <Field label="Detail" error={errors.detail}>
        <Textarea
          rows={3}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          maxLength={4000}
        />
      </Field>
      <div className={s.grid2}>
        <Field label="Likelihood (1–5)" error={errors.likelihood}>
          <Select options={SCALE} value={likelihood} onValueChange={setLikelihood} />
        </Field>
        <Field label="Impact (1–5)" error={errors.impact}>
          <Select options={SCALE} value={impact} onValueChange={setImpact} />
        </Field>
      </div>
      <PersonPicker
        label="Owner"
        value={owner}
        currentName={null}
        onChange={setOwner}
        error={errors.owner_user_id}
      />
      <Field
        label="Mitigation task"
        help="A task key from Tasks and estimates (optional)."
        error={errors.mitigation_task}
      >
        <Input mono value={task} onChange={(e) => setTask(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

const KEEP = '__keep__';

function EditRiskDialog({
  project,
  risk,
  onClose,
}: {
  project: Project;
  risk: Risk;
  onClose: () => void;
}) {
  const update = useUpdateRisk(project.id);
  const proposed = risk.status === 'proposed';
  const [status, setStatus] = useState<string>(KEEP);
  const [note, setNote] = useState('');
  const [likelihood, setLikelihood] = useState(String(risk.likelihood));
  const [impact, setImpact] = useState(String(risk.impact));
  const [owner, setOwner] = useState(risk.owner_user_id ?? '');
  const [task, setTask] = useState(risk.mitigation_task ?? '');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<
    'note' | 'status' | 'likelihood' | 'impact' | 'owner_user_id' | 'mitigation_task'
  > = {};
  if (proposed && status === KEEP) client.status = 'Accept or reject the proposed risk.';
  if (status !== KEEP) {
    const n = minLength(note, 5, 'Say why');
    if (n) client.note = n;
  }
  const errors = mergeFieldErrors(client, update.error, submitted);
  const statusOptions = proposed
    ? [
        { value: KEEP, label: 'Choose…' },
        { value: 'accepted', label: 'Accept into the register' },
        { value: 'rejected', label: 'Reject' },
      ]
    : [
        { value: KEEP, label: 'Keep accepted' },
        { value: 'closed', label: 'Close the risk' },
      ];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={proposed ? `Decide: ${risk.title}` : `Update: ${risk.title}`}
      submitLabel="Save"
      size="lg"
      pending={update.isPending}
      error={update.error}
      fields={['status', 'note', 'likelihood', 'impact', 'owner_user_id', 'mitigation_task']}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        const patch: RiskPatch = {};
        if (status !== KEEP) {
          patch.status = status as RiskPatch['status'];
          patch.note = note.trim();
        }
        if (Number(likelihood) !== risk.likelihood) patch.likelihood = Number(likelihood);
        if (Number(impact) !== risk.impact) patch.impact = Number(impact);
        if ((owner || null) !== risk.owner_user_id) patch.owner_user_id = owner || null;
        if (task.trim() && task.trim() !== risk.mitigation_task)
          patch.mitigation_task = task.trim();
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        update.mutate(
          { key: risk.key, patch },
          {
            onSuccess: () => {
              toast.success('Risk updated');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Decision" error={errors.status} required={proposed}>
        <Select options={statusOptions} value={status} onValueChange={setStatus} />
      </Field>
      <Field
        label="Note"
        help="Required with a decision: at least 5 characters."
        error={errors.note}
        required={status !== KEEP}
      >
        <Textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
        />
      </Field>
      <div className={s.grid2}>
        <Field label="Likelihood (1–5)" error={errors.likelihood}>
          <Select options={SCALE} value={likelihood} onValueChange={setLikelihood} />
        </Field>
        <Field label="Impact (1–5)" error={errors.impact}>
          <Select options={SCALE} value={impact} onValueChange={setImpact} />
        </Field>
      </div>
      <PersonPicker
        label="Owner"
        value={owner}
        currentName={risk.owner_name}
        onChange={setOwner}
        error={errors.owner_user_id}
      />
      <Field label="Mitigation task" error={errors.mitigation_task}>
        <Input mono value={task} onChange={(e) => setTask(e.target.value)} />
      </Field>
    </FormDialog>
  );
}
