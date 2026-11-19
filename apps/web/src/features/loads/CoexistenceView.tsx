import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useSourceConnections } from '@/api/adapters';
import { loadKeys, useCoexistence, useReconcileNow, useSetCoexistenceSchedule } from '@/api/loads';
import type { CoexistenceDashboard } from '@/api/loads-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { JobProgress } from '@/app/JobProgress';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  Switch,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { BreakItem } from './BreaksView';
import styles from './Loads.module.css';
import { isUuid } from './model';
import { PersonField, Why } from './Parts';

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, '0')}:00 UTC`,
}));

/**
 * Coexistence (E15.F1.S2): while both systems run, a daily reconciliation compares each shared
 * entity's live source count and amounts with what the target accepted; breaks go to a named
 * owner.
 */
export function CoexistenceView({ project }: { project: Project }) {
  const q = useCoexistence(project.id);
  if (q.isPending) return <Skeleton height="20rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the coexistence dashboard"
        onRetry={() => void q.refetch()}
      />
    );
  }
  return <Dashboard project={project} data={q.data} />;
}

function Dashboard({ project, data: d }: { project: Project; data: CoexistenceDashboard }) {
  const qc = useQueryClient();
  const reconcile = useReconcileNow(project.id);
  const [jobId, setJobId] = useState<string | null>(null);
  const why = !d.can_manage
    ? 'Reconciling needs stage management on this project.'
    : !d.schedule
      ? 'Set the schedule first: it names the owner of the breaks.'
      : null;
  return (
    <div className={s.stack}>
      <Card aria-labelledby="coex-head">
        <CardHeader
          titleId="coex-head"
          title="Coexistence reconciliation"
          description="For each shared entity in the plan’s coexistence rules, the source’s live record count and measured amounts (read only) are compared with what the target accepted in loads so far."
          actions={
            <Button
              variant="primary"
              leadingIcon={<RefreshCw aria-hidden="true" />}
              disabled={!!why}
              loading={reconcile.isPending}
              aria-describedby={why ? 'coex-why' : undefined}
              onClick={() =>
                reconcile.mutate(undefined, {
                  onSuccess: (r) => {
                    setJobId(r.job_id);
                    toast.info('Reconciliation started');
                  },
                })
              }
            >
              Reconcile now
            </Button>
          }
        />
        <CardBody className={s.stackSm}>
          {why ? <Why id="coex-why">{why}</Why> : null}
          <FormError error={reconcile.error} />
          {jobId ? (
            <JobProgress
              jobId={jobId}
              title="Coexistence reconciliation"
              onFinished={() =>
                void qc.invalidateQueries({ queryKey: loadKeys.project(project.id) })
              }
            />
          ) : null}
        </CardBody>
      </Card>
      <div className={s.grid2}>
        <ScheduleCard key={JSON.stringify(d.schedule)} project={project} data={d} />
        <Card aria-labelledby="coex-rules">
          <CardHeader
            titleId="coex-rules"
            title={`Coexistence rules (${String(d.rules.length)})`}
          />
          <CardBody>
            {d.rules.length === 0 ? (
              <EmptyState
                compact
                title="No coexistence rules"
                body="Add rules for shared entities on the Plan tab’s cutover section."
              />
            ) : (
              <div
                className={styles.tableWrap}
                // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                role="region"
                aria-label="Coexistence rules"
              >
                <table className={styles.table}>
                  <caption className="sr-only">Shared entities and their coexistence rules</caption>
                  <thead>
                    <tr>
                      <th scope="col">Entity</th>
                      <th scope="col">Wave</th>
                      <th scope="col">System of record</th>
                      <th scope="col">Until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rules.map((r) => (
                      <tr key={r.key}>
                        <th scope="row">{r.entity ?? r.key}</th>
                        <td>{r.wave ?? '—'}</td>
                        <td>{r.system_of_record ?? '—'}</td>
                        <td>{r.end_date ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
      <Card flush aria-labelledby="coex-breaks">
        <CardHeader titleId="coex-breaks" title={`Open breaks (${String(d.open_breaks.length)})`} />
        {d.open_breaks.length === 0 ? (
          <EmptyState
            compact
            title="No open breaks"
            body="The live source and the target agree on every reconciled entity."
          />
        ) : (
          <ul className={styles.plainList} aria-label="Open coexistence breaks">
            {d.open_breaks.map((b) => (
              <BreakItem
                key={b.id}
                project={project}
                item={b}
                runNumber={null}
                canResolve={d.can_close}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

type SchedField = 'connection_id' | 'owner_user_id' | 'hour_utc';

function ScheduleCard({ project, data: d }: { project: Project; data: CoexistenceDashboard }) {
  const sch = d.schedule;
  const conns = useSourceConnections(project.tenant_id);
  const save = useSetCoexistenceSchedule(project.id);
  const [conn, setConn] = useState(sch?.connection_id ?? '');
  const [owner, setOwner] = useState(sch?.owner_user_id ?? '');
  const [hour, setHour] = useState(sch ? String(sch.hour_utc) : '2');
  const [enabled, setEnabled] = useState(sch?.enabled ?? true);
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<SchedField> = {};
  if (!conn) client.connection_id = 'Choose the source connection to read live counts from.';
  if (!owner) client.owner_user_id = 'Breaks go to a named person: choose one.';
  else if (!isUuid(owner)) client.owner_user_id = 'Enter a valid user ID.';
  const errors = mergeFieldErrors(client, save.error, submitted);
  const ro = !d.can_manage;
  return (
    <Card aria-labelledby="coex-schedule">
      <CardHeader titleId="coex-schedule" title="Daily schedule" />
      <CardBody className={s.stackSm}>
        {sch ? (
          <KeyValueList
            items={[
              {
                key: 'o',
                label: 'Owner of breaks',
                value: sch.owner ?? <Mono className={s.xs}>{sch.owner_user_id}</Mono>,
              },
              {
                key: 'h',
                label: 'Runs at',
                value: `${String(sch.hour_utc).padStart(2, '0')}:00 UTC ${sch.enabled ? '' : '(paused)'}`,
              },
              {
                key: 'l',
                label: 'Last run',
                value: sch.last_run_at ? <Timestamp value={sch.last_run_at} /> : 'Never',
              },
              {
                key: 'n',
                label: 'Next run',
                value:
                  sch.enabled && sch.next_run_at ? (
                    <Timestamp value={sch.next_run_at} />
                  ) : (
                    'Not scheduled'
                  ),
              },
            ]}
          />
        ) : (
          <p className={`${s.muted} ${s.small}`}>No schedule: the daily reconciliation is off.</p>
        )}
        {ro ? (
          <Why id="sched-why">Changing the schedule needs stage management on this project.</Why>
        ) : null}
        <form
          className={s.stackSm}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (hasErrors(client)) return;
            save.mutate(
              { connection_id: conn, owner_user_id: owner, hour_utc: Number(hour), enabled },
              { onSuccess: () => toast.success('Schedule saved') },
            );
          }}
        >
          <Field label="Source connection" required error={errors.connection_id} disabled={ro}>
            <Select
              options={(conns.data ?? []).map((c) => ({
                value: c.id,
                label: `${c.name} (${c.adapter})`,
              }))}
              value={conn}
              onValueChange={setConn}
              disabled={ro}
              placeholder={conns.isPending ? 'Loading…' : 'Choose a source connection'}
            />
          </Field>
          <PersonField
            label="Owner of breaks"
            value={owner}
            currentName={sch?.owner ?? null}
            onChange={setOwner}
            error={errors.owner_user_id}
            disabled={ro}
          />
          <Field label="Hour (UTC)" error={errors.hour_utc} disabled={ro}>
            <Select options={HOURS} value={hour} onValueChange={setHour} disabled={ro} />
          </Field>
          <Field label="Run daily" inline disabled={ro}>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={ro} />
          </Field>
          <div className={s.row}>
            <Button
              type="submit"
              leadingIcon={<CalendarClock aria-hidden="true" />}
              disabled={ro}
              loading={save.isPending}
            >
              Save schedule
            </Button>
          </div>
          <FormError error={save.error} fields={['connection_id', 'owner_user_id', 'hour_utc']} />
        </form>
      </CardBody>
    </Card>
  );
}
