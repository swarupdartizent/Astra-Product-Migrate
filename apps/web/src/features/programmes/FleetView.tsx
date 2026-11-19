import { Link } from '@tanstack/react-router';
import { FileSignature, Radar } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { useSourceConnections } from '@/api/adapters';
import {
  useConsents,
  useFleet,
  useFleetScans,
  useRecordConsent,
  useRevokeConsent,
  useStartScan,
} from '@/api/programmes';
import type {
  Consent,
  FleetRow,
  FleetScan,
  MciScore,
  ProgrammeDetail,
} from '@/api/programmes-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, reasonError } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import {
  bandInfo,
  CONSENT_SCOPE_MIN,
  consentErrors,
  fmt,
  scanStatus,
  type ConsentField,
} from './model';
import styles from './Programmes.module.css';

/**
 * Fleet (E18.F2): per customer, the consent and the latest light scan with its Complexity Index;
 * per segment, the mean score and band counts. A scan needs the customer's active consent and a
 * checked read-only source connection.
 */
export function FleetView({
  programme,
  selected,
  onSelect,
}: {
  programme: ProgrammeDetail;
  selected: string | null;
  onSelect: (customerId: string | null) => void;
}) {
  const q = useFleet(programme.id);
  const headingRef = useRef<HTMLSpanElement>(null);
  if (q.isPending) return <Skeleton height="18rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the fleet"
        onRetry={() => void q.refetch()}
        retrying={q.isFetching}
      />
    );
  }
  const fleet = q.data;
  const row = fleet.customers.find((c) => c.customer_id === selected) ?? null;
  const partnerName = (id: string | null) =>
    id ? (programme.partners.find((p) => p.id === id)?.name ?? null) : null;
  const open = (id: string) => {
    onSelect(id);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="fleet-segments-head">
        <CardHeader
          titleId="fleet-segments-head"
          title="Segments"
          description="Mean Complexity Index of the scanned customers in each segment, the band of that mean, and how many customers are in each band."
        />
        {fleet.segments.length === 0 ? (
          <EmptyState compact title="No scanned customers yet" />
        ) : (
          <div
            className={styles.tableWrap}
            // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Segment summary"
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Segment</th>
                  <th scope="col" className={styles.num}>
                    Scanned customers
                  </th>
                  <th scope="col" className={styles.num}>
                    Mean score
                  </th>
                  <th scope="col">Band</th>
                  <th scope="col" className={styles.num}>
                    Simple
                  </th>
                  <th scope="col" className={styles.num}>
                    Medium
                  </th>
                  <th scope="col" className={styles.num}>
                    Complex
                  </th>
                </tr>
              </thead>
              <tbody>
                {fleet.segments.map((seg) => (
                  <tr key={seg.segment}>
                    <th scope="row">{seg.segment}</th>
                    <td className={styles.num}>{seg.customers}</td>
                    <td className={styles.num}>{fmt(seg.mean_score)}</td>
                    <td>
                      <StatusPill tone={bandInfo(seg.band).tone}>
                        {bandInfo(seg.band).label}
                      </StatusPill>
                    </td>
                    <td className={styles.num}>{seg.bands.simple}</td>
                    <td className={styles.num}>{seg.bands.medium}</td>
                    <td className={styles.num}>{seg.bands.complex}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className={styles.layout}>
        <Card flush aria-labelledby="fleet-customers-head">
          <CardHeader
            titleId="fleet-customers-head"
            title="Customers"
            description="Consent and the latest succeeded light scan of each customer."
          />
          {fleet.customers.length === 0 ? (
            <EmptyState compact title="No customers" />
          ) : (
            <div
              className={styles.tableWrap}
              // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label="Fleet customers"
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Partner</th>
                    <th scope="col">Segment</th>
                    <th scope="col">Consent</th>
                    <th scope="col">Latest scan</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.customers.map((c) => (
                    <FleetCustomerRow
                      key={c.customer_id}
                      row={c}
                      partner={partnerName(c.partner_id)}
                      current={c.customer_id === selected}
                      onOpen={() => open(c.customer_id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {row ? (
          <CustomerPanel
            key={row.customer_id}
            programme={programme}
            row={row}
            headingRef={headingRef}
            onClose={() => onSelect(null)}
          />
        ) : (
          <Card>
            <CardBody>
              <EmptyState
                compact
                icon={<Radar />}
                title={selected ? 'Customer not found' : 'Choose a customer'}
                body={
                  selected
                    ? 'This customer is not in the programme, or you cannot see it.'
                    : 'Open a customer to record consent, start a light scan and read its Complexity Index.'
                }
              />
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function FleetCustomerRow({
  row: c,
  partner,
  current,
  onOpen,
}: {
  row: FleetRow;
  partner: string | null;
  current: boolean;
  onOpen: () => void;
}) {
  const band = bandInfo(c.scan?.mci?.band);
  return (
    <tr aria-current={current ? 'true' : undefined}>
      <th scope="row">{c.customer}</th>
      <td>{partner ?? <span className={s.muted}>No partner</span>}</td>
      <td>{c.segment ?? <span className={s.muted}>None</span>}</td>
      <td>
        {c.consent ? (
          <StatusPill tone="success">Active</StatusPill>
        ) : (
          <StatusPill tone="neutral">None</StatusPill>
        )}
      </td>
      <td>
        {c.scan?.mci ? (
          <span className={s.row}>
            <StatusPill tone={band.tone}>{band.label}</StatusPill>
            <span className={styles.num}>{fmt(c.scan.mci.score)}</span>
          </span>
        ) : (
          <span className={s.muted}>Not scanned</span>
        )}
      </td>
      <td>
        <span className={s.rowActions}>
          <Button
            size="sm"
            variant={current ? 'secondary' : 'ghost'}
            aria-label={`Open ${c.customer}`}
            onClick={onOpen}
          >
            Open
          </Button>
        </span>
      </td>
    </tr>
  );
}

// ---------- One customer ----------

function CustomerPanel({
  programme,
  row,
  headingRef,
  onClose,
}: {
  programme: ProgrammeDetail;
  row: FleetRow;
  headingRef: RefObject<HTMLSpanElement | null>;
  onClose: () => void;
}) {
  const consents = useConsents(row.customer_id);
  const scans = useFleetScans(programme.id, row.customer_id);
  const [recording, setRecording] = useState(false);
  const [revoking, setRevoking] = useState<Consent | null>(null);
  const [scanning, setScanning] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const active = consents.data?.find((c) => c.active) ?? null;
  const canScan = programme.can_scan;
  const scanReason = !canScan
    ? 'You cannot start scans in this programme.'
    : consents.isPending
      ? 'Checking the consent…'
      : !active
        ? 'Record the customer’s consent before scanning.'
        : null;
  const list = scans.data ?? [];
  const running = list.find((x) => x.status === 'queued' || x.status === 'running') ?? null;
  const breakdown = list.find((x) => x.id === shown && x.mci) ?? list.find((x) => x.mci) ?? null;

  return (
    <Card aria-labelledby="fleet-customer-head">
      <CardHeader
        titleId="fleet-customer-head"
        title={
          <span ref={headingRef} tabIndex={-1}>
            {row.customer}
          </span>
        }
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      />
      <CardBody>
        <section aria-labelledby="fleet-consent-head" className={s.stackSm}>
          <h3 id="fleet-consent-head" className={s.cellPrimary}>
            Consent
          </h3>
          {consents.isPending ? (
            <Skeleton height="4rem" />
          ) : consents.isError ? (
            <ApiErrorView
              error={consents.error}
              title="Could not load the consents"
              onRetry={() => void consents.refetch()}
              compact
            />
          ) : (
            <>
              {active ? (
                <ConsentDetails consent={active} />
              ) : (
                <p className={`${s.small} ${s.muted}`}>
                  No active consent. Scans need the customer’s recorded consent.
                </p>
              )}
              {canScan ? (
                <span className={s.row}>
                  <Button
                    size="sm"
                    leadingIcon={<FileSignature aria-hidden="true" />}
                    onClick={() => setRecording(true)}
                  >
                    Record consent
                  </Button>
                  {active ? (
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(active)}>
                      Revoke consent
                    </Button>
                  ) : null}
                </span>
              ) : null}
              {consents.data.some((c) => !c.active) ? (
                <details>
                  <summary className={s.small}>Revoked consents</summary>
                  <ul className={styles.plainList}>
                    {consents.data
                      .filter((c) => !c.active)
                      .map((c) => (
                        <li key={c.id} className={s.small}>
                          {c.signatory_name} ({c.signatory_title}), revoked by{' '}
                          {c.revoked_by ?? 'unknown'}
                          {c.revoked_at ? (
                            <>
                              {' '}
                              <Timestamp value={c.revoked_at} />
                            </>
                          ) : null}
                          : {c.revoke_reason}
                        </li>
                      ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </section>
      </CardBody>
      <CardBody>
        <section aria-labelledby="fleet-scan-head" className={s.stackSm}>
          <h3 id="fleet-scan-head" className={s.cellPrimary}>
            Light scan
          </h3>
          <p className={`${s.small} ${s.muted}`}>
            Reads metadata and counts only (object inventory, data dictionary, configuration
            inventory, row and document counts, and how many known traps apply) through a checked
            read-only connection. It never reads business values and keeps only numbers.
          </p>
          <span className={s.row}>
            <Button
              size="sm"
              variant="primary"
              leadingIcon={<Radar aria-hidden="true" />}
              disabled={scanReason !== null || running !== null}
              aria-describedby={scanReason || running ? 'fleet-scan-why' : undefined}
              onClick={() => setScanning(true)}
            >
              Start light scan
            </Button>
          </span>
          {scanReason || running ? (
            <span id="fleet-scan-why" className={`${s.small} ${s.muted}`}>
              {scanReason ?? 'A scan is already in progress.'}
            </span>
          ) : null}
          <div role="status" aria-live="polite" className={s.small}>
            {running ? `Scan ${scanStatus(running.status).label.toLowerCase()}…` : null}
          </div>
          {scans.isPending ? (
            <Skeleton height="4rem" />
          ) : scans.isError ? (
            <ApiErrorView
              error={scans.error}
              title="Could not load the scans"
              onRetry={() => void scans.refetch()}
              compact
            />
          ) : list.length === 0 ? (
            <p className={`${s.small} ${s.muted}`}>No scans yet.</p>
          ) : (
            <ScanList scans={list} shown={breakdown?.id ?? null} onShow={setShown} />
          )}
        </section>
      </CardBody>
      {breakdown?.mci ? (
        <CardBody>
          <ScanBreakdown scan={breakdown} mci={breakdown.mci} />
        </CardBody>
      ) : null}
      {recording ? (
        <ConsentDialog
          programmeId={programme.id}
          customer={row}
          onClose={() => setRecording(false)}
        />
      ) : null}
      {revoking ? (
        <RevokeDialog
          programmeId={programme.id}
          customer={row}
          consent={revoking}
          onClose={() => setRevoking(null)}
        />
      ) : null}
      {scanning ? (
        <ScanDialog programmeId={programme.id} customer={row} onClose={() => setScanning(false)} />
      ) : null}
    </Card>
  );
}

function ConsentDetails({ consent: c }: { consent: Consent }) {
  return (
    <KeyValueList
      layout="stack"
      items={[
        {
          key: 'who',
          label: 'Signatory',
          value: `${c.signatory_name}, ${c.signatory_title}`,
        },
        { key: 'scope', label: 'What may be read', value: c.scope },
        { key: 'ref', label: 'Signed form', value: c.reference },
        {
          key: 'rec',
          label: 'Recorded',
          value: (
            <>
              {c.recorded_by ?? 'Unknown'}
              {c.recorded_at ? (
                <>
                  {' · '}
                  <Timestamp value={c.recorded_at} />
                </>
              ) : null}
            </>
          ),
        },
      ]}
    />
  );
}

function ScanList({
  scans,
  shown,
  onShow,
}: {
  scans: FleetScan[];
  shown: string | null;
  onShow: (id: string) => void;
}) {
  return (
    <ul className={styles.plainList} aria-label="Scans, newest first">
      {scans.slice(0, 10).map((sc) => {
        const st = scanStatus(sc.status);
        return (
          <li key={sc.id} className={s.row}>
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
            {sc.mci ? (
              <Badge tone={bandInfo(sc.mci.band).tone}>
                {bandInfo(sc.mci.band).label} {fmt(sc.mci.score)}
              </Badge>
            ) : null}
            <span className={`${s.xs} ${s.muted}`}>
              {sc.requested_by ?? 'Unknown'}
              {sc.created_at ? (
                <>
                  {' · '}
                  <Timestamp value={sc.created_at} />
                </>
              ) : null}
            </span>
            {sc.status_detail ? <span className={s.xs}>{sc.status_detail}</span> : null}
            {sc.mci && sc.id !== shown ? (
              <Button size="sm" variant="ghost" onClick={() => onShow(sc.id)}>
                Show breakdown
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const RAW_LABELS: Record<string, string> = {
  rows: 'Rows',
  documents: 'Documents',
};

function ScanBreakdown({ scan, mci }: { scan: FleetScan; mci: MciScore }) {
  const band = bandInfo(mci.band);
  const labels = Object.fromEntries(mci.measures.map((m) => [m.key, m.label]));
  return (
    <section aria-labelledby="fleet-breakdown-head" className={s.stackSm}>
      <h3 id="fleet-breakdown-head" className={s.cellPrimary}>
        Complexity Index breakdown
      </h3>
      <p className={s.row}>
        <span>
          Score <strong>{fmt(mci.score)}</strong>
        </span>
        <StatusPill tone={band.tone}>{band.label}</StatusPill>
        <span className={`${s.xs} ${s.muted}`}>
          Simple below {fmt(mci.bands.simple)}, medium below {fmt(mci.bands.medium)}
          {scan.finished_at ? (
            <>
              {' · scanned '}
              <Timestamp value={scan.finished_at} />
            </>
          ) : null}
        </span>
      </p>
      <p className={styles.formula}>Score = {mci.formula}</p>
      <div
        className={styles.tableWrap}
        // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label="Index breakdown"
      >
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className={styles.num}>
                Value
              </th>
              <th scope="col" className={styles.num}>
                Range
              </th>
              <th scope="col" className={styles.num}>
                Normalised
              </th>
              <th scope="col" className={styles.num}>
                Weight
              </th>
              <th scope="col" className={styles.num}>
                Contribution
              </th>
            </tr>
          </thead>
          <tbody>
            {mci.measures.map((m) => (
              <tr key={m.key}>
                <th scope="row">{m.label}</th>
                <td className={styles.num}>{fmt(m.value, 3)}</td>
                <td className={styles.num}>
                  {fmt(m.low, 3)}–{fmt(m.high, 3)}
                </td>
                <td className={styles.num}>{fmt(m.normalised, 4)}</td>
                <td className={styles.num}>{fmt(m.weight, 3)}</td>
                <td className={styles.num}>{fmt(m.contribution, 2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={5}>
                Score
              </th>
              <td className={styles.num}>{fmt(mci.score)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <details>
        <summary className={s.small}>Raw measures</summary>
        <table className={styles.table}>
          <caption className="sr-only">Raw measures the scan kept</caption>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col" className={styles.num}>
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(scan.measures).map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{labels[k] ?? RAW_LABELS[k] ?? k.replace(/_/g, ' ')}</th>
                <td className={styles.num}>{fmt(v, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

// ---------- Dialogs ----------

function ConsentDialog({
  programmeId,
  customer,
  onClose,
}: {
  programmeId: string;
  customer: FleetRow;
  onClose: () => void;
}) {
  const record = useRecordConsent(programmeId, customer.customer_id);
  const [v, setV] = useState<Record<ConsentField, string>>({
    signatory_name: '',
    signatory_title: '',
    scope: '',
    reference: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = consentErrors(v);
  const errors = mergeFieldErrors(clientErrors, record.error, submitted);
  const set = (k: ConsentField, value: string) => {
    setV((x) => ({ ...x, [k]: value }));
    if (record.error) record.reset();
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Record consent: ${customer.customer}`}
      description="Record the customer’s signed consent to a light scan. A consent is never edited; revoke it and record a new one instead."
      submitLabel="Record consent"
      pending={record.isPending}
      error={record.error}
      fields={['signatory_name', 'signatory_title', 'scope', 'reference']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        record.mutate(
          {
            signatory_name: v.signatory_name.trim(),
            signatory_title: v.signatory_title.trim(),
            scope: v.scope.trim(),
            reference: v.reference.trim(),
          },
          {
            onSuccess: () => {
              toast.success(`Consent recorded for ${customer.customer}`);
              onClose();
            },
          },
        );
      }}
    >
      <div className={s.grid2}>
        <Field label="Signatory name" error={errors.signatory_name} required>
          <Input
            value={v.signatory_name}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => set('signatory_name', e.target.value)}
          />
        </Field>
        <Field label="Signatory title" error={errors.signatory_title} required>
          <Input
            value={v.signatory_title}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => set('signatory_title', e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="What may be read"
        help={`At least ${String(CONSENT_SCOPE_MIN)} characters, as the signed form states it.`}
        error={errors.scope}
        required
      >
        <Textarea
          rows={4}
          value={v.scope}
          maxLength={4000}
          onChange={(e) => set('scope', e.target.value)}
        />
      </Field>
      <Field
        label="Where the signed form is kept"
        help="A document reference or link."
        error={errors.reference}
        required
      >
        <Input
          value={v.reference}
          maxLength={1000}
          autoComplete="off"
          onChange={(e) => set('reference', e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

function RevokeDialog({
  programmeId,
  customer,
  consent,
  onClose,
}: {
  programmeId: string;
  customer: FleetRow;
  consent: Consent;
  onClose: () => void;
}) {
  const revoke = useRevokeConsent(programmeId, customer.customer_id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientError = reasonError(reason);
  const errors = mergeFieldErrors<'reason'>(
    clientError ? { reason: clientError } : {},
    revoke.error,
    submitted,
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Revoke consent: ${customer.customer}`}
      description={`Revokes the consent signed by ${consent.signatory_name}. No new scan can start until a new consent is recorded. A revoked consent stays revoked.`}
      submitLabel="Revoke consent"
      tone="danger"
      size="sm"
      pending={revoke.isPending}
      error={revoke.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (clientError) return;
        revoke.mutate(
          { consentId: consent.id, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success(`Consent revoked for ${customer.customer}`);
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Reason" help="Recorded in the audit log." error={errors.reason} required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function ScanDialog({
  programmeId,
  customer,
  onClose,
}: {
  programmeId: string;
  customer: FleetRow;
  onClose: () => void;
}) {
  const connections = useSourceConnections(customer.customer_id);
  const start = useStartScan(programmeId, customer.customer_id);
  const [connection, setConnection] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const errors = mergeFieldErrors<'connection_id'>(
    connection ? {} : { connection_id: 'Choose a source connection.' },
    start.error,
    submitted,
  );
  const list = connections.data ?? [];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Start light scan: ${customer.customer}`}
      description="The scan reads metadata and counts only, through a read-only connection whose check succeeded. It never reads business values; only numbers are kept."
      submitLabel="Start light scan"
      pending={start.isPending}
      error={start.error}
      fields={['connection_id']}
      onSubmit={() => {
        setSubmitted(true);
        if (!connection) return;
        start.mutate(connection, {
          onSuccess: () => {
            toast.success(`Light scan of ${customer.customer} queued`);
            onClose();
          },
        });
      }}
    >
      {connections.isPending ? (
        <Skeleton height="3rem" />
      ) : connections.isError ? (
        <ApiErrorView
          error={connections.error}
          title="Could not load the customer’s source connections"
          onRetry={() => void connections.refetch()}
          compact
        />
      ) : list.length === 0 ? (
        <Callout tone="warning" title="No source connections">
          This customer has no source connection yet.{' '}
          <Link
            to="/tenants/$tenantId"
            params={{ tenantId: customer.customer_id }}
            search={{ tab: 'sources' }}
          >
            Add one on the customer’s Sources tab
          </Link>{' '}
          and check it first.
        </Callout>
      ) : (
        <Field
          label="Source connection"
          help="Only a connection whose check proved the account read-only can be scanned."
          error={errors.connection_id}
          required
        >
          <Select
            options={list.map((c) => ({
              value: c.id,
              label: `${c.name} (${c.adapter}, ${c.engine})${c.last_check?.status === 'succeeded' ? '' : ' · not checked'}`,
            }))}
            value={connection || undefined}
            onValueChange={setConnection}
            placeholder="Choose a connection…"
          />
        </Field>
      )}
    </FormDialog>
  );
}
