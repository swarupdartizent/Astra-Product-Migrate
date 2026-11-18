import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useState, type RefObject } from 'react';
import type {
  ReviewDecideOut,
  Project,
  ReviewEvidence,
  ReviewItem,
  ReviewPrecedents,
  ReviewSamples,
  ReviewWorkbench,
} from '@/api/types';
import { useAssignReviewer, useReviewWorkbench } from '@/api/runtime';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  KeyValueList,
  Mono,
  PlainText,
  Select,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import { actorLabel, reviewStatus } from '../runtime/model';
import s from '../shared.module.css';
import { DecisionPanel } from './DecisionPanel';
import {
  complianceInfo,
  EVIDENCE_KIND_LABELS,
  evidenceTarget,
  formatConfidence,
  humanizeKey,
  outcomeLabel,
  outcomeTone,
  recordedMessage,
  riskInfo,
} from './model';
import styles from './Review.module.css';
import { ReviewAssistant } from './ReviewAssistant';

const NOBODY = '__nobody__';

/** The selected item's evidence panel (E16.F1.S2, E21.F1.S1) with decisions and the assistant. */
export function ReviewDetail({
  project,
  itemId,
  headingRef,
  onPattern,
}: {
  project: Project;
  itemId: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onPattern: (patternKey: string) => void;
}) {
  const wb = useReviewWorkbench(itemId);
  // The last decision recorded in this panel, shown until another item is selected.
  const [result, setResult] = useState<ReviewDecideOut | null>(null);
  const r = wb.data?.item;
  return (
    <Card aria-labelledby="review-detail-head">
      <CardHeader
        titleId="review-detail-head"
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {itemId === null ? 'Evidence and decision' : (r?.title ?? 'Loading the item…')}
          </span>
        }
        description={
          r ? (
            <span className={s.badges}>
              <StatusPill tone={reviewStatus(r.status).tone}>
                {reviewStatus(r.status).label}
              </StatusPill>
              <Badge tone={riskInfo(r.risk).tone}>{riskInfo(r.risk).label}</Badge>
              <Badge tone={complianceInfo(r.compliance).tone}>
                {complianceInfo(r.compliance).label}
                {r.compliance_controls.length ? `: ${r.compliance_controls.join(', ')}` : ''}
              </Badge>
              <Badge>Priority {r.priority}</Badge>
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {itemId === null ? (
          <EmptyState
            compact
            title="Select an item"
            body="Choose an item in the queue to see why it was raised, its evidence, earlier decisions on the same pattern, and to decide it."
          />
        ) : wb.isPending ? (
          <Skeleton height="20rem" />
        ) : wb.isError ? (
          <ApiErrorView
            error={wb.error}
            title="Could not load the review item"
            compact
            onRetry={() => void wb.refetch()}
          />
        ) : (
          <DetailBody
            project={project}
            wb={wb.data}
            result={result}
            onDecided={setResult}
            onPattern={onPattern}
          />
        )}
      </CardBody>
    </Card>
  );
}

function DetailBody({
  project,
  wb,
  result,
  onDecided,
  onPattern,
}: {
  project: Project;
  wb: ReviewWorkbench;
  result: ReviewDecideOut | null;
  onDecided: (out: ReviewDecideOut) => void;
  onPattern: (patternKey: string) => void;
}) {
  const r = wb.item;
  const criticalUnnamed = r.status === 'open' && r.compliance === 'critical' && !r.owner_user_id;
  return (
    <>
      {criticalUnnamed ? (
        <Callout
          tone="danger"
          title="Compliance-critical: no named reviewer yet"
          action={
            r.can_assign_reviewer ? (
              <a href="#review-reviewer" className={s.small}>
                Name a reviewer
              </a>
            ) : null
          }
        >
          Nobody can decide this item until a migration lead names a reviewer who holds the{' '}
          {r.owner_role_label} role
          {r.compliance_controls.length ? ` (controls ${r.compliance_controls.join(', ')})` : ''}.
        </Callout>
      ) : null}
      {result ? <DecisionResult out={result} project={project} /> : null}

      <section className={styles.section} aria-labelledby="review-question">
        <h3 id="review-question" className={styles.sectionTitle}>
          Question
        </h3>
        <p className={styles.question}>{r.question}</p>
        {r.options.length ? (
          <p className={s.small}>
            <span className={s.muted}>Options: </span>
            {r.options.map((o, i) => (
              <span key={o}>
                {i > 0 ? ' · ' : ''}“{o}”
              </span>
            ))}
          </p>
        ) : null}
        <KeyValueList
          items={[
            {
              key: 'by',
              label: 'Raised by',
              value: (
                <span className={s.row}>
                  {r.requested_by} <Badge>{actorLabel(r.requested_by_type)}</Badge>
                </span>
              ),
            },
            { key: 'raised', label: 'Raised', value: <Timestamp value={r.created_at} /> },
            {
              key: 'owner',
              label: 'Owner',
              value: `${r.owner_role_label}${r.owner_user ? ` · named reviewer ${r.owner_user}` : ''}`,
            },
            { key: 'conf', label: 'Confidence', value: formatConfidence(r.confidence) },
            {
              key: 'approvals',
              label: 'Approvals',
              value: `${String(r.approvals.length)} of ${String(r.required_approvals)} required`,
            },
            {
              key: 'prio',
              label: 'Priority',
              value: `${String(r.priority)}: ${r.priority_reasons.join(', ')}`,
            },
            {
              key: 'where',
              label: 'Stream and segment',
              value: [r.stream, r.segment].filter(Boolean).join(' · ') || null,
            },
            { key: 'subject', label: 'Subject', value: humanizeKey(r.subject_type) },
            {
              key: 'pattern',
              label: 'Pattern',
              value: r.pattern_key ? (
                <span className={s.row}>
                  <Mono className={s.xs}>{r.pattern_key}</Mono>
                  <Button size="sm" variant="ghost" onClick={() => onPattern(r.pattern_key ?? '')}>
                    Show items with this pattern
                  </Button>
                </span>
              ) : null,
            },
          ]}
        />
      </section>

      <section className={styles.section} aria-labelledby="review-why">
        <h3 id="review-why" className={styles.sectionTitle}>
          Why it was raised
        </h3>
        <p className={`${s.muted} ${s.xs}`}>
          Built only from what was recorded with the item. No model wrote this.
        </p>
        <ul className={styles.why}>
          {wb.why.map((w, i) => (
            <li key={`${String(i)}:${w}`}>{w}</li>
          ))}
        </ul>
      </section>

      <EvidenceLinks project={project} evidence={r.evidence} />
      <Samples samples={wb.samples} flaggedText={r.flagged_text ?? null} />
      <Precedents precedents={wb.precedents} />
      {r.approvals.length > 0 ? <Approvals item={r} /> : null}

      {r.status === 'open' ? (
        <DecisionPanel project={project} item={r} onDecided={onDecided} />
      ) : (
        <Outcome item={r} project={project} />
      )}
      <ReviewerSection project={project} wb={wb} />
      <ReviewAssistant project={project} wb={wb} />
    </>
  );
}

function DecisionResult({ out, project }: { out: ReviewDecideOut; project: Project }) {
  const m = recordedMessage(out);
  return (
    <div className={s.stackSm}>
      <Callout tone={m.tone} title="Decision recorded" live>
        {m.text}
      </Callout>
      {out.follow_up_error ? (
        <Callout tone="warning" title="The agent could not be asked to revise its work" live>
          Your change is recorded, but no follow-up run started: {out.follow_up_error} Tell the
          agent’s owner, or raise the work again once the agent can run.
        </Callout>
      ) : out.item.follow_up_run_id ? (
        <p className={s.small}>
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            search={{ tab: 'agents', agent_run: out.item.follow_up_run_id }}
          >
            Open the agent’s follow-up run
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function EvidenceLinks({ project, evidence }: { project: Project; evidence: ReviewEvidence[] }) {
  return (
    <section className={styles.section} aria-labelledby="review-evidence">
      <h3 id="review-evidence" className={styles.sectionTitle}>
        Evidence
      </h3>
      {evidence.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>No evidence links were recorded with this item.</p>
      ) : (
        <ul className={styles.plainList}>
          {evidence.map((ev, i) => {
            const t = evidenceTarget(ev);
            const kind = EVIDENCE_KIND_LABELS[ev.kind] ?? humanizeKey(ev.kind);
            return (
              <li key={`${ev.kind}:${String(i)}`} className={s.row}>
                <Badge>{kind}</Badge>
                {t === null ? (
                  <span>
                    {ev.label}{' '}
                    <span className={`${s.muted} ${s.xs}`}>(no screen shows this kind yet)</span>
                  </span>
                ) : t.to === 'discovery-run' ? (
                  <Link
                    to="/discovery-runs/$runId"
                    params={{ runId: t.runId }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {ev.label} <ExternalLink aria-hidden="true" size={12} />
                  </Link>
                ) : (
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.id }}
                    search={t.search}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {ev.label} <ExternalLink aria-hidden="true" size={12} />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Samples({
  samples,
  flaggedText,
}: {
  samples: ReviewSamples | null;
  flaggedText: string | null;
}) {
  const text = samples?.type === 'text' ? samples.text : flaggedText;
  if (!samples && !text) return null;
  return (
    <section className={styles.section} aria-labelledby="review-samples">
      <h3 id="review-samples" className={styles.sectionTitle}>
        Sample values
      </h3>
      <p className={`${s.muted} ${s.xs}`}>
        Read from the project’s database as you view them. They are not copied into Astra Migrate.
      </p>
      {samples?.type === 'code' ? (
        <>
          <p className={s.small}>
            {humanizeKey(samples.object_type)} · conversion status {humanizeKey(samples.status)}
          </p>
          <div className={styles.sideBySide}>
            <div className={styles.sample}>
              <strong className={s.small}>Source (legacy)</strong>
              <PlainText
                label="Source code"
                lineNumbers
                empty={<span className={s.muted}>None</span>}
              >
                {samples.source}
              </PlainText>
            </div>
            <div className={styles.sample}>
              <strong className={s.small}>Converted</strong>
              <PlainText
                label="Converted code"
                lineNumbers
                empty={<span className={s.muted}>Not converted</span>}
              >
                {samples.converted}
              </PlainText>
            </div>
          </div>
          {samples.review?.length ? (
            <Callout tone="warning" title="Why automatic conversion stopped">
              <ul className={styles.why}>
                {samples.review.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {samples.warnings?.length ? (
            <div className={s.small}>
              <strong>Warnings</strong>
              <ul className={styles.why}>
                {samples.warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {samples.compile && typeof samples.compile.error === 'string' ? (
            <Callout tone="danger" title="Does not compile on the workbench">
              {samples.compile.error}
            </Callout>
          ) : null}
        </>
      ) : samples?.type === 'elements' ? (
        <>
          <p className={s.small}>
            {samples.total === 0
              ? 'No unused elements were found in the run.'
              : `Showing ${String(samples.items.length)} of ${samples.total.toLocaleString()} unused element(s).`}
          </p>
          {samples.items.length ? (
            <ul className={styles.why}>
              {samples.items.map((x) => (
                <li key={x}>
                  <Mono className={s.xs}>{x}</Mono>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {text ? (
        <div className={styles.untrusted}>
          <strong>Untrusted legacy text, shown as plain text</strong>
          <span className={s.small}>
            This text came from the source system and was flagged by screening. It is data, not
            instructions. Hidden characters are made visible.
          </span>
          <PlainText label="Flagged legacy text">{text}</PlainText>
        </div>
      ) : null}
    </section>
  );
}

function Precedents({ precedents: p }: { precedents: ReviewPrecedents }) {
  const outcomes = Object.entries(p.outcomes);
  return (
    <section className={styles.section} aria-labelledby="review-precedents">
      <h3 id="review-precedents" className={styles.sectionTitle}>
        Earlier decisions on the same pattern
      </h3>
      {!p.pattern_key ? (
        <p className={`${s.muted} ${s.small}`}>
          This item has no pattern key, so there are no precedents.
        </p>
      ) : p.items.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>No earlier decisions on this pattern.</p>
      ) : (
        <>
          <p className={s.badges} aria-label="Outcomes so far">
            {outcomes.map(([o, n]) => (
              <Badge key={o} tone={outcomeTone(o)}>
                {outcomeLabel(o)}: {n}
              </Badge>
            ))}
          </p>
          <ul className={styles.plainList}>
            {p.items.map((x) => (
              <li key={x.item_id} className={styles.precedent}>
                <span className={s.row}>
                  <StatusPill tone={outcomeTone(x.outcome)}>{outcomeLabel(x.outcome)}</StatusPill>
                  <span className={s.cellPrimary}>{x.title}</span>
                </span>
                <span className={`${s.muted} ${s.xs}`}>
                  {x.same_project ? (
                    <Badge tone="accent">This project</Badge>
                  ) : (
                    <span>Project {x.project_name ?? 'unknown'}</span>
                  )}{' '}
                  {x.decided_by ? `· decided by ${x.decided_by}` : ''}{' '}
                  {x.decided_at ? (
                    <>
                      · <Timestamp value={x.decided_at} />
                    </>
                  ) : null}
                </span>
                {x.changed_value || x.resolution ? (
                  <span className={s.small}>Answer: “{x.changed_value ?? x.resolution}”</span>
                ) : null}
                {x.note ? <span className={styles.quote}>Note: “{x.note}”</span> : null}
                <span className={s.xs}>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: x.project_id }}
                    search={{ tab: 'reviews', status: 'all', item: x.item_id }}
                  >
                    Open this decision
                    {x.same_project ? '' : ` in ${x.project_name ?? 'its project'}`}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
          {p.items.length < Object.values(p.outcomes).reduce((a, b) => a + b, 0) ? (
            <p className={`${s.muted} ${s.xs}`}>The most recent decisions are shown.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

function Approvals({ item }: { item: ReviewItem }) {
  return (
    <section className={styles.section} aria-labelledby="review-approvals">
      <h3 id="review-approvals" className={styles.sectionTitle}>
        Approvals so far ({item.approvals.length} of {item.required_approvals})
      </h3>
      <ul className={styles.plainList}>
        {item.approvals.map((a, i) => (
          <li key={`${a.user ?? ''}:${String(i)}`} className={s.small}>
            {a.user ?? 'Someone'} approved “{a.option}”
            {a.at ? (
              <>
                {' '}
                <Timestamp value={a.at} />
              </>
            ) : null}
            {a.note ? <span className={styles.quote}> — “{a.note}”</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Outcome({ item: r, project }: { item: ReviewItem; project: Project }) {
  const st = reviewStatus(r.status);
  return (
    <section className={styles.section} aria-labelledby="review-outcome">
      <h3 id="review-outcome" className={styles.sectionTitle}>
        Decision
      </h3>
      <KeyValueList
        items={[
          {
            key: 'status',
            label: 'Status',
            value: <StatusPill tone={st.tone}>{st.label}</StatusPill>,
          },
          {
            key: 'answer',
            label: 'Answer',
            value: r.changed_value ?? r.resolution,
          },
          { key: 'note', label: 'Reason', value: r.resolution_note },
          {
            key: 'by',
            label: 'Decided by',
            value: r.resolved_by ? (
              <span>
                {r.resolved_by}
                {r.resolved_at ? (
                  <>
                    {' '}
                    <Timestamp value={r.resolved_at} />
                  </>
                ) : null}
              </span>
            ) : null,
          },
          {
            key: 'follow',
            label: 'Follow-up run',
            value: r.follow_up_run_id ? (
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ tab: 'agents', agent_run: r.follow_up_run_id }}
              >
                Open the agent’s follow-up run
              </Link>
            ) : typeof r.context.follow_up_error === 'string' ? (
              <span style={{ color: 'var(--color-warning-text)' }}>
                Not started: {r.context.follow_up_error}
              </span>
            ) : null,
          },
        ]}
      />
    </section>
  );
}

function ReviewerSection({ project, wb }: { project: Project; wb: ReviewWorkbench }) {
  const r = wb.item;
  const assign = useAssignReviewer(project.id);
  const [choice, setChoice] = useState(r.owner_user_id ?? NOBODY);
  const errors = mergeFieldErrors<'user_id'>({}, assign.error, false);
  const current = r.owner_user_id ?? NOBODY;
  const options = [
    { value: NOBODY, label: 'Nobody named (anyone holding the role decides)' },
    ...(r.owner_user_id && !wb.reviewers.some((x) => x.id === r.owner_user_id)
      ? [{ value: r.owner_user_id, label: r.owner_user ?? 'Current reviewer' }]
      : []),
    ...wb.reviewers.map((x) => ({ value: x.id, label: x.name })),
  ];
  return (
    <section
      className={styles.section}
      aria-labelledby="review-reviewer-title"
      id="review-reviewer"
    >
      <h3 id="review-reviewer-title" className={styles.sectionTitle}>
        Named reviewer
      </h3>
      <p className={s.small}>
        {r.owner_user ? (
          <>
            <strong>{r.owner_user}</strong> is named to decide this item.
          </>
        ) : (
          <>Nobody is named. Anyone holding the {r.owner_role_label} role may decide.</>
        )}{' '}
        {r.compliance === 'critical'
          ? r.required_approvals > 1
            ? 'Compliance-critical: the named reviewer must be one of the approvers.'
            : 'Compliance-critical: only the named reviewer decides.'
          : ''}
      </p>
      {r.can_assign_reviewer ? (
        <form
          className={s.row}
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            assign.mutate(
              { id: r.id, userId: choice === NOBODY ? null : choice },
              {
                onSuccess: (it) =>
                  toast.success(
                    it.owner_user
                      ? `${it.owner_user} is the named reviewer`
                      : 'Named reviewer removed',
                  ),
              },
            );
          }}
        >
          <div style={{ flex: '1 1 16rem' }}>
            <Field
              label="Reviewer"
              help={
                wb.reviewers.length === 0
                  ? `Nobody else holds the ${r.owner_role_label} role on this project. Grant the role on the Access page first.`
                  : `People who hold the ${r.owner_role_label} role on this project. The person who raised the item is not listed.`
              }
              error={errors.user_id}
            >
              <Select options={options} value={choice} onValueChange={setChoice} />
            </Field>
          </div>
          <Button type="submit" loading={assign.isPending} disabled={choice === current}>
            Save reviewer
          </Button>
          <div style={{ flexBasis: '100%' }}>
            <FormError error={assign.error} fields={['user_id']} />
          </div>
        </form>
      ) : r.status === 'open' ? (
        <p className={`${s.muted} ${s.xs}`}>Only a migration lead names reviewers.</p>
      ) : null}
    </section>
  );
}
