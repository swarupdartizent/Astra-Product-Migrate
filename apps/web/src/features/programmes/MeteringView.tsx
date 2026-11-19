import { Download } from 'lucide-react';
import { saveBlob } from '@/api/client';
import { useGateEvidenceCsv, useMetering } from '@/api/programmes';
import type { ProgrammeDetail } from '@/api/programmes-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import {
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
import { shortDigest } from '../gates/model';
import s from '../shared.module.css';
import { bandInfo, fmt } from './model';
import styles from './Programmes.module.css';

/**
 * Commercial metering (E18.F4.S1): per customer, band and score, gates passed, actual effort,
 * elapsed days and planned wave; effort per segment and wave; and the gate evidence for
 * invoicing, exportable as CSV.
 */
export function MeteringView({ programme }: { programme: ProgrammeDetail }) {
  const q = useMetering(programme.id);
  const csv = useGateEvidenceCsv(programme.id);
  const exportButton = (
    <Button
      size="sm"
      leadingIcon={<Download aria-hidden="true" />}
      loading={csv.isPending}
      onClick={() =>
        csv.mutate(undefined, {
          onSuccess: (r) => {
            saveBlob(r);
            toast.success(`Saved ${r.filename}`);
          },
        })
      }
    >
      Export gate evidence (CSV)
    </Button>
  );
  if (q.isPending) return <Skeleton height="18rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load metering"
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  }
  const m = q.data;
  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="metering-customers-head">
        <CardHeader
          titleId="metering-customers-head"
          title="Customers"
          description={
            m.plan_number !== null
              ? `Effort is the hours imported from the delivery tool. Elapsed days run from the first project to the latest gate. Waves are from portfolio plan ${String(m.plan_number)}.`
              : 'Effort is the hours imported from the delivery tool. Elapsed days run from the first project to the latest gate. No portfolio plan yet, so no wave is planned.'
          }
        />
        {m.customers.length === 0 ? (
          <EmptyState compact title="No customers" />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Metering per customer"
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Segment</th>
                  <th scope="col">Band and score</th>
                  <th scope="col" className={styles.num}>
                    Gates passed
                  </th>
                  <th scope="col" className={styles.num}>
                    Effort (hours)
                  </th>
                  <th scope="col" className={styles.num}>
                    Elapsed days
                  </th>
                  <th scope="col">Wave</th>
                </tr>
              </thead>
              <tbody>
                {m.customers.map((c) => (
                  <tr key={c.customer_id}>
                    <th scope="row">{c.customer}</th>
                    <td>{c.segment ?? <span className={s.muted}>None</span>}</td>
                    <td>
                      <span className={s.row}>
                        <StatusPill tone={bandInfo(c.band).tone}>
                          {bandInfo(c.band).label}
                        </StatusPill>
                        {c.score !== null ? (
                          <span className={styles.num}>{fmt(c.score)}</span>
                        ) : null}
                      </span>
                    </td>
                    <td className={styles.num}>{c.gates_passed}</td>
                    <td className={styles.num}>{fmt(c.effort_hours)}</td>
                    <td className={styles.num}>
                      {c.elapsed_days ?? <span className={s.muted}>No project</span>}
                    </td>
                    <td>{c.wave ?? <span className={s.muted}>Unplanned</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush aria-labelledby="metering-compare-head">
        <CardHeader
          titleId="metering-compare-head"
          title="Effort by segment and wave"
          description="Hours per customer and per Complexity Index point, so segments and waves can be compared."
        />
        {m.segment_waves.length === 0 ? (
          <EmptyState compact title="Nothing to compare yet" />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Effort by segment and wave table"
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col">Wave</th>
                  <th scope="col" className={styles.num}>
                    Customers
                  </th>
                  <th scope="col" className={styles.num}>
                    Effort (hours)
                  </th>
                  <th scope="col" className={styles.num}>
                    Hours per customer
                  </th>
                  <th scope="col" className={styles.num}>
                    Hours per score point
                  </th>
                </tr>
              </thead>
              <tbody>
                {m.segment_waves.map((r) => (
                  <tr key={`${r.segment}|${r.wave}`}>
                    <th scope="row">{r.segment}</th>
                    <td>{r.wave}</td>
                    <td className={styles.num}>{r.customers}</td>
                    <td className={styles.num}>{fmt(r.effort_hours)}</td>
                    <td className={styles.num}>{fmt(r.hours_per_customer)}</td>
                    <td className={styles.num}>{fmt(r.hours_per_score_point, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush aria-labelledby="metering-evidence-head">
        <CardHeader
          titleId="metering-evidence-head"
          title="Gate evidence"
          description="Every gate pass with its approvers and checklist digest, for invoicing."
          actions={exportButton}
        />
        {csv.error ? (
          <CardBody>
            <FormError error={csv.error} />
          </CardBody>
        ) : null}
        {m.gate_evidence.length === 0 ? (
          <EmptyState compact title="No gate has passed yet" />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Gate evidence table"
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Project</th>
                  <th scope="col">Gate</th>
                  <th scope="col">Passed</th>
                  <th scope="col">Approvers</th>
                  <th scope="col">Checklist digest</th>
                </tr>
              </thead>
              <tbody>
                {m.gate_evidence.map((g) => (
                  <tr key={`${g.customer_id}|${g.project ?? ''}|${g.gate}|${g.checklist_digest}`}>
                    <th scope="row">
                      <span className={s.cellStack}>
                        <span>{g.customer}</span>
                        <span className={`${s.xs} ${s.muted}`}>
                          {g.segment ?? 'No segment'} · {bandInfo(g.band).label}
                        </span>
                      </span>
                    </th>
                    <td>{g.project ?? <span className={s.muted}>—</span>}</td>
                    <td>{g.label}</td>
                    <td>
                      {g.passed_at ? <Timestamp value={g.passed_at} format="absolute" /> : '—'}
                    </td>
                    <td>{g.approvers || <span className={s.muted}>None recorded</span>}</td>
                    <td>
                      <Mono title={g.checklist_digest}>{shortDigest(g.checklist_digest)}</Mono>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
