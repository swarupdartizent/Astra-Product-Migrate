import { useProgrammeView } from '@/api/programmes';
import type { ProgrammeDetail, ViewCustomer } from '@/api/programmes-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Skeleton, StatusPill } from '@/ui';
import s from '../shared.module.css';
import { bandInfo, fmt, gateTitle } from './model';
import styles from './Programmes.module.css';

const BAND_ORDER = ['simple', 'medium', 'complex', 'not scanned'];

/**
 * The programme owner's view (E18.F3.S2): per visible customer, band and score, gates per
 * project, open risks, vendor gaps and breaks, and the last load; with programme totals. Only
 * numbers leave each customer's database.
 */
export function OverviewView({
  programme,
  onOpenCustomer,
}: {
  programme: ProgrammeDetail;
  onOpenCustomer: (customerId: string) => void;
}) {
  const q = useProgrammeView(programme.id);
  if (q.isPending) return <Skeleton height="18rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the programme view"
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  }
  const v = q.data;
  const t = v.totals;
  const bands = [
    ...BAND_ORDER.filter((b) => t.bands[b] !== undefined),
    ...Object.keys(t.bands).filter((b) => !BAND_ORDER.includes(b)),
  ];
  const unavailable = v.customers.filter((c) => c.unavailable).length;
  return (
    <div className={s.stack}>
      <section aria-labelledby="prog-totals-head">
        <h2 id="prog-totals-head" className="sr-only">
          Programme totals
        </h2>
        <dl className={styles.totals}>
          <div className={styles.total}>
            <dt>Customers</dt>
            <dd>{fmt(t.customers, 0)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Bands</dt>
            <dd className={styles.bands}>
              {bands.length === 0 ? (
                <span className={s.muted}>No customers</span>
              ) : (
                <span className={s.badges}>
                  {bands.map((b) => (
                    <Badge key={b} tone={bandInfo(b === 'not scanned' ? null : b).tone}>
                      {bandInfo(b === 'not scanned' ? null : b).label}: {t.bands[b]}
                    </Badge>
                  ))}
                </span>
              )}
            </dd>
          </div>
          <div className={styles.total}>
            <dt>Open vendor gaps</dt>
            <dd>{fmt(t.open_vendor_gaps, 0)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Open reconciliation breaks</dt>
            <dd>{fmt(t.open_breaks, 0)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Open risks</dt>
            <dd>{fmt(t.open_risks, 0)}</dd>
          </div>
        </dl>
      </section>
      <Card flush aria-labelledby="prog-customers-head">
        <CardHeader
          titleId="prog-customers-head"
          title="Customers"
          description="Counts are read from each customer’s own database; only numbers are shown here, never element names or business values."
        />
        {unavailable > 0 ? (
          <CardBody>
            <span className={`${s.small} ${s.muted}`} role="note">
              {unavailable} customer database(s) could not be read: their open risks and hours are
              shown as unavailable.
            </span>
          </CardBody>
        ) : null}
        {v.customers.length === 0 ? (
          <EmptyState
            compact
            title="No customers"
            body={
              v.scope === 'partner'
                ? 'No customers of this programme are assigned to your partner yet.'
                : 'Create tenants in this programme to see them here.'
            }
          />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Programme customers"
          >
            <table className={styles.table}>
              <caption className="sr-only">
                Each customer’s partner, segment, Complexity band and score, gates per project, open
                risks, vendor gaps and breaks, and the last load’s counts
              </caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Partner</th>
                  <th scope="col">Segment</th>
                  <th scope="col">Band and score</th>
                  <th scope="col">Gates per project</th>
                  <th scope="col" className={styles.num}>
                    Open risks
                  </th>
                  <th scope="col" className={styles.num}>
                    Vendor gaps
                  </th>
                  <th scope="col" className={styles.num}>
                    Breaks
                  </th>
                  <th scope="col">Last load</th>
                </tr>
              </thead>
              <tbody>
                {v.customers.map((c) => (
                  <CustomerRow key={c.customer_id} c={c} onOpen={onOpenCustomer} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function CustomerRow({ c, onOpen }: { c: ViewCustomer; onOpen: (id: string) => void }) {
  const band = bandInfo(c.band);
  return (
    <tr>
      <th scope="row">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpen(c.customer_id)}
          aria-label={`${c.customer}: open in the fleet`}
        >
          {c.customer}
        </Button>
      </th>
      <td>{c.partner ?? <span className={s.muted}>No partner</span>}</td>
      <td>{c.segment ?? <span className={s.muted}>None</span>}</td>
      <td>
        <span className={s.row}>
          <StatusPill tone={band.tone}>{band.label}</StatusPill>
          {c.score !== null ? <span className={styles.num}>{fmt(c.score)}</span> : null}
        </span>
      </td>
      <td>
        {c.gates.length === 0 ? (
          <span className={s.muted}>No projects</span>
        ) : (
          <ul className={styles.plainList}>
            {c.gates.map((g) => (
              <li key={g.project_id} className={s.small}>
                <strong>{g.project}</strong>: {g.passed} of {g.of}
                {g.next_gate ? `, next: ${gateTitle(g.next_gate)}` : ', all passed'}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={styles.num}>
        {c.unavailable ? <span className={s.muted}>Unavailable</span> : c.open_risks}
      </td>
      <td className={styles.num}>{c.open_vendor_gaps}</td>
      <td className={styles.num}>{c.open_breaks}</td>
      <td>
        {c.last_load ? (
          <span className={s.cellStack}>
            <span>
              Load {c.last_load.number} ({c.last_load.kind})
            </span>
            {c.last_load.counts ? (
              <span className={`${s.xs} ${s.muted}`}>
                {Object.entries(c.last_load.counts)
                  .filter((e): e is [string, number] => typeof e[1] === 'number')
                  .map(([k, n]) => `${k.replace(/_/g, ' ')} ${fmt(n, 0)}`)
                  .join(' · ')}
              </span>
            ) : null}
          </span>
        ) : (
          <span className={s.muted}>No load yet</span>
        )}
      </td>
    </tr>
  );
}
