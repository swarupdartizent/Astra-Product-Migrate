import { CalendarRange, Play } from 'lucide-react';
import { useLatestPlan, useRunPlanner } from '@/api/programmes';
import type { PortfolioPlan, ProgrammeDetail, ProgrammeWave } from '@/api/programmes-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Mono,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { bandInfo, fmt } from './model';
import styles from './Programmes.module.css';

const STATUS_LABEL: Record<string, string> = {
  optimal: 'Optimal',
  feasible: 'Feasible (time limit reached)',
  infeasible: 'Infeasible',
  no_waves: 'No waves',
  unknown: 'Unknown',
  model_invalid: 'Model invalid',
};

/**
 * Portfolio planner (E18.F3.S1): places every scanned customer in one wave and one pod of its
 * partner. The plan shows each wave's places, each pod's rotation across waves, and the customers
 * that could not be placed with the reason.
 */
export function PortfolioView({ programme }: { programme: ProgrammeDetail }) {
  const q = useLatestPlan(programme.id);
  const run = useRunPlanner(programme.id);
  const why = !programme.can_manage ? 'Only the programme owner runs the planner.' : null;
  const action = (
    <span className={s.stackSm}>
      <span className={s.row}>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<Play aria-hidden="true" />}
          loading={run.isPending}
          disabled={why !== null}
          aria-describedby={why ? 'portfolio-run-why' : undefined}
          onClick={() =>
            run.mutate(undefined, {
              onSuccess: (plan) =>
                toast.success(
                  `Plan ${String(plan.number)}: ${String(plan.assignments.length)} placed, ${String(plan.conflicts.length)} conflict(s)`,
                ),
            })
          }
        >
          Run planner
        </Button>
      </span>
      {why ? (
        <span id="portfolio-run-why" className={`${s.xs} ${s.muted}`}>
          {why}
        </span>
      ) : null}
    </span>
  );
  return (
    <div className={s.stack}>
      <Card aria-labelledby="portfolio-head">
        <CardHeader
          titleId="portfolio-head"
          title="Portfolio plan"
          description="A wave holds a customer only if it is as long as the customer’s band needs; a pod migrates at most its capacity in a wave; earlier waves are preferred."
          actions={action}
        />
        <CardBody>
          <FormError error={run.error} />
          <div role="status" aria-live="polite" className={s.small}>
            {run.isPending ? 'Running the planner…' : null}
          </div>
          {q.isPending ? (
            <Skeleton height="4rem" />
          ) : q.isError ? (
            <ApiErrorView
              error={q.error}
              title="Could not load the latest plan"
              onRetry={() => void q.refetch()}
              compact
            />
          ) : q.data === null ? (
            <EmptyState
              compact
              icon={<CalendarRange />}
              title="No plan yet"
              body={
                programme.can_manage
                  ? 'Run the planner once customers are scanned and partners have pods and the programme has waves.'
                  : 'The programme owner has not run the planner yet.'
              }
            />
          ) : (
            <PlanSummary plan={q.data} />
          )}
        </CardBody>
      </Card>
      {q.data ? <PlanDetail programme={programme} plan={q.data} /> : null}
    </div>
  );
}

function PlanSummary({ plan }: { plan: PortfolioPlan }) {
  return (
    <p className={s.row}>
      <strong>Plan {plan.number}</strong>
      <Badge
        tone={
          plan.status === 'optimal' ? 'success' : plan.status === 'feasible' ? 'info' : 'warning'
        }
      >
        {STATUS_LABEL[plan.status] ?? plan.status}
      </Badge>
      <span className={s.small}>
        {plan.assignments.length} placed · {plan.conflicts.length} conflict(s)
      </span>
      {plan.created_at ? (
        <span className={`${s.xs} ${s.muted}`}>
          <Timestamp value={plan.created_at} />
        </span>
      ) : null}
    </p>
  );
}

function PlanDetail({ programme, plan }: { programme: ProgrammeDetail; plan: PortfolioPlan }) {
  const waves: ProgrammeWave[] = plan.waves ?? [];
  const partnerName = (id: string) => programme.partners.find((p) => p.id === id)?.name ?? null;
  return (
    <>
      {plan.conflicts.length > 0 ? (
        <Card aria-labelledby="portfolio-conflicts-head">
          <CardHeader
            titleId="portfolio-conflicts-head"
            title={`Conflicts (${String(plan.conflicts.length)})`}
            description="Customers the planner could not place, with the reason."
          />
          <CardBody>
            <ul className={styles.plainList} aria-label="Conflicts">
              {plan.conflicts.map((c, i) => (
                <li key={`${c.customer_id ?? 'programme'}-${String(i)}`} className={s.row}>
                  <strong>{c.customer ?? 'Programme'}</strong>
                  {c.band ? (
                    <StatusPill tone={bandInfo(c.band).tone}>{bandInfo(c.band).label}</StatusPill>
                  ) : null}
                  <span className={s.small}>{c.reason}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
      <Card flush aria-labelledby="portfolio-waves-head">
        <CardHeader
          titleId="portfolio-waves-head"
          title="Assignments by wave"
          description="Each customer’s wave and pod, with the weeks its band needs."
        />
        {waves.length === 0 ? (
          <EmptyState compact title="No waves in this plan" />
        ) : (
          waves.map((w) => {
            const rows = plan.assignments.filter((a) => a.wave === w.key);
            return (
              <CardBody key={w.key}>
                <h3 className={s.cellPrimary}>
                  {w.name} <Mono>{w.key}</Mono>{' '}
                  <span className={`${s.xs} ${s.muted}`}>
                    {w.start} to {w.end}
                  </span>
                </h3>
                {rows.length === 0 ? (
                  <p className={`${s.small} ${s.muted}`}>No customers in this wave.</p>
                ) : (
                  <div
                    className={styles.tableWrap}
                    // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    role="region"
                    aria-label={`Assignments in wave ${w.key}`}
                  >
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Customer</th>
                          <th scope="col">Band</th>
                          <th scope="col" className={styles.num}>
                            Weeks
                          </th>
                          <th scope="col">Pod</th>
                          <th scope="col">Partner</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.customer_id}>
                            <th scope="row">{a.customer}</th>
                            <td>
                              <StatusPill tone={bandInfo(a.band).tone}>
                                {bandInfo(a.band).label}
                              </StatusPill>
                            </td>
                            <td className={styles.num}>{fmt(a.weeks)}</td>
                            <td>{a.pod}</td>
                            <td>
                              {partnerName(a.partner_id) ?? <span className={s.muted}>—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            );
          })
        )}
      </Card>
      <Card flush aria-labelledby="portfolio-rotation-head">
        <CardHeader
          titleId="portfolio-rotation-head"
          title="Pod rotation"
          description="Each pod’s customers in each wave, against its capacity."
        />
        {plan.pods.length === 0 || waves.length === 0 ? (
          <EmptyState compact title="No pods in this plan" />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Pod rotation table"
          >
            <table className={styles.table}>
              <caption className="sr-only">
                Pods in rows, waves in columns; each cell lists the customers that pod migrates in
                that wave
              </caption>
              <thead>
                <tr>
                  <th scope="col">Pod</th>
                  {waves.map((w) => (
                    <th key={w.key} scope="col">
                      {w.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.pods.map((pod) => (
                  <tr key={pod.pod_id}>
                    <th scope="row">
                      <span className={s.cellStack}>
                        <span>{pod.pod}</span>
                        <span className={`${s.xs} ${s.muted}`}>
                          {partnerName(pod.partner_id) ?? 'Partner'} · capacity {pod.capacity}
                        </span>
                      </span>
                    </th>
                    {waves.map((w) => {
                      const cell = pod.waves.find((x) => x.wave === w.key)?.customers ?? [];
                      return (
                        <td key={w.key} className={styles.rotationCell}>
                          {cell.length === 0 ? (
                            <span className={s.muted}>Free</span>
                          ) : (
                            <span className={s.cellStack}>
                              {cell.map((c) => (
                                <span key={c}>{c}</span>
                              ))}
                              <span className={`${s.xs} ${s.muted}`}>
                                {cell.length} of {pod.capacity}
                              </span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
