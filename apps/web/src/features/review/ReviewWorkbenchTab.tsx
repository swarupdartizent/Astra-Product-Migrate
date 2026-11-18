import { Inbox, Search, ShieldExclamationPoint, UserCheck, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useReviewQueue } from '@/api/runtime';
import type { Project, ReviewFacet, ReviewItem, ReviewQueue } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  StatusPill,
  Switch,
} from '@/ui';
import { useRoleLabel } from '../blueprints/useRoleLabel';
import { Pager } from '../plan/PlanShared';
import { reviewStatus } from '../runtime/model';
import s from '../shared.module.css';
import {
  activeFilterCount,
  ageOf,
  complianceInfo,
  formatConfidence,
  humanizeKey,
  QUEUE_PAGE,
  queueQuery,
  REVIEW_STATUS_FILTERS,
  riskInfo,
  type ReviewSearch,
} from './model';
import styles from './Review.module.css';
import { ReviewDetail } from './ReviewDetail';

const ALL = '__all__';

export interface ReviewWorkbenchTabProps {
  project: Project;
  /** The view from the URL. Without it the tab keeps its own state (tests, embedding). */
  search?: ReviewSearch;
  /** Called with the whole next view; `replace` for filter changes, push for selections. */
  onSearch?: (next: ReviewSearch, replace: boolean) => void;
}

/** Drops empty values so the URL stays short. */
function clean(s: ReviewSearch): ReviewSearch {
  return Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined && v !== '' && v !== false),
  );
}

/**
 * The review workbench (E16.F1): a priority-sorted queue with filters and pattern groups, and the
 * selected item's evidence panel, decisions, named reviewer and Review Assistant. The selection
 * and filters live in the URL so a link opens the same view.
 */
export function ReviewWorkbenchTab({ project, search, onSearch }: ReviewWorkbenchTabProps) {
  const [local, setLocal] = useState<ReviewSearch>({});
  const view = search ?? local;
  const update = (patch: Partial<ReviewSearch>, replace = true) => {
    const next = clean({ ...view, ...patch });
    if (onSearch) onSearch(next, replace);
    else setLocal(next);
  };
  const setFilter = (patch: Partial<ReviewSearch>) => update({ ...patch, offset: undefined });

  const queue = useReviewQueue(project.id, queueQuery(view));
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Free-text search: typed locally, written to the URL once typing pauses.
  const [text, setText] = useState(view.q ?? '');
  const timer = useRef<number | undefined>(undefined);
  const onText = (v: string) => {
    setText(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFilter({ q: v.trim() || undefined }), 350);
  };

  const select = (id: string) => {
    update({ item: id }, false);
    // Move focus to the evidence panel so keyboard and screen reader users land on the item.
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };

  const filters = activeFilterCount(view);
  return (
    <div className={styles.layout}>
      <Card flush aria-labelledby="review-queue-head">
        <CardHeader
          titleId="review-queue-head"
          title="Review queue"
          description="Sorted by priority: risk, then compliance impact, then low confidence; oldest first within a score. Agents and platform rules propose; people decide."
        />
        <QueueFilters
          view={view}
          queue={queue.data}
          text={text}
          onText={onText}
          onFilter={setFilter}
        />
        <div className={styles.filterBar}>
          <span className={s.muted} aria-live="polite">
            {queue.data
              ? `${queue.data.total.toLocaleString()} item(s)${filters ? ` match ${String(filters)} filter(s)` : ''}`
              : 'Loading the queue…'}
          </span>
          {filters > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<X aria-hidden="true" />}
              onClick={() => {
                window.clearTimeout(timer.current);
                setText('');
                update(
                  {
                    stream: undefined,
                    segment: undefined,
                    agent: undefined,
                    kind: undefined,
                    risk: undefined,
                    compliance: undefined,
                    owner_role: undefined,
                    pattern: undefined,
                    mine: undefined,
                    q: undefined,
                    offset: undefined,
                  },
                  true,
                );
              }}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
        {queue.data && queue.data.groups.length > 0 ? (
          <PatternGroups
            groups={queue.data.groups}
            active={view.pattern ?? null}
            onPick={(k) => setFilter({ pattern: k ?? undefined })}
          />
        ) : null}
        {queue.isError ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <ApiErrorView
              error={queue.error}
              title="Could not load the review queue"
              compact
              onRetry={() => void queue.refetch()}
            />
          </div>
        ) : queue.isPending ? (
          <div style={{ padding: 'var(--space-4)' }} className={s.stackSm}>
            <Skeleton height="4rem" />
            <Skeleton height="4rem" />
            <Skeleton height="4rem" />
          </div>
        ) : queue.data.items.length === 0 ? (
          <EmptyState
            compact
            icon={<Inbox />}
            title={
              filters
                ? 'No items match these filters'
                : (view.status ?? 'open') === 'open'
                  ? 'Nothing waiting for review'
                  : 'No items'
            }
          />
        ) : (
          <ul className={styles.queue} aria-label="Review items" aria-busy={queue.isFetching}>
            {queue.data.items.map((r) => (
              <QueueRow key={r.id} item={r} current={r.id === view.item} onSelect={select} />
            ))}
          </ul>
        )}
        {queue.data && queue.data.total > QUEUE_PAGE ? (
          <Pager
            offset={view.offset ?? 0}
            limit={QUEUE_PAGE}
            total={queue.data.total}
            onOffset={(n) => update({ offset: n || undefined })}
          />
        ) : null}
      </Card>
      <ReviewDetail
        key={view.item ?? ''}
        project={project}
        itemId={view.item ?? null}
        headingRef={headingRef}
        onPattern={(k) => setFilter({ pattern: k })}
      />
    </div>
  );
}

const FACET_LABELS: Record<ReviewFacet, string> = {
  risk: 'Risk',
  compliance: 'Compliance',
  stream: 'Stream',
  segment: 'Segment',
  agent: 'Agent',
  kind: 'Kind',
  owner_role: 'Owner role',
};

const FACET_ORDER: readonly ReviewFacet[] = [
  'risk',
  'compliance',
  'owner_role',
  'stream',
  'segment',
  'kind',
  'agent',
];

const RISK_ORDER = ['critical', 'high', 'medium', 'low'];
const COMPLIANCE_ORDER = ['critical', 'relevant', 'none'];

function QueueFilters({
  view,
  queue,
  text,
  onText,
  onFilter,
}: {
  view: ReviewSearch;
  queue: ReviewQueue | undefined;
  text: string;
  onText: (v: string) => void;
  onFilter: (patch: Partial<ReviewSearch>) => void;
}) {
  const roleLabel = useRoleLabel();
  const labelOf = (facet: ReviewFacet, v: string): string => {
    if (facet === 'risk') return humanizeKey(v);
    if (facet === 'compliance') return complianceInfo(v).label;
    if (facet === 'owner_role') return roleLabel(v);
    if (facet === 'kind' || facet === 'stream') return humanizeKey(v);
    return v;
  };
  return (
    <div className={styles.filters} role="group" aria-label="Filter the review queue">
      <Field label="Status">
        <Select
          size="sm"
          options={REVIEW_STATUS_FILTERS}
          value={view.status ?? 'open'}
          onValueChange={(v) => onFilter({ status: v === 'open' ? undefined : (v as never) })}
        />
      </Field>
      {FACET_ORDER.map((facet) => {
        const counts = queue?.facets[facet] ?? {};
        const current = view[facet];
        let values = Object.keys(counts);
        if (facet === 'risk') values = RISK_ORDER.filter((v) => v in counts);
        if (facet === 'compliance') values = COMPLIANCE_ORDER.filter((v) => v in counts);
        if (current && !values.includes(current)) values = [...values, current];
        if (values.length === 0) return null;
        return (
          <Field key={facet} label={FACET_LABELS[facet]}>
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All' },
                ...values.map((v) => ({
                  value: v,
                  label: `${labelOf(facet, v)} (${String(counts[v] ?? 0)})`,
                })),
              ]}
              value={current ?? ALL}
              onValueChange={(v) => onFilter({ [facet]: v === ALL ? undefined : v })}
            />
          </Field>
        );
      })}
      <Field label="Search title and question">
        <Input
          size="sm"
          type="search"
          startAdornment={<Search />}
          value={text}
          maxLength={200}
          onChange={(e) => onText(e.target.value)}
        />
      </Field>
      <Field label="Only mine" inline help="Named to me, or unnamed and owned by one of my roles.">
        <Switch
          checked={view.mine === true}
          onCheckedChange={(c) => onFilter({ mine: c || undefined })}
        />
      </Field>
    </div>
  );
}

function PatternGroups({
  groups,
  active,
  onPick,
}: {
  groups: ReviewQueue['groups'];
  active: string | null;
  onPick: (key: string | null) => void;
}) {
  return (
    <section aria-label="Similar items, by pattern">
      <p className={`${s.muted} ${s.xs}`} style={{ padding: 'var(--space-2) var(--space-4) 0' }}>
        Patterns shared by more than one item. Work a large run pattern by pattern.
      </p>
      <ul className={styles.groups}>
        {groups.map((g) => (
          <li key={g.pattern_key}>
            <button
              type="button"
              className={styles.groupButton}
              aria-pressed={active === g.pattern_key}
              title={g.pattern_key}
              onClick={() => onPick(active === g.pattern_key ? null : g.pattern_key)}
            >
              <span className={styles.groupTitle}>{g.example_title}</span>
              <Badge>{g.count}</Badge>
              <span className="sr-only">items with this pattern</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function QueueRow({
  item: r,
  current,
  onSelect,
}: {
  item: ReviewItem;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const risk = riskInfo(r.risk);
  const comp = complianceInfo(r.compliance);
  const st = reviewStatus(r.status);
  const unnamedCritical = r.compliance === 'critical' && !r.owner_user_id && r.status === 'open';
  return (
    <li className={styles.queueItem}>
      <button
        type="button"
        className={styles.queueButton}
        aria-current={current ? 'true' : undefined}
        onClick={() => onSelect(r.id)}
      >
        <span className={s.badges}>
          <Badge tone={risk.tone}>{risk.label}</Badge>
          {r.compliance !== 'none' ? (
            <Badge tone={comp.tone} icon={<ShieldExclamationPoint aria-hidden="true" />}>
              {comp.label}
              {r.compliance_controls.length ? `: ${r.compliance_controls.join(', ')}` : ''}
            </Badge>
          ) : null}
          {r.status !== 'open' ? <StatusPill tone={st.tone}>{st.label}</StatusPill> : null}
          {unnamedCritical ? <Badge tone="danger">No named reviewer</Badge> : null}
        </span>
        <span className={styles.queueTitle}>{r.title}</span>
        <span className={styles.queueMeta}>
          <span>Priority {r.priority}</span>
          <span>Confidence {formatConfidence(r.confidence).toLowerCase()}</span>
          <span>
            Approvals {r.approvals.length} of {r.required_approvals}
          </span>
          <span>
            {r.owner_user ? (
              <>
                <UserCheck aria-hidden="true" size={12} /> {r.owner_user}
              </>
            ) : (
              r.owner_role_label
            )}
          </span>
          <span>
            <span className="sr-only">Age </span>
            {ageOf(r.created_at)}
          </span>
        </span>
        <span className={styles.queueReasons}>
          Why this priority: {r.priority_reasons.join(', ')}
        </span>
      </button>
    </li>
  );
}
