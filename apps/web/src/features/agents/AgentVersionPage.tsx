import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Archive, FlaskConical, Rocket } from 'lucide-react';
import { useState } from 'react';
import {
  agentKeys,
  useAgentTestRun,
  useAgentTestRuns,
  useAgentVersion,
  useDeprecateAgentVersion,
  useReleaseAgentVersion,
  useStartAgentTests,
  useToolCatalogue,
} from '@/api/agents';
import type { AgentVersionDetail } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, reasonError } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CodeBlock,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { GovernanceView } from './GovernanceView';
import {
  agentVersionStatus,
  effectLabel,
  isTestRunActive,
  RISK_TONE,
  summaryText,
  testStatus,
  VERSION_TABS,
  type VersionTab,
} from './model';
import { TestRunView } from './TestRunView';

export interface AgentVersionPageProps {
  name: string;
  version: string;
  tab: VersionTab;
}

export function AgentVersionPage({ name, version, tab }: AgentVersionPageProps) {
  const detail = useAgentVersion(name, version);
  const navigate = useNavigate();
  useDocumentTitle(detail.data ? `${detail.data.manifest.title} ${version}` : `${name} ${version}`);
  const breadcrumbs = [
    { label: 'Agents', to: '/agents' as const },
    { label: `${name} ${version}` },
  ];

  if (detail.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">Loading agent…</span>
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="18rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title={`${name} ${version}`} />
        <ApiErrorView
          error={detail.error}
          title="Could not load this agent version"
          onRetry={() => void detail.refetch()}
        />
      </>
    );
  }
  const v = detail.data;
  const st = agentVersionStatus(v.status);
  const m = v.manifest;

  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={m.title}
        meta={
          <span className={s.row}>
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
            <Badge tone={RISK_TONE[m.governance.risk_rating] ?? 'neutral'}>
              risk {m.governance.risk_rating}
            </Badge>
          </span>
        }
        description={
          <>
            <Mono>
              {v.agent} {v.version}
            </Mono>{' '}
            · team {m.team}
          </>
        }
      />
      <Tabs
        value={VERSION_TABS.includes(tab) ? tab : 'overview'}
        onValueChange={(t) =>
          void navigate({
            to: '/agents/$name/$version',
            params: { name, version },
            search: { tab: t as VersionTab },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Agent version sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="tests">Test suite</Tab>
          <Tab value="manifest">Manifest</Tab>
          <Tab value="governance">Governance record</Tab>
        </TabsList>
        <TabPanel value="overview">
          <Overview v={v} />
        </TabPanel>
        <TabPanel value="tests">
          <TestsTab v={v} />
        </TabPanel>
        <TabPanel value="manifest">
          <CodeBlock
            label={`${v.agent}-${v.version}.yaml (read only)`}
            code={v.manifest_yaml}
            maxHeight="70vh"
          />
        </TabPanel>
        <TabPanel value="governance">
          <GovernanceView name={name} version={version} />
        </TabPanel>
      </Tabs>
    </>
  );
}

function Overview({ v }: { v: AgentVersionDetail }) {
  const tools = useToolCatalogue();
  const m = v.manifest;
  const manage = v.permissions.includes('agent:manage');
  const [releasing, setReleasing] = useState(false);
  const [deprecating, setDeprecating] = useState(false);
  const g = m.guardrails ?? {};

  return (
    <div className={s.stack}>
      {!v.model_ready ? (
        <Callout tone="warning" title="Blocked: no model available">
          {v.model_status}
        </Callout>
      ) : null}
      <Card aria-labelledby="agent-about">
        <CardHeader titleId="agent-about" title="Purpose and access" />
        <CardBody>
          <KeyValueList
            items={[
              { key: 'purpose', label: 'Purpose', value: m.purpose },
              { key: 'team', label: 'Team', value: m.team },
              {
                key: 'data',
                label: 'Data access',
                value:
                  m.data_access === 'metadata_only' ? (
                    <Badge tone="success">Metadata only</Badge>
                  ) : (
                    <Badge tone="warning">Business data</Badge>
                  ),
              },
              {
                key: 'model',
                label: 'Model alias',
                value: (
                  <span className={s.cellStack}>
                    <span>
                      <Mono>{m.model.alias}</Mono>
                      {m.model.effort ? (
                        <span className={s.muted}> · effort {m.model.effort}</span>
                      ) : null}
                    </span>
                    <span className={s.row}>
                      <StatusPill tone={v.model_ready ? 'success' : 'warning'}>
                        {v.model_ready ? 'Ready' : 'Blocked'}
                      </StatusPill>
                      <span className={s.small}>{v.model_status}</span>
                    </span>
                  </span>
                ),
              },
              {
                key: 'created',
                label: 'Registered',
                value: (
                  <>
                    <Timestamp value={v.created_at} />
                    {v.created_by ? ` by ${v.created_by}` : ''}
                  </>
                ),
              },
              {
                key: 'released',
                label: 'Released',
                value: v.released_at ? (
                  <span className={s.cellStack}>
                    <span>
                      <Timestamp value={v.released_at} />
                      {v.released_by ? ` by ${v.released_by}` : ''}
                    </span>
                    {v.release_note ? (
                      <span className={`${s.muted} ${s.small}`}>“{v.release_note}”</span>
                    ) : null}
                  </span>
                ) : null,
              },
              {
                key: 'digest',
                label: 'Manifest digest',
                value: <Mono className={s.xs}>{v.digest}</Mono>,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Card aria-labelledby="agent-tools">
        <CardHeader
          titleId="agent-tools"
          title={`Tools (${m.tools?.length ?? 0})`}
          description="The only tools this agent may call. Calls to anything else are refused and audited."
        />
        <CardBody className={s.stackSm}>
          {(m.tools ?? []).length === 0 ? (
            <p className={s.muted}>This agent has no tools.</p>
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm}>
              {(m.tools ?? []).map((name) => {
                const t = tools.data?.tools.find((x) => x.name === name);
                return (
                  <li key={name} className={s.cellStack}>
                    <span className={s.row}>
                      <Mono>{name}</Mono>
                      {t ? (
                        <Badge>{effectLabel(t.effect)}</Badge>
                      ) : (
                        <Badge tone="warning">Unknown tool</Badge>
                      )}
                    </span>
                    {t ? <span className={`${s.muted} ${s.small}`}>{t.description}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {tools.data?.forbidden_effects.length ? (
            <Callout tone="info" title="No tool can ever do this">
              {tools.data.forbidden_effects.map((e) => e.replace(/_/g, ' ')).join(', ')}.
            </Callout>
          ) : null}
        </CardBody>
      </Card>

      <div className={s.grid2}>
        <Card aria-labelledby="agent-limits">
          <CardHeader titleId="agent-limits" title="Guardrail limits" />
          <CardBody>
            <KeyValueList
              layout="stack"
              items={[
                {
                  key: 'screen',
                  label: 'Untrusted inputs screened',
                  value: g.screen_untrusted_inputs === false ? 'No' : 'Always',
                },
                { key: 'calls', label: 'Model calls per run', value: g.max_model_calls ?? 20 },
                { key: 'tools', label: 'Tool calls per run', value: g.max_tool_calls ?? 30 },
                {
                  key: 'cost',
                  label: 'Cost per run',
                  value: `$${(g.max_cost_usd ?? 2).toFixed(2)}`,
                },
                { key: 'depth', label: 'Delegation depth', value: g.max_delegation_depth ?? 1 },
              ]}
            />
          </CardBody>
        </Card>
        <Card aria-labelledby="agent-oversight">
          <CardHeader titleId="agent-oversight" title="Human oversight" />
          <CardBody>
            <KeyValueList
              layout="stack"
              items={[
                {
                  key: 'autonomy',
                  label: 'Autonomy',
                  value:
                    m.oversight.autonomy === 'propose_only' ? 'Proposes only' : 'Acts within gates',
                },
                {
                  key: 'review',
                  label: 'People review or decide',
                  value: (
                    <ul style={{ paddingLeft: 'var(--space-4)' }}>
                      {m.oversight.human_review.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  ),
                },
                { key: 'escalation', label: 'Escalation', value: m.oversight.escalation },
              ]}
            />
          </CardBody>
        </Card>
      </div>

      <Card aria-labelledby="agent-release">
        <CardHeader
          titleId="agent-release"
          title="Release"
          description="A version is released only when its latest test run, on this exact manifest, passed."
        />
        <CardBody>
          {v.release_blockers.length > 0 ? (
            <Callout
              tone={v.status === 'draft' ? 'warning' : 'info'}
              title={v.status === 'draft' ? 'Not ready to release' : 'Release'}
            >
              <ul style={{ paddingLeft: 'var(--space-4)' }}>
                {v.release_blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Callout>
          ) : (
            <p className={s.small}>
              The latest test run passed on this manifest. It can be released.
            </p>
          )}
        </CardBody>
        {manage ? (
          <CardFooter>
            {v.status === 'released' ? (
              <Button
                variant="danger"
                leadingIcon={<Archive aria-hidden="true" />}
                onClick={() => setDeprecating(true)}
              >
                Deprecate
              </Button>
            ) : null}
            {v.status === 'draft' ? (
              <Button
                variant="primary"
                leadingIcon={<Rocket aria-hidden="true" />}
                aria-disabled={v.release_blockers.length > 0}
                onClick={() => {
                  if (v.release_blockers.length === 0) setReleasing(true);
                }}
              >
                Release
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>
      {releasing ? <NoteDialog v={v} mode="release" onClose={() => setReleasing(false)} /> : null}
      {deprecating ? (
        <NoteDialog v={v} mode="deprecate" onClose={() => setDeprecating(false)} />
      ) : null}
    </div>
  );
}

function NoteDialog({
  v,
  mode,
  onClose,
}: {
  v: AgentVersionDetail;
  mode: 'release' | 'deprecate';
  onClose: () => void;
}) {
  const release = useReleaseAgentVersion(v.agent, v.version);
  const deprecate = useDeprecateAgentVersion(v.agent, v.version);
  const mutation = mode === 'release' ? release : deprecate;
  const field = mode === 'release' ? 'note' : 'reason';
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const r = reasonError(text);
  const clientErrors = r ? { [field]: r } : {};
  const errors = mergeFieldErrors<string>(clientErrors, mutation.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      tone={mode === 'deprecate' ? 'danger' : 'default'}
      title={
        mode === 'release' ? `Release ${v.agent} ${v.version}` : `Deprecate ${v.agent} ${v.version}`
      }
      description={
        mode === 'release'
          ? 'Projects can pin a released version. The server checks the test suite again and refuses if anything changed.'
          : 'Projects already pinned keep the version but are told to move on. It cannot be pinned again.'
      }
      submitLabel={mode === 'release' ? 'Release' : 'Deprecate'}
      pending={mutation.isPending}
      error={mutation.error}
      fields={[field]}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        mutation.mutate(text.trim(), {
          onSuccess: () => {
            toast.success(
              mode === 'release'
                ? `${v.agent} ${v.version} released`
                : `${v.agent} ${v.version} deprecated`,
            );
            onClose();
          },
        });
      }}
    >
      <Field
        label={mode === 'release' ? 'Release note' : 'Reason'}
        help="At least 10 characters. Recorded in the audit log."
        error={errors[field]}
        required
      >
        <Textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

function TestsTab({ v }: { v: AgentVersionDetail }) {
  const runs = useAgentTestRuns(v.agent, v.version);
  const start = useStartAgentTests(v.agent, v.version);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const currentId = selected ?? runs.data?.[0]?.id ?? null;
  const run = useAgentTestRun(currentId);
  const manage = v.permissions.includes('agent:manage');
  const active = runs.data?.find((r) => isTestRunActive(r.status) && r.job_id);

  return (
    <div className={s.stack}>
      <Card aria-labelledby="suite-title">
        <CardHeader
          titleId="suite-title"
          title="Test suite"
          description={`${v.manifest.tests.length} case${v.manifest.tests.length === 1 ? '' : 's'}: tool policy and screening cases run without a model; model cases make real model calls and show as Blocked when no model is available.`}
          actions={
            manage && v.status === 'draft' ? (
              <Button
                size="sm"
                leadingIcon={<FlaskConical aria-hidden="true" />}
                loading={start.isPending}
                disabled={active !== undefined}
                onClick={() =>
                  start.mutate(undefined, {
                    onSuccess: (tr) => {
                      setSelected(tr.id);
                      toast.info('Test suite started');
                    },
                  })
                }
              >
                Run tests
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {start.isError ? <FormError error={start.error} /> : null}
          {active?.job_id ? (
            <JobProgress
              jobId={active.job_id}
              title={`Testing ${v.agent} ${v.version}`}
              onFinished={() => void qc.invalidateQueries({ queryKey: agentKeys.all })}
            />
          ) : null}
          {runs.isPending ? (
            <Skeleton height="4rem" />
          ) : runs.isError ? (
            <ApiErrorView
              error={runs.error}
              title="Could not load test runs"
              compact
              onRetry={() => void runs.refetch()}
            />
          ) : runs.data.length === 0 ? (
            <EmptyState compact icon={<FlaskConical />} title="The suite has not run" />
          ) : (
            <ul style={{ listStyle: 'none' }} className={s.stackSm} aria-label="Test run history">
              {runs.data.map((r) => {
                const t = testStatus(r.status);
                return (
                  <li key={r.id}>
                    <Button
                      variant={r.id === currentId ? 'secondary' : 'ghost'}
                      size="sm"
                      aria-pressed={r.id === currentId}
                      onClick={() => setSelected(r.id)}
                    >
                      <StatusPill tone={t.tone}>{t.label}</StatusPill>
                      <span>{summaryText(r)}</span>
                      <span className={s.muted}>
                        <Timestamp value={r.started_at} />
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
      {currentId ? (
        <Card aria-labelledby="run-cases">
          <CardHeader titleId="run-cases" title="Cases" />
          <CardBody>
            {run.isPending ? (
              <Skeleton height="8rem" />
            ) : run.isError ? (
              <ApiErrorView
                error={run.error}
                title="Could not load the test run"
                compact
                onRetry={() => void run.refetch()}
              />
            ) : (
              <TestRunView run={run.data} />
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
