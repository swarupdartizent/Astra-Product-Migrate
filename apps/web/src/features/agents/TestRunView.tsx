import { useMemo } from 'react';
import type { AgentTestRun, TestCaseResult } from '@/api/types';
import {
  Badge,
  Callout,
  createDataTableColumns,
  DataTable,
  Mono,
  PlainText,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { formatUsd } from '../models/model';
import { CASE_KIND_LABELS, orderCases, summaryText, testStatus } from './model';

const wrap = { whiteSpace: 'normal' } as const;

/** Per-case results of one test run. Blocked model cases read as Blocked, with the reason. */
export function TestRunView({ run }: { run: AgentTestRun }) {
  const cases = useMemo(() => orderCases(run.results), [run.results]);
  const blocked = cases.filter((c) => c.status === 'blocked');
  const st = testStatus(run.status);
  const columns = useMemo(() => {
    const col = createDataTableColumns<TestCaseResult>();
    return col.columns([
      col.accessor('name', {
        header: 'Case',
        size: 240,
        cell: (info) => (
          <span className={s.cellStack} style={wrap}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <Badge>{CASE_KIND_LABELS[info.row.original.kind] ?? info.row.original.kind}</Badge>
          </span>
        ),
      }),
      col.accessor('status', {
        header: 'Result',
        size: 110,
        cell: (info) => {
          const t = testStatus(info.getValue());
          return <StatusPill tone={t.tone}>{t.label}</StatusPill>;
        },
      }),
      col.accessor('detail', {
        header: 'Detail',
        size: 340,
        cell: (info) => <span style={wrap}>{info.getValue()}</span>,
      }),
      col.display({
        id: 'evidence',
        header: 'Tools, models, screening',
        size: 300,
        cell: (info) => {
          const c = info.row.original;
          return (
            <span className={s.cellStack} style={wrap}>
              {c.tools_called?.length ? (
                <span className={s.small}>
                  Tools: <Mono>{c.tools_called.join(', ')}</Mono>
                </span>
              ) : null}
              {c.models?.length ? (
                <span className={s.small}>
                  Models: <Mono>{c.models.join(', ')}</Mono>
                </span>
              ) : null}
              {c.screening?.length ? (
                <span className={s.small}>
                  Screening:{' '}
                  {c.screening
                    .map(
                      (x) =>
                        `${x.source} ${x.flagged ? `flagged (${x.rules.join(', ')})` : 'clean'}`,
                    )
                    .join('; ')}
                </span>
              ) : null}
              {c.cost_usd !== undefined ? (
                <span className={`${s.muted} ${s.xs}`}>Cost {formatUsd(c.cost_usd)}</span>
              ) : null}
            </span>
          );
        },
      }),
    ]);
  }, []);

  return (
    <div className={s.stackSm}>
      <p className={s.row}>
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
        <span className={s.small}>{summaryText(run)}</span>
        <span className={`${s.muted} ${s.xs}`}>
          started <Timestamp value={run.started_at} />
          {run.started_by ? ` by ${run.started_by}` : ''} · cost {formatUsd(run.cost_usd)}
        </span>
        {!run.digest_matches ? <Badge tone="warning">Manifest changed since this run</Badge> : null}
      </p>
      {blocked.length > 0 ? (
        <Callout
          tone="warning"
          title={`${blocked.length} case${blocked.length === 1 ? '' : 's'} blocked`}
        >
          Blocked is not a failure: the case could not run because an input is missing.{' '}
          {blocked[0]?.detail}
        </Callout>
      ) : null}
      <DataTable
        label={`Test cases for ${run.agent} ${run.version}`}
        data={cases}
        columns={columns}
        getRowId={(c) => `${c.kind}:${c.name}`}
      />
      {cases.some((c) => c.answer) ? (
        <details>
          <summary className={s.small}>
            Model answers ({cases.filter((c) => c.answer).length})
          </summary>
          <div className={s.stackSm} style={{ marginTop: 'var(--space-2)' }}>
            {cases
              .filter((c) => c.answer)
              .map((c) => (
                <section key={c.name} aria-label={`Answer for ${c.name}`}>
                  <h4 className={s.small} style={{ fontWeight: 600 }}>
                    {c.name}
                  </h4>
                  <PlainText>{c.answer}</PlainText>
                </section>
              ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
