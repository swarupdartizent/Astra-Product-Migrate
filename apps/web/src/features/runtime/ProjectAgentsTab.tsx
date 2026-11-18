import { useQueryClient } from '@tanstack/react-query';
import { Bot, Pin, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useAgentRun,
  useAgentRuns,
  usePinAgent,
  usePins,
  useStartAgentRun,
  runtimeKeys,
} from '@/api/runtime';
import type { AgentPin, AgentRun, Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { JobProgress } from '@/app/JobProgress';
import { JobsCard } from '@/app/JobsCard';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  PlainText,
  Select,
  Sheet,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { formatTokens, formatUsd } from '../models/model';
import { actorLabel, runStatus, timeline } from './model';
import styles from './Runtime.module.css';

export function ProjectAgentsTab({
  project,
  initialRun = null,
}: {
  project: Project;
  /** Open this run's transcript (a link from the review workbench). */
  initialRun?: string | null;
}) {
  const pins = usePins(project.id);
  const runs = useAgentRuns(project.id);
  const canPin = project.permissions.includes('agent:pin');
  const canRun = project.permissions.includes('agent:run');
  const [pinning, setPinning] = useState<AgentPin | null>(null);
  const [running, setRunning] = useState<AgentPin | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(initialRun);

  const pinColumns = useMemo(() => {
    const col = createDataTableColumns<AgentPin>();
    return col.columns([
      col.accessor('title', {
        header: 'Agent',
        size: 260,
        cell: (info) => (
          <span className={s.cellStack}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <span className={`${s.muted} ${s.xs}`}>
              <Mono>{info.row.original.agent}</Mono> · {info.row.original.team}
            </span>
          </span>
        ),
      }),
      col.accessor((p) => p.pinned_version ?? '', {
        id: 'pinned',
        header: 'Pinned version',
        size: 220,
        cell: (info) => {
          const p = info.row.original;
          if (!p.pinned_version) return <span className={s.muted}>Not pinned</span>;
          return (
            <span className={s.cellStack}>
              <span className={s.row}>
                <Mono>{p.pinned_version}</Mono>
                {p.pinned_status && p.pinned_status !== 'released' ? (
                  <Badge tone="warning">{p.pinned_status}</Badge>
                ) : null}
                {p.newer_release ? <Badge tone="info">{p.newer_release} available</Badge> : null}
              </span>
              <span className={`${s.muted} ${s.xs}`} style={{ whiteSpace: 'normal' }}>
                {p.pinned_by ? `${p.pinned_by}, ` : ''}
                {p.pinned_at ? <Timestamp value={p.pinned_at} /> : null}
                {p.reason ? ` · “${p.reason}”` : ''}
              </span>
            </span>
          );
        },
      }),
      col.accessor((p) => p.released_versions.length, {
        id: 'released',
        header: 'Released versions',
        size: 160,
        cell: (info) =>
          info.row.original.released_versions.length ? (
            info.row.original.released_versions.join(', ')
          ) : (
            <span className={s.muted}>None released</span>
          ),
      }),
      col.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        size: 200,
        enableSorting: false,
        cell: (info) => {
          const p = info.row.original;
          return (
            <span className={s.rowActions}>
              {canPin && p.released_versions.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<Pin aria-hidden="true" />}
                  onClick={() => setPinning(p)}
                >
                  {p.pinned_version ? 'Change pin' : 'Pin'}
                </Button>
              ) : null}
              {canRun && p.pinned_version ? (
                <Button
                  size="sm"
                  leadingIcon={<Play aria-hidden="true" />}
                  onClick={() => setRunning(p)}
                >
                  Run
                </Button>
              ) : null}
            </span>
          );
        },
      }),
    ]);
  }, [canPin, canRun]);

  const runColumns = useMemo(() => {
    const col = createDataTableColumns<AgentRun>();
    return col.columns([
      col.accessor('created_at', {
        header: 'Started',
        size: 120,
        cell: (info) => <Timestamp value={info.getValue()} />,
      }),
      col.accessor('agent', {
        header: 'Agent',
        size: 200,
        cell: (info) => (
          <span>
            <Mono>{info.getValue()}</Mono>{' '}
            <span className={s.muted}>{info.row.original.agent_version}</span>
          </span>
        ),
      }),
      col.accessor('status', {
        header: 'Status',
        size: 220,
        cell: (info) => {
          const st = runStatus(info.getValue());
          return (
            <span className={s.cellStack}>
              <StatusPill tone={st.tone} pulse={info.getValue() === 'running'}>
                {st.label}
              </StatusPill>
              {info.row.original.status_detail ? (
                <span className={`${s.muted} ${s.xs}`} style={{ whiteSpace: 'normal' }}>
                  {info.row.original.status_detail}
                </span>
              ) : null}
            </span>
          );
        },
      }),
      col.accessor('requested_by', {
        header: 'Requested by',
        size: 170,
        cell: (info) => (
          <span className={s.row}>
            {info.getValue()} <Badge>{actorLabel(info.row.original.requested_by_type)}</Badge>
          </span>
        ),
      }),
      col.accessor((r) => r.input_tokens + r.output_tokens, {
        id: 'tokens',
        header: 'Tokens',
        size: 110,
        meta: { align: 'end' },
        cell: (info) => formatTokens(info.getValue()),
      }),
      col.accessor('cost_usd', {
        header: 'Cost',
        size: 100,
        meta: { align: 'end' },
        cell: (info) => formatUsd(info.getValue()),
      }),
      col.accessor('denied_tool_calls', {
        header: 'Refused tool calls',
        size: 140,
        meta: { align: 'end' },
        cell: (info) =>
          info.getValue() > 0 ? <Badge tone="warning">{info.getValue()}</Badge> : '0',
      }),
    ]);
  }, []);

  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="pins-title">
        <CardHeader
          titleId="pins-title"
          title="Agents on this project"
          description="Each agent runs at the version pinned here. Only released versions can be pinned."
        />
        <CardBody>
          {pins.isError ? (
            <ApiErrorView
              error={pins.error}
              title="Could not load agents"
              compact
              onRetry={() => void pins.refetch()}
            />
          ) : (
            <DataTable
              label="Agents and pinned versions"
              data={pins.data}
              columns={pinColumns}
              getRowId={(p) => p.agent}
              loading={pins.isPending}
              empty={<EmptyState compact icon={<Bot />} title="No agents registered" />}
            />
          )}
        </CardBody>
      </Card>

      <Card flush aria-labelledby="runs-title">
        <CardHeader
          titleId="runs-title"
          title="Agent runs"
          description="Newest first. Select a run to see its transcript."
        />
        <CardBody>
          {runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : (
            <DataTable
              label="Agent runs"
              data={runs.data}
              columns={runColumns}
              getRowId={(r) => r.id}
              loading={runs.isPending}
              onRowClick={(r) => setOpenRun(r.id)}
              empty={<EmptyState compact icon={<Play />} title="No agent runs yet" />}
            />
          )}
        </CardBody>
      </Card>

      <JobsCard
        filters={{ project_id: project.id }}
        description="Agent runs and other work for this project that runs in the background."
        refreshOnFinish={[runtimeKeys.runs(project.id)]}
      />

      {pinning ? (
        <PinDialog project={project} pin={pinning} onClose={() => setPinning(null)} />
      ) : null}
      {running ? (
        <RunDialog
          project={project}
          pin={running}
          onClose={() => setRunning(null)}
          onStarted={(id) => {
            setRunning(null);
            setOpenRun(id);
          }}
        />
      ) : null}
      {openRun ? <RunSheet runId={openRun} onClose={() => setOpenRun(null)} /> : null}
    </div>
  );
}

function PinDialog({
  project,
  pin,
  onClose,
}: {
  project: Project;
  pin: AgentPin;
  onClose: () => void;
}) {
  const save = usePinAgent(project.id);
  const [version, setVersion] = useState(pin.newer_release ?? pin.released_versions[0] ?? '');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'version' | 'reason'> = {};
  if (!version) clientErrors.version = 'Choose a released version.';
  if (reason.trim().length < 5)
    clientErrors.reason = `Say why (at least 5 characters, ${reason.trim().length} so far).`;
  const errors = mergeFieldErrors(clientErrors, save.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Pin ${pin.title}`}
      description="Runs on this project use the pinned version until it is changed here. Recorded in the audit log."
      submitLabel="Pin version"
      pending={save.isPending}
      error={save.error}
      fields={['version', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        save.mutate(
          { agent: pin.agent, version, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success(`${pin.title} pinned at ${version}`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Version"
        help="Released versions, newest first."
        error={errors.version}
        required
      >
        <Select
          options={pin.released_versions.map((v) => ({
            value: v,
            label: v === pin.pinned_version ? `${v} (pinned now)` : v,
          }))}
          value={version}
          onValueChange={setVersion}
        />
      </Field>
      <Field label="Reason" error={errors.reason} required>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}

function RunDialog({
  project,
  pin,
  onClose,
  onStarted,
}: {
  project: Project;
  pin: AgentPin;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const start = useStartAgentRun(project.id);
  const [objective, setObjective] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const n = objective.trim().length;
  const clientErrors: FieldErrors<'objective' | 'agent'> =
    n < 10 ? { objective: `Describe the task in at least 10 characters (${n} so far).` } : {};
  const errors = mergeFieldErrors(clientErrors, start.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Run ${pin.title} ${pin.pinned_version ?? ''}`}
      description="The agent works in the background within its guardrail limits. It can propose; people decide."
      submitLabel="Start run"
      size="lg"
      pending={start.isPending}
      error={start.error}
      fields={['objective', 'agent']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        start.mutate(
          { agent: pin.agent, objective: objective.trim() },
          {
            onSuccess: (run) => {
              toast.info(`${pin.title} started`);
              onStarted(run.id);
            },
          },
        );
      }}
    >
      <Field
        label="Objective"
        help="What the agent should do. 10–8000 characters."
        error={errors.objective ?? errors.agent}
        required
      >
        <Textarea
          rows={5}
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          maxLength={8000}
        />
      </Field>
    </FormDialog>
  );
}

function RunSheet({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useAgentRun(runId);
  const qc = useQueryClient();
  const r = run.data;
  const st = r ? runStatus(r.status) : null;
  const entries = r ? timeline(r.events) : [];

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={r ? `${r.agent} ${r.agent_version}` : 'Agent run'}
      description={r ? `Run ${r.id.slice(0, 8)}` : undefined}
      size="lg"
      actions={st ? <StatusPill tone={st.tone}>{st.label}</StatusPill> : null}
    >
      {run.isPending ? (
        <Skeleton height="16rem" />
      ) : run.isError ? (
        <ApiErrorView
          error={run.error}
          title="Could not load the run"
          compact
          onRetry={() => void run.refetch()}
        />
      ) : r ? (
        <>
          {r.job_id && (r.status === 'queued' || r.status === 'running') ? (
            <JobProgress
              jobId={r.job_id}
              title="Run in progress"
              compact
              onFinished={() => void qc.invalidateQueries({ queryKey: ['runtime'] })}
            />
          ) : null}
          {r.status_detail ? (
            <Callout
              tone={
                r.status === 'succeeded' ? 'info' : r.status === 'blocked' ? 'warning' : 'danger'
              }
              title={st?.label ?? r.status}
            >
              {r.status_detail}
            </Callout>
          ) : null}
          <KeyValueList
            items={[
              {
                key: 'by',
                label: 'Requested by',
                value: (
                  <span className={s.row}>
                    {r.requested_by} <Badge>{actorLabel(r.requested_by_type)}</Badge>
                  </span>
                ),
              },
              { key: 'started', label: 'Started', value: <Timestamp value={r.created_at} /> },
              {
                key: 'finished',
                label: 'Finished',
                value: r.finished_at ? <Timestamp value={r.finished_at} /> : null,
              },
              {
                key: 'usage',
                label: 'Usage',
                value: `${r.model_calls} model call${r.model_calls === 1 ? '' : 's'}, ${r.tool_calls} tool call${r.tool_calls === 1 ? '' : 's'}, ${formatTokens(r.input_tokens)} in / ${formatTokens(r.output_tokens)} out, ${formatUsd(r.cost_usd)}`,
              },
              {
                key: 'denied',
                label: 'Refused tool calls',
                value:
                  r.denied_tool_calls > 0 ? (
                    <Badge tone="warning">{r.denied_tool_calls}</Badge>
                  ) : (
                    '0'
                  ),
              },
              {
                key: 'parent',
                label: 'Asked by run',
                value: r.parent_run_id ? <Mono>{r.parent_run_id}</Mono> : null,
              },
            ]}
          />
          <section aria-label="Objective" className={s.stackSm}>
            <h3 className={s.cellPrimary}>Objective</h3>
            <PlainText label="Objective" empty={<p className={s.muted}>Not recorded.</p>}>
              {r.objective}
            </PlainText>
          </section>
          <section aria-label="Output" className={s.stackSm}>
            <h3 className={s.cellPrimary}>Output</h3>
            <PlainText label="Output" empty={<p className={s.muted}>No output yet.</p>}>
              {r.output}
            </PlainText>
          </section>
          <section aria-label="Transcript" className={s.stackSm}>
            <h3 className={s.cellPrimary}>Transcript ({entries.length})</h3>
            {entries.length === 0 ? (
              <p className={s.muted}>No events recorded yet.</p>
            ) : (
              <ol className={styles.timeline}>
                {entries.map((e) => (
                  <li key={e.seq} className={styles.event} data-tone={e.tone}>
                    <span className={styles.eventTitle}>
                      {e.title}{' '}
                      <span className={`${s.muted} ${s.xs}`}>
                        <Timestamp value={e.at} />
                      </span>
                    </span>
                    {e.text ? <PlainText>{e.text}</PlainText> : null}
                    {e.data !== null && e.data !== undefined ? (
                      <CodeBlock
                        code={JSON.stringify(e.data, null, 2)}
                        copyable={false}
                        maxHeight="14rem"
                      />
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : null}
    </Sheet>
  );
}
