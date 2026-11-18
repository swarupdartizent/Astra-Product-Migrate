import { Link } from '@tanstack/react-router';
import { Check, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useDecideReport, useWaiveGap } from '@/api/discovery';
import type { CoverageReport, DiscoveryGap } from '@/api/discovery-types';
import { isApiError } from '@/api/errors';
import { FormDialog } from '@/app/FormDialog';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Mono,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import {
  countText,
  DECISION_MIN,
  gapState,
  humanize,
  lengthError,
  orderGaps,
  reportStatus,
  streamStatus,
  WAIVER_MIN,
} from './model';
import styles from './Discovery.module.css';

/** One coverage report: the nine streams, its gaps, waivers and the decision. */
export function CoverageReportView({ report }: { report: CoverageReport }) {
  const [waiving, setWaiving] = useState<DiscoveryGap | null>(null);
  const [deciding, setDeciding] = useState<boolean | null>(null);
  const st = reportStatus(report.status);
  const gapById = new Map(report.gaps.map((g) => [g.id, g]));
  const draft = report.status === 'draft';

  return (
    <Card aria-labelledby={`report-${report.id}`}>
      <CardHeader
        titleId={`report-${report.id}`}
        title={`Coverage report: ${String(report.coverage_pct)}% of streams covered`}
        description={
          <>
            Built <Timestamp value={report.created_at} /> from{' '}
            <Link to="/discovery-runs/$runId" params={{ runId: report.discovery_run_id }}>
              this discovery run
            </Link>
            .
          </>
        }
        actions={<StatusPill tone={st.tone}>{st.label}</StatusPill>}
      />
      <CardBody className={s.stack}>
        {draft ? (
          <Callout tone="info" title="What this report decides">
            The discovery stage can be marked done only when a coverage report is accepted.
            Accepting needs every blocking gap closed by a new run or waived with a written reason.
          </Callout>
        ) : null}

        <section aria-labelledby={`streams-${report.id}`}>
          <h3 id={`streams-${report.id}`} className={styles.sectionTitle}>
            Streams
          </h3>
          <ul className={styles.streamGrid}>
            {report.streams.map((stream) => {
              const ss = streamStatus(stream.status);
              const counts = Object.entries(stream.counts).filter(([, v]) => v !== null);
              return (
                <li key={stream.stream} className={styles.streamCell} data-status={stream.status}>
                  <span className={styles.streamHead}>
                    <strong>{stream.title}</strong>
                    <StatusPill tone={ss.tone}>{ss.label}</StatusPill>
                  </span>
                  {counts.length > 0 ? (
                    <span className={`${s.muted} ${s.xs}`}>
                      {counts.map(([k, v]) => `${humanize(k)}: ${countText(v)}`).join(' · ')}
                    </span>
                  ) : null}
                  {stream.gaps.length > 0 ? (
                    <span className={s.xs}>
                      {stream.gaps.length} gap{stream.gaps.length === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        {report.blocking_open.length > 0 ? (
          <Callout
            tone="warning"
            title={`${String(report.blocking_open.length)} blocking gap(s) open`}
          >
            <ul className={styles.plainList}>
              {report.blocking_open.map((id) => (
                <li key={id}>
                  <Mono className={s.xs}>{id}</Mono> {gapById.get(id)?.message ?? ''}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}

        <section aria-labelledby={`gaps-${report.id}`}>
          <h3 id={`gaps-${report.id}`} className={styles.sectionTitle}>
            Gaps ({report.gaps.length})
          </h3>
          {report.gaps.length === 0 ? (
            <p className={s.muted}>No gaps.</p>
          ) : (
            <ul className={styles.gapList}>
              {orderGaps(report, report.gaps).map((g) => {
                const state = gapState(report, g);
                const waiver = report.waivers.find((w) => w.gap_id === g.id);
                return (
                  <li key={g.id} className={styles.gap} data-state={state}>
                    <span className={s.row}>
                      <Badge tone={g.severity === 'blocking' ? 'danger' : 'warning'}>
                        {g.severity === 'blocking' ? 'Blocking' : 'Warning'}
                      </Badge>
                      {waiver ? <Badge tone="success">Waived</Badge> : null}
                      <Mono className={s.xs}>{g.id}</Mono>
                    </span>
                    <span>{g.message}</span>
                    {waiver ? (
                      <span className={`${s.muted} ${s.small}`}>
                        Waived by {waiver.by}, <Timestamp value={waiver.at} />: “{waiver.reason}”
                      </span>
                    ) : null}
                    {!waiver && draft && report.can_decide ? (
                      <span>
                        <Button size="sm" onClick={() => setWaiving(g)}>
                          Waive gap
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {report.decided_at ? (
          <Callout
            tone={report.status === 'accepted' ? 'success' : 'info'}
            title={report.status === 'accepted' ? 'Accepted' : `Decision: ${st.label}`}
          >
            {report.decided_by ?? 'Someone'} decided <Timestamp value={report.decided_at} />
            {report.decision_note ? `: “${report.decision_note}”` : '.'}
          </Callout>
        ) : null}
      </CardBody>
      {draft && report.can_decide ? (
        <CardFooter>
          <Button leadingIcon={<X aria-hidden="true" />} onClick={() => setDeciding(false)}>
            Reject report
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Check aria-hidden="true" />}
            onClick={() => setDeciding(true)}
          >
            Accept report
          </Button>
        </CardFooter>
      ) : null}
      {waiving ? (
        <WaiveDialog report={report} gap={waiving} onClose={() => setWaiving(null)} />
      ) : null}
      {deciding !== null ? (
        <DecideDialog report={report} accept={deciding} onClose={() => setDeciding(null)} />
      ) : null}
    </Card>
  );
}

function WaiveDialog({
  report,
  gap,
  onClose,
}: {
  report: CoverageReport;
  gap: DiscoveryGap;
  onClose: () => void;
}) {
  const waive = useWaiveGap(report.project_id, report.id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client = lengthError(reason, WAIVER_MIN, 'Say why this gap is acceptable');
  const server = isApiError(waive.error) ? waive.error.fieldErrors.reason : undefined;
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Waive gap ${gap.id}`}
      description={gap.message}
      submitLabel="Waive gap"
      pending={waive.isPending}
      error={waive.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (client) return;
        waive.mutate(
          { gap_id: gap.id, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success(`Gap ${gap.id} waived`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help={`At least ${String(WAIVER_MIN)} characters. Recorded with your name in the report and the audit log.`}
        error={(submitted ? client : undefined) ?? server}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

function DecideDialog({
  report,
  accept,
  onClose,
}: {
  report: CoverageReport;
  accept: boolean;
  onClose: () => void;
}) {
  const decide = useDecideReport(report.project_id, report.id);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client = lengthError(note, DECISION_MIN, 'Add a note');
  const err = decide.error;
  const gapsOpen =
    isApiError(err) && err.status === 409
      ? err.fieldErrorList.filter((e) => e.field === 'gaps').map((e) => e.message)
      : [];
  const gapById = new Map(report.gaps.map((g) => [g.id, g]));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={accept ? 'Accept the coverage report' : 'Reject the coverage report'}
      description={
        accept
          ? 'Accepting opens the discovery stage gate for this project. Every blocking gap must be waived first.'
          : 'Rejecting keeps the discovery stage open; run discovery again after closing the gaps.'
      }
      submitLabel={accept ? 'Accept report' : 'Reject report'}
      tone={accept ? 'default' : 'danger'}
      pending={decide.isPending}
      error={gapsOpen.length > 0 ? null : err}
      fields={['note']}
      onSubmit={() => {
        setSubmitted(true);
        if (client) return;
        decide.mutate(
          { accept, note: note.trim() },
          {
            onSuccess: () => {
              toast.success(accept ? 'Coverage report accepted' : 'Coverage report rejected');
              onClose();
            },
          },
        );
      }}
    >
      {gapsOpen.length > 0 && isApiError(err) ? (
        <Callout tone="danger" title={err.title} live>
          {err.detail}
          <ul className={styles.plainList}>
            {gapsOpen.map((id) => (
              <li key={id}>
                <Mono className={s.xs}>{id}</Mono> {gapById.get(id)?.message ?? ''}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Field
        label="Note"
        help={`At least ${String(DECISION_MIN)} characters. Recorded in the audit log.`}
        error={
          (submitted ? client : undefined) ?? (isApiError(err) ? err.fieldErrors.note : undefined)
        }
        required
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
        />
      </Field>
      {accept ? (
        <p className={`${s.muted} ${s.small}`}>
          <ShieldCheck aria-hidden="true" className={styles.inlineIcon} /> {report.waivers.length}{' '}
          waiver(s) recorded, {report.blocking_open.length} blocking gap(s) open.
        </p>
      ) : null}
    </FormDialog>
  );
}
