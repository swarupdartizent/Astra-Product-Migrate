import { Link } from '@tanstack/react-router';
import { Circle, CircleCheck, ExternalLink, FileSignature, ShieldCheck } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { useApproveGate, useAttestGate, useGates } from '@/api/gates';
import type { Gate, GateItem, GateList, GateSource } from '@/api/gates-types';
import { useMe } from '@/api/queries';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Gates.module.css';
import {
  approveState,
  attestErrors,
  gateStatus,
  isHttpUrl,
  itemsByKind,
  KIND_INFO,
  metCount,
  NOTE_MAX,
  REFERENCE_MAX,
  shortDigest,
  sourceTarget,
} from './model';

/**
 * Gates (E17.F1.S1): the eight lifecycle gates with their checklists. Evidence items come from
 * the platform's records; control and attestation items are attested by a person; each required
 * role approves the checklist as it is now (its digest).
 */
export function GatesView({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const q = useGates(project.id);
  const headingRef = useRef<HTMLHeadingElement>(null);
  if (q.isPending) return <Skeleton height="20rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the gates"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const data = q.data;
  const gate = data.gates.find((g) => g.key === selected) ?? null;
  const select = (key: string) => {
    onSelect(key);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  return (
    <div className={styles.layout}>
      <Card flush aria-labelledby="gates-list-head">
        <CardHeader
          titleId="gates-list-head"
          title="Gates"
          description="A gate passes when every checklist item is met and each required role approves, each by a different person."
        />
        {data.gates.length === 0 ? (
          <EmptyState compact title="No gates" body="The platform returned no gates." />
        ) : (
          <ul className={styles.list} aria-label="Gates" aria-busy={q.isFetching}>
            {data.gates.map((g) => (
              <GateRow
                key={g.key}
                gate={g}
                current={g.key === selected}
                onSelect={() => select(g.key)}
              />
            ))}
          </ul>
        )}
      </Card>
      <GatePanel project={project} data={data} gate={gate} headingRef={headingRef} />
    </div>
  );
}

function ApprovalProgress({ gate }: { gate: Gate }) {
  const done = new Set(gate.approvals.map((a) => a.role));
  return (
    <span className={s.badges}>
      {gate.approvers.map((a) => (
        <Badge key={a.role} tone={done.has(a.role) ? 'success' : 'neutral'}>
          {a.label}: {done.has(a.role) ? 'approved' : 'pending'}
        </Badge>
      ))}
    </span>
  );
}

function GateRow({
  gate: g,
  current,
  onSelect,
}: {
  gate: Gate;
  current: boolean;
  onSelect: () => void;
}) {
  const st = gateStatus(g.status);
  const { met, total } = metCount(g);
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        aria-current={current ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className={styles.rowTitle}>
          {g.label !== g.title ? `${g.label} · ${g.title}` : g.title}
        </span>
        <span className={s.badges}>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
        </span>
        <span className={styles.rowMeta}>
          <span>
            {met} of {total} met
          </span>
          <span>
            {g.approvals.length} of {g.approvers.length} approvals
          </span>
        </span>
        <ApprovalProgress gate={g} />
      </button>
    </li>
  );
}

function GatePanel({
  project,
  data,
  gate,
  headingRef,
}: {
  project: Project;
  data: GateList;
  gate: Gate | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const st = gate ? gateStatus(gate.status) : null;
  return (
    <Card aria-labelledby="gate-detail-head">
      <CardHeader
        titleId="gate-detail-head"
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {gate ? `${gate.label}: ${gate.title}` : 'Gate checklist'}
          </span>
        }
        description={
          gate && st ? (
            <span className={s.badges}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {gate === null ? (
          <EmptyState
            compact
            title="Select a gate"
            body="Choose a gate to see its checklist, attest controls and approve it."
          />
        ) : (
          <GateBody key={gate.key} project={project} data={data} gate={gate} />
        )}
      </CardBody>
    </Card>
  );
}

function GateBody({ project, data, gate }: { project: Project; data: GateList; gate: Gate }) {
  const [attesting, setAttesting] = useState<GateItem | null>(null);
  const { met, total } = metCount(gate);
  return (
    <>
      {gate.status === 'changed_since_pass' ? (
        <Callout tone="warning" title="The checklist changed since this gate passed">
          This gate passed
          {gate.passed_at ? (
            <>
              {' '}
              <Timestamp value={gate.passed_at} />
            </>
          ) : null}
          , but its checklist has changed since: evidence, an attestation or a record it links to is
          different. Approvals given for the earlier checklist do not count for this one, so every
          required role approves again.
        </Callout>
      ) : gate.status === 'passed' ? (
        <Callout tone="success" title="Passed">
          Every required role approved this checklist
          {gate.passed_at ? (
            <>
              {' '}
              (<Timestamp value={gate.passed_at} />)
            </>
          ) : null}
          .
        </Callout>
      ) : null}
      <KeyValueList
        items={[
          { key: 'met', label: 'Checklist', value: `${String(met)} of ${String(total)} items met` },
          {
            key: 'digest',
            label: 'Checklist version',
            value: (
              <span className={styles.digest}>
                <Mono title={gate.digest}>{shortDigest(gate.digest)}</Mono>
                <CopyButton value={gate.digest} label="Copy the checklist digest" />
              </span>
            ),
          },
        ]}
      />
      <p className={`${s.muted} ${s.small}`}>
        Approvals bind to this checklist version (sha256 of every item, whether it is met and the
        record or attestation behind it). If any of that changes, approvals given before do not
        count.
      </p>
      {!data.can_attest && gate.items.some((i) => i.kind !== 'evidence') ? (
        <p className={`${s.muted} ${s.small}`}>
          Attesting controls and conditions needs stage management or review resolution on this
          project.
        </p>
      ) : null}
      {itemsByKind(gate.items).map((group) => (
        <section key={group.kind} className={styles.section} aria-labelledby={`kind-${group.kind}`}>
          <h3 id={`kind-${group.kind}`} className={styles.sectionTitle}>
            {KIND_INFO[group.kind].label} ({group.items.filter((i) => i.met).length} of{' '}
            {group.items.length} met)
          </h3>
          <p className={`${s.muted} ${s.small}`}>{KIND_INFO[group.kind].about}</p>
          <ul className={styles.items}>
            {group.items.map((it) => (
              <ChecklistItem
                key={it.key}
                project={project}
                item={it}
                canAttest={data.can_attest}
                onAttest={() => setAttesting(it)}
              />
            ))}
          </ul>
        </section>
      ))}
      <Approvals project={project} data={data} gate={gate} />
      {attesting ? (
        <AttestDialog
          project={project}
          gate={gate}
          item={attesting}
          onClose={() => setAttesting(null)}
        />
      ) : null}
    </>
  );
}

function ChecklistItem({
  project,
  item: it,
  canAttest,
  onAttest,
}: {
  project: Project;
  item: GateItem;
  canAttest: boolean;
  onAttest: () => void;
}) {
  const Icon = it.met ? CircleCheck : Circle;
  return (
    <li className={styles.item} data-met={it.met}>
      <Icon className={styles.itemIcon} aria-hidden="true" />
      <div className={styles.itemBody}>
        <span className={styles.itemTitle}>
          {it.title} <span className="sr-only">{it.met ? '(met)' : '(not met)'}</span>
        </span>
        <span className={s.badges}>
          <Badge tone={it.met ? 'success' : 'neutral'}>{it.met ? 'Met' : 'Not met'}</Badge>
          {it.control?.compliance_critical ? (
            <Badge tone="danger">Compliance critical</Badge>
          ) : null}
        </span>
        <span className={s.muted}>{it.detail}</span>
        {it.control ? (
          <dl className={styles.control}>
            <dt>Rule</dt>
            <dd>{it.control.rule}</dd>
            <dt>Evidence required</dt>
            <dd>{it.control.evidence_required}</dd>
            <dt>Pack</dt>
            <dd>
              <Mono>{it.control.pack}</Mono>
            </dd>
            {it.control.sources.length > 0 ? (
              <>
                <dt>Sources</dt>
                <dd>{it.control.sources.join('; ')}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {it.evidence ? (
          <span className={s.small}>
            Attested by {it.evidence.by ?? 'a person'}
            {it.evidence.at ? (
              <>
                {' '}
                <Timestamp value={it.evidence.at} />
              </>
            ) : null}
            {it.evidence.reference ? (
              <>
                {'. Reference: '}
                <Reference value={it.evidence.reference} />
              </>
            ) : null}
          </span>
        ) : null}
        {it.kind === 'evidence' && it.source ? (
          <SourceLink project={project} source={it.source} />
        ) : null}
        {it.kind !== 'evidence' && canAttest ? (
          <span>
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<FileSignature aria-hidden="true" />}
              onClick={onAttest}
              aria-label={`${it.evidence ? 'Update the attestation for' : 'Attest'} ${it.title}`}
            >
              {it.evidence ? 'Update attestation' : 'Attest'}
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function Reference({ value }: { value: string }) {
  return isHttpUrl(value) ? (
    <a href={value} target="_blank" rel="noopener noreferrer">
      {value} <ExternalLink aria-hidden="true" size={12} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <Mono>{value}</Mono>
  );
}

/** Opens the record behind an evidence item on its screen, or shows its API path. */
export function SourceLink({ project, source }: { project: Project; source: GateSource }) {
  const t = sourceTarget(source.href);
  const label = `Open the record (${source.type.replace(/_/g, ' ')})`;
  if (t === null) {
    return source.href ? (
      <span className={s.small}>
        Record: <Mono>{source.href}</Mono>{' '}
        <span className={`${s.muted} ${s.xs}`}>(no screen shows this record yet)</span>
      </span>
    ) : null;
  }
  return t.to === 'discovery-run' ? (
    <Link to="/discovery-runs/$runId" params={{ runId: t.runId }} className={s.small}>
      {label} <ExternalLink aria-hidden="true" size={12} />
    </Link>
  ) : (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      search={t.search}
      className={s.small}
    >
      {label} <ExternalLink aria-hidden="true" size={12} />
    </Link>
  );
}

function Approvals({ project, data, gate }: { project: Project; data: GateList; gate: Gate }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const st = approveState(gate, data.my_roles, me.data?.id ?? null);
  const done = new Set(gate.approvals.map((a) => a.role));
  const whyId = `approve-why-${gate.key}`;
  return (
    <section className={styles.section} aria-labelledby={`approvals-${gate.key}`}>
      <h3 id={`approvals-${gate.key}`} className={styles.sectionTitle}>
        Approvals ({gate.approvals.length} of {gate.approvers.length})
      </h3>
      <ul className={styles.bullets}>
        {gate.approvers.map((r) => {
          const a = gate.approvals.find((x) => x.role === r.role);
          return (
            <li key={r.role}>
              <strong>{r.label}</strong>:{' '}
              {a ? (
                <>
                  approved by {a.user ?? 'a person'}
                  {a.at ? (
                    <>
                      {' '}
                      <Timestamp value={a.at} />
                    </>
                  ) : null}
                  {a.note ? <> — “{a.note}”</> : null}
                </>
              ) : done.has(r.role) ? (
                'approved'
              ) : (
                'not yet approved for this checklist version'
              )}
            </li>
          );
        })}
      </ul>
      <div className={s.row}>
        <Button
          variant="primary"
          leadingIcon={<ShieldCheck aria-hidden="true" />}
          disabled={st.reason !== null}
          aria-describedby={st.reason ? whyId : undefined}
          onClick={() => setOpen(true)}
        >
          Approve {gate.label}
        </Button>
      </div>
      {st.reason ? (
        <div id={whyId} className={`${s.small} ${s.muted}`}>
          <p>{st.reason}</p>
          {st.unmet.length > 0 ? (
            <ul className={styles.bullets} aria-label="Items not met">
              {st.unmet.map((i) => (
                <li key={i.key}>{i.title}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {open && st.roles.length > 0 ? (
        <ApproveDialog
          project={project}
          gate={gate}
          roles={st.roles}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}

function ApproveDialog({
  project,
  gate,
  roles,
  onClose,
}: {
  project: Project;
  gate: Gate;
  roles: { role: string; label: string }[];
  onClose: () => void;
}) {
  const approve = useApproveGate(project.id, gate.key);
  const [role, setRole] = useState(roles[0]?.role ?? '');
  const [note, setNote] = useState('');
  const errors = mergeFieldErrors<'role' | 'note'>({}, approve.error, true);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Approve ${gate.label}: ${gate.title}`}
      description={`You approve the checklist as it is now (version ${shortDigest(gate.digest)}). If it changes, this approval no longer counts.`}
      submitLabel="Approve"
      pending={approve.isPending}
      error={approve.error}
      fields={['role', 'note']}
      onSubmit={() =>
        approve.mutate(
          { role, note: note.trim() },
          {
            onSuccess: (g) => {
              toast.success(
                g.status === 'passed'
                  ? `${g.label} passed`
                  : `Approved ${g.label} as ${roleLabel(roles, role)}`,
              );
              onClose();
            },
          },
        )
      }
    >
      <Field label="Approve as" required error={errors.role}>
        <Select
          options={roles.map((r) => ({ value: r.role, label: r.label }))}
          value={role}
          onValueChange={setRole}
        />
      </Field>
      <Field
        label="Note"
        help="Optional. Recorded with the approval and in the audit log."
        error={errors.note}
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

function roleLabel(roles: { role: string; label: string }[], role: string): string {
  return roles.find((r) => r.role === role)?.label ?? role;
}

function AttestDialog({
  project,
  gate,
  item,
  onClose,
}: {
  project: Project;
  gate: Gate;
  item: GateItem;
  onClose: () => void;
}) {
  const attest = useAttestGate(project.id, gate.key);
  const [note, setNote] = useState(item.evidence?.note ?? '');
  const [reference, setReference] = useState(item.evidence?.reference ?? '');
  const [submitted, setSubmitted] = useState(false);
  const client = attestErrors(note, reference);
  const errors = mergeFieldErrors(client, attest.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={item.kind === 'control' ? 'Attest a control' : 'Attest a condition'}
      description={item.title}
      submitLabel="Record attestation"
      size="lg"
      pending={attest.isPending}
      error={attest.error}
      fields={['note', 'reference', 'item_key']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(client)) return;
        attest.mutate(
          { item_key: item.key, note: note.trim(), reference: reference.trim() || null },
          {
            onSuccess: () => {
              toast.success('Attestation recorded');
              onClose();
            },
          },
        );
      }}
    >
      {item.control ? (
        <p className={s.small}>
          <strong>Evidence required:</strong> {item.control.evidence_required}
        </p>
      ) : null}
      <Field
        label="Evidence"
        required
        help="What shows the condition is met (at least 10 characters). Recorded with your name."
        error={errors.note}
      >
        <Textarea
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
        />
      </Field>
      <Field
        label="Reference"
        help="Optional. A document link, ticket or record ID where the evidence is."
        error={errors.reference}
      >
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          maxLength={REFERENCE_MAX}
        />
      </Field>
      <p className={`${s.muted} ${s.xs}`}>
        Attesting changes the checklist, so approvals already given for {gate.label} no longer
        count.
      </p>
    </FormDialog>
  );
}
