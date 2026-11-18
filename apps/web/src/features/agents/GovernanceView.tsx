import { Download } from 'lucide-react';
import { useGovernanceRecord } from '@/api/agents';
import { saveBlob } from '@/api/client';
import type { GovernanceRecord } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  Mono,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { formatUsd } from '../models/model';
import { effectLabel, governanceJson, RISK_TONE, summaryText, testStatus } from './model';

/** The governance record as an auditor reads it. */
export function GovernanceView({ name, version }: { name: string; version: string }) {
  const record = useGovernanceRecord(name, version);
  if (record.isPending) return <Skeleton height="20rem" />;
  if (record.isError) {
    return (
      <ApiErrorView
        error={record.error}
        title="Could not load the governance record"
        onRetry={() => void record.refetch()}
      />
    );
  }
  return <GovernanceRecordView record={record.data} />;
}

export function GovernanceRecordView({ record: r }: { record: GovernanceRecord }) {
  const list = (items: readonly string[]) =>
    items.length ? (
      <ul style={{ paddingLeft: 'var(--space-4)' }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    ) : null;

  return (
    <div className={s.stack}>
      <div className={s.row} style={{ justifyContent: 'flex-end' }}>
        <Button
          size="sm"
          leadingIcon={<Download aria-hidden="true" />}
          onClick={() =>
            saveBlob({
              blob: new Blob([governanceJson([r])], { type: 'application/json' }),
              filename: `governance-${r.agent}-${r.version}.json`,
            })
          }
        >
          Download JSON
        </Button>
      </div>
      <Card aria-labelledby="gov-risk">
        <CardHeader
          titleId="gov-risk"
          title="Risk and intended use"
          actions={
            <Badge tone={RISK_TONE[r.risk_rating] ?? 'neutral'}>Risk: {r.risk_rating}</Badge>
          }
        />
        <CardBody>
          <KeyValueList
            items={[
              { key: 'purpose', label: 'Purpose', value: r.purpose },
              { key: 'rationale', label: 'Risk rationale', value: r.risk_rationale },
              { key: 'use', label: 'Intended use', value: r.intended_use },
              { key: 'oos', label: 'Out of scope', value: list(r.out_of_scope) },
              { key: 'reg', label: 'Regulatory notes', value: r.regulatory_notes || null },
              { key: 'data', label: 'Data access', value: r.data_access.replace(/_/g, ' ') },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="gov-oversight">
        <CardHeader titleId="gov-oversight" title="Human oversight and hard rules" />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'autonomy',
                label: 'Autonomy',
                value: r.oversight.autonomy.replace(/_/g, ' '),
              },
              {
                key: 'review',
                label: 'People review or decide',
                value: list(r.oversight.human_review),
              },
              { key: 'esc', label: 'Escalation', value: r.oversight.escalation },
              {
                key: 'rules',
                label: 'Hard rules (enforced by the platform)',
                value: list(r.hard_rules),
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="gov-tools">
        <CardHeader titleId="gov-tools" title="Tools and model" />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'tools',
                label: 'Tools',
                value: r.tools.length ? (
                  <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                    {r.tools.map((t) => (
                      <li key={t.name} className={s.cellStack}>
                        <span className={s.row}>
                          <Mono>{t.name}</Mono> <Badge>{effectLabel(t.effect)}</Badge>
                        </span>
                        <span className={`${s.muted} ${s.small}`}>{t.description}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  'None'
                ),
              },
              {
                key: 'alias',
                label: 'Model alias',
                value: (
                  <span>
                    <Mono>{r.model.alias}</Mono> · effort {r.model.effort}
                  </span>
                ),
              },
              {
                key: 'resolves',
                label: 'Currently resolves to',
                value: r.model.currently_resolves_to ? (
                  <Mono>{r.model.currently_resolves_to.model}</Mono>
                ) : (
                  'The alias does not exist'
                ),
              },
              {
                key: 'answered',
                label: 'Models that actually answered',
                value: r.model.models_that_answered.length ? (
                  <span className={s.badges}>
                    {r.model.models_that_answered.map((m) => (
                      <Badge key={m}>{m}</Badge>
                    ))}
                  </span>
                ) : (
                  'None yet'
                ),
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="gov-usage">
        <CardHeader titleId="gov-usage" title="Usage, tests and release" />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'usage',
                label: 'Usage',
                value: `${r.usage.model_calls} model calls, ${formatUsd(r.usage.cost_usd)}, ${r.usage.agent_runs} runs, pinned in ${r.usage.projects_pinned} project${r.usage.projects_pinned === 1 ? '' : 's'}`,
              },
              {
                key: 'cases',
                label: 'Test cases',
                value: `${r.tests.cases} (${Object.entries(r.tests.by_kind)
                  .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
                  .join(', ')})`,
              },
              {
                key: 'history',
                label: 'Test history',
                value: r.tests.history.length ? (
                  <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                    {r.tests.history.map((h) => {
                      const t = testStatus(h.status);
                      return (
                        <li key={h.id} className={s.row}>
                          <StatusPill tone={t.tone}>{t.label}</StatusPill>
                          <span className={s.small}>{summaryText(h)}</span>
                          <span className={`${s.muted} ${s.xs}`}>
                            <Timestamp value={h.started_at} />
                            {h.digest_matches ? '' : ' · older manifest'}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  'Never run'
                ),
              },
              {
                key: 'release',
                label: 'Release',
                value: r.release.released_at ? (
                  <span className={s.cellStack}>
                    <span>
                      <Timestamp value={r.release.released_at} />
                      {r.release.released_by ? ` by ${r.release.released_by}` : ''}
                    </span>
                    {r.release.note ? (
                      <span className={`${s.muted} ${s.small}`}>“{r.release.note}”</span>
                    ) : null}
                  </span>
                ) : (
                  'Not released'
                ),
              },
              {
                key: 'registered',
                label: 'Registered',
                value: <Timestamp value={r.registered_at} />,
              },
              { key: 'digest', label: 'Digest', value: <Mono className={s.xs}>{r.digest}</Mono> },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}
