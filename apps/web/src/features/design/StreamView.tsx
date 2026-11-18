import { Link } from '@tanstack/react-router';
import { Check, ExternalLink, ListChecks, Search, X } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { useDesignDecision, useDesignItem, useDesignItems, useDesignOverview } from '@/api/design';
import {
  DESIGN_STATUSES,
  type DecisionAction,
  type DecisionOut,
  type DesignItemDetail,
  type DesignItemSummary,
  type DesignStatus,
  type DesignStream,
} from '@/api/design-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { mergeFieldErrors, reasonError } from '@/lib/forms';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
} from '@/ui';
import { Pager } from '../plan/PlanShared';
import s from '../shared.module.css';
import styles from './Design.module.css';
import { RequiredUnmapped } from './DesignOverview';
import {
  decidableHere,
  decisionLines,
  designStatus,
  itemSubtitle,
  itemTitle,
  notDecidableReason,
  STREAM_INFO,
  targetError,
} from './model';
import { ConfidenceMeter } from './Parts';
import { StreamBody } from './StreamBodies';

const ALL = '__all__';
const PAGE = 50;

interface Result {
  out: DecisionOut;
  action: DecisionAction;
  titles: Record<string, string>;
}

/**
 * One design stream: the register's items with filters on the left, the selected item's detail
 * and decisions on the right. Items in the review queue, blocked or already decided items show
 * why they cannot be decided here.
 */
export function StreamView({
  project,
  stream,
  selected,
  onSelect,
}: {
  project: Project;
  stream: DesignStream;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const overview = useDesignOverview(project.id);
  const canDecide = overview.data?.can_decide[stream] ?? false;
  const [status, setStatus] = useState<DesignStatus | ''>('');
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim().toLowerCase(), 300);
  const [offset, setOffset] = useState(0);
  const items = useDesignItems(project.id, {
    stream,
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
    offset,
    limit: PAGE,
  });
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [bulk, setBulk] = useState<'approve' | 'reject' | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rows = items.data?.items ?? [];
  const selectable = rows.filter(decidableHere);
  const allPicked = selectable.length > 0 && selectable.every((r) => picked.has(r.key));
  const somePicked = selectable.some((r) => picked.has(r.key));
  const toggle = (r: DesignItemSummary, on: boolean) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (on) next.set(r.key, itemTitle(r));
      else next.delete(r.key);
      return next;
    });
  const select = (key: string) => {
    onSelect(key);
    window.setTimeout(() => headingRef.current?.focus(), 0);
  };
  const info = STREAM_INFO[stream];
  const gaps =
    stream === 'mapping'
      ? (overview.data?.latest_run?.summary.mapping?.required_unmapped ?? [])
      : [];
  const threshold = overview.data?.latest_run?.summary.mapping?.threshold ?? null;
  const decided = (out: DecisionOut, action: DecisionAction, titles: Record<string, string>) => {
    setResult({ out, action, titles });
    setPicked((prev) => {
      const next = new Map(prev);
      for (const k of [...out.decided, ...out.awaiting_second_approval]) next.delete(k);
      return next;
    });
  };

  return (
    <div className={s.stack}>
      <Callout tone="info" title={`${info.label}: decided by the ${info.owner.toLowerCase()} role`}>
        {info.about}
        {overview.data && !canDecide ? (
          <> You can read this stream; you do not hold the role that decides it.</>
        ) : null}
      </Callout>
      {gaps.length > 0 ? <RequiredUnmapped gaps={gaps} /> : null}
      <DecisionResult result={result} onDismiss={() => setResult(null)} />
      <div className={styles.layout}>
        <Card flush aria-labelledby={`design-${stream}-list`}>
          <CardHeader titleId={`design-${stream}-list`} title={info.label} />
          <div
            className={styles.filters}
            role="group"
            aria-label={`Filter ${info.label.toLowerCase()}`}
          >
            <Field label="Status">
              <Select
                size="sm"
                options={[
                  { value: ALL, label: 'All' },
                  ...DESIGN_STATUSES.map((x) => ({ value: x, label: designStatus(x).label })),
                ]}
                value={status || ALL}
                onValueChange={(v) => {
                  setStatus(v === ALL ? '' : (v as DesignStatus));
                  setOffset(0);
                }}
              />
            </Field>
            <Field label="Key contains">
              <Input
                size="sm"
                type="search"
                startAdornment={<Search />}
                value={text}
                maxLength={200}
                onChange={(e) => {
                  setText(e.target.value);
                  setOffset(0);
                }}
              />
            </Field>
          </div>
          <div className={styles.bar}>
            {canDecide ? (
              <>
                <Field label="Select every proposed item on this page" inline>
                  <Checkbox
                    checked={allPicked ? true : somePicked ? 'indeterminate' : false}
                    disabled={selectable.length === 0}
                    onCheckedChange={(v) => {
                      for (const r of selectable) toggle(r, v === true);
                    }}
                  />
                </Field>
                <span className={s.muted} aria-live="polite">
                  {picked.size.toLocaleString()} selected
                </span>
                <span className={s.row}>
                  <Button
                    size="sm"
                    variant="primary"
                    leadingIcon={<ListChecks aria-hidden="true" />}
                    disabled={picked.size === 0}
                    onClick={() => setBulk('approve')}
                  >
                    Approve selected
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={picked.size === 0}
                    onClick={() => setBulk('reject')}
                  >
                    Reject selected
                  </Button>
                  {picked.size > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())}>
                      Clear
                    </Button>
                  ) : null}
                </span>
              </>
            ) : (
              <span className={s.muted} aria-live="polite">
                {items.data ? `${items.data.total.toLocaleString()} item(s)` : 'Loading…'}
              </span>
            )}
          </div>
          {items.isError ? (
            <div style={{ padding: 'var(--space-4)' }}>
              <ApiErrorView
                error={items.error}
                title={`Could not load ${info.label.toLowerCase()}`}
                compact
                onRetry={() => void items.refetch()}
              />
            </div>
          ) : items.isPending ? (
            <div style={{ padding: 'var(--space-4)' }} className={s.stackSm}>
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              compact
              title={status || q ? 'No items match these filters' : 'No items in this stream'}
              body={
                status || q
                  ? undefined
                  : 'A design run proposes this stream. A stream the target cannot support is listed as blocked on the overview.'
              }
            />
          ) : (
            <ul
              className={styles.list}
              aria-label={`${info.label} items`}
              aria-busy={items.isFetching}
            >
              {rows.map((r) => (
                <ItemRow
                  key={r.key}
                  item={r}
                  current={r.key === selected}
                  selectable={canDecide}
                  picked={picked.has(r.key)}
                  threshold={threshold}
                  onPick={(on) => toggle(r, on)}
                  onSelect={() => select(r.key)}
                />
              ))}
            </ul>
          )}
          {items.data && items.data.total > PAGE ? (
            <Pager offset={offset} limit={PAGE} total={items.data.total} onOffset={setOffset} />
          ) : null}
        </Card>
        <ItemPanel
          key={selected ?? ''}
          project={project}
          stream={stream}
          itemKey={selected}
          threshold={threshold}
          headingRef={headingRef}
          onDecided={decided}
        />
      </div>
      {bulk ? (
        <DecisionDialog
          project={project}
          stream={stream}
          mode={bulk}
          titles={Object.fromEntries(picked)}
          onClose={() => setBulk(null)}
          onDecided={decided}
        />
      ) : null}
    </div>
  );
}

function ItemRow({
  item: r,
  current,
  selectable,
  picked,
  threshold,
  onPick,
  onSelect,
}: {
  item: DesignItemSummary;
  current: boolean;
  selectable: boolean;
  picked: boolean;
  threshold: number | null;
  onPick: (on: boolean) => void;
  onSelect: () => void;
}) {
  const st = designStatus(r.status);
  const title = itemTitle(r);
  const sub = itemSubtitle(r);
  const why = notDecidableReason(r);
  const awaiting = r.status === 'proposed' && (r.approvals?.length ?? 0) > 0;
  return (
    <li className={styles.row}>
      {selectable ? (
        <Checkbox
          checked={picked}
          disabled={!decidableHere(r)}
          onCheckedChange={(v) => onPick(v === true)}
          aria-label={
            decidableHere(r) ? `Select ${title}` : `Select ${title} (not selectable: ${why ?? ''})`
          }
        />
      ) : null}
      <button
        type="button"
        className={styles.rowButton}
        aria-current={current ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className={s.badges}>
          <StatusPill tone={st.tone}>{st.label}</StatusPill>
          {awaiting ? <Badge tone="info">Awaiting second approval</Badge> : null}
          {r.desktop ? <Badge tone="warning">Desktop link</Badge> : null}
          {(r.target as { retire?: unknown } | null)?.retire === true ? (
            <Badge tone="warning">Retirement proposed</Badge>
          ) : null}
        </span>
        <span className={styles.rowTitle}>
          <Mono className={s.small}>{title}</Mono>
        </span>
        {sub ? <span className={styles.rowMeta}>{sub}</span> : null}
        <span className={styles.rowMeta}>
          {r.stream === 'mapping' ? (
            <ConfidenceMeter value={r.confidence} threshold={threshold} label={title} />
          ) : null}
          {r.flags && r.flags.length > 0 ? <span>{r.flags.length} flag(s)</span> : null}
          {why && r.status !== 'proposed' ? <span>{why}</span> : null}
        </span>
      </button>
    </li>
  );
}

/** What the last decision recorded: decided, awaiting a second approval, refused with reasons. */
function DecisionResult({ result, onDismiss }: { result: Result | null; onDismiss: () => void }) {
  return (
    <div role="status" aria-live="polite">
      {result ? (
        <Callout
          tone={
            result.out.refused.length ? 'warning' : result.out.decided.length ? 'success' : 'info'
          }
          title="Decision recorded"
          action={
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<X aria-hidden="true" />}
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          }
        >
          <ul className={styles.plainList}>
            {decisionLines(result.out, result.action).map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
          {result.out.awaiting_second_approval.length > 0 ? (
            <>
              <p className={styles.subTitle}>Awaiting a second approval</p>
              <ul className={styles.bullets}>
                {result.out.awaiting_second_approval.map((k) => (
                  <li key={k}>
                    <Mono className={s.xs}>{result.titles[k] ?? k}</Mono>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.out.refused.length > 0 ? (
            <>
              <p className={styles.subTitle}>Refused</p>
              <ul className={styles.bullets}>
                {result.out.refused.map((r) => (
                  <li key={r.key}>
                    <Mono className={s.xs}>{result.titles[r.key] ?? r.key}</Mono>: {r.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Callout>
      ) : null}
    </div>
  );
}

function ItemPanel({
  project,
  stream,
  itemKey,
  threshold,
  headingRef,
  onDecided,
}: {
  project: Project;
  stream: DesignStream;
  itemKey: string | null;
  threshold: number | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onDecided: (out: DecisionOut, action: DecisionAction, titles: Record<string, string>) => void;
}) {
  const q = useDesignItem(project.id, stream, itemKey);
  // Unsaved edits in the body (security access, test steps) block approval until saved.
  const [unsaved, setUnsaved] = useState<string | null>(null);
  const it = q.data;
  const st = it ? designStatus(it.status) : null;
  return (
    <Card aria-labelledby={`design-${stream}-detail`}>
      <CardHeader
        titleId={`design-${stream}-detail`}
        title={
          <span ref={headingRef} tabIndex={-1} className={styles.panelHeading}>
            {itemKey === null ? 'Item detail' : it ? itemTitle(it) : 'Loading the item…'}
          </span>
        }
        description={
          it && st ? (
            <span className={s.badges}>
              <StatusPill tone={st.tone}>{st.label}</StatusPill>
              <Mono className={s.xs}>{it.key}</Mono>
            </span>
          ) : undefined
        }
      />
      <CardBody className={s.stack}>
        {itemKey === null ? (
          <EmptyState
            compact
            title="Select an item"
            body="Choose an item to see its source and proposed target, the evidence, and to decide it."
          />
        ) : q.isPending ? (
          <Skeleton height="18rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load the item"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : (
          <>
            <StateNotes project={project} item={q.data} />
            <StreamBody
              project={project}
              item={q.data}
              threshold={threshold}
              onUnsaved={setUnsaved}
            />
            <EvidenceAndFlags item={q.data} />
            <DecisionBar project={project} item={q.data} unsaved={unsaved} onDecided={onDecided} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Where the item stands: review queue link, blocked reason, recorded decisions and approvals. */
function StateNotes({ project, item: it }: { project: Project; item: DesignItemDetail }) {
  const approvals = it.approvals ?? [];
  return (
    <>
      {it.status === 'in_review' ? (
        <Callout
          tone="warning"
          title="Decided in the review queue"
          action={
            it.review_item_id ? (
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ tab: 'reviews', item: it.review_item_id }}
                style={{ whiteSpace: 'nowrap' }}
              >
                Open the review item <ExternalLink aria-hidden="true" size={12} />
              </Link>
            ) : null
          }
        >
          This item needs an expert’s decision, so it cannot be decided here. The decision in the
          review queue updates this register.
          {it.review_item_id ? null : ' The review item is not linked yet.'}
        </Callout>
      ) : null}
      {it.status === 'blocked' ? (
        <Callout tone="danger" title="Blocked">
          {it.readiness ?? 'The item is blocked and cannot be approved.'}
        </Callout>
      ) : null}
      {it.decision && (it.status === 'approved' || it.status === 'rejected') ? (
        <Callout
          tone={it.status === 'approved' ? 'success' : 'danger'}
          title={it.status === 'approved' ? 'Approved' : 'Rejected'}
        >
          By {it.decision.by}
          {it.decision.at ? (
            <>
              {' '}
              (<Timestamp value={it.decision.at} />)
            </>
          ) : null}
          {it.decision.option ? `, “${it.decision.option}”` : ''}
          {it.decision.no_target ? ', as not migrated' : ''}
          {it.decision.reason ? `: “${it.decision.reason}”` : '.'}
          {it.decision.controls && it.decision.controls.length > 0 ? (
            <span className={`${s.muted} ${s.xs}`}>
              {' '}
              Controls: {it.decision.controls.join(', ')}.
            </span>
          ) : null}
        </Callout>
      ) : null}
      {it.status === 'proposed' && approvals.length > 0 ? (
        <Callout tone="info" title="Awaiting a second approval">
          {approvals.map((a) => a.by).join(', ')} approved it
          {approvals[0]?.no_target ? ' as not migrated' : ''}. The project’s compliance packs
          require two people, so a different person completes the approval.
        </Callout>
      ) : null}
      {it.previous_decision ? (
        <p className={`${s.muted} ${s.small}`}>
          The source changed since {it.previous_decision.by} decided it (
          {it.previous_decision.action}
          {it.previous_decision.reason ? `: “${it.previous_decision.reason}”` : ''}), so it is
          proposed again.
        </p>
      ) : null}
    </>
  );
}

function EvidenceAndFlags({ item: it }: { item: DesignItemDetail }) {
  const ev = it.evidence ?? [];
  const flags = it.flags ?? [];
  return (
    <div className={s.grid2}>
      <section className={styles.section} aria-labelledby={`ev-${it.key}`}>
        <h3 id={`ev-${it.key}`} className={styles.sectionTitle}>
          Evidence ({ev.length})
        </h3>
        {ev.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>None recorded.</p>
        ) : (
          <ul className={styles.bullets}>
            {ev.map((e, i) => (
              <li key={`${String(i)}:${e}`}>{e}</li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.section} aria-labelledby={`fl-${it.key}`}>
        <h3 id={`fl-${it.key}`} className={styles.sectionTitle}>
          Flags ({flags.length})
        </h3>
        {flags.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>None.</p>
        ) : (
          <ul className={styles.bullets}>
            {flags.map((f, i) => (
              <li key={`${String(i)}:${f}`}>{f}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Mode = 'approve' | 'no_target' | 'change' | 'reject';

/** The item's decisions, always visible; disabled ones say why. */
function DecisionBar({
  project,
  item: it,
  unsaved,
  onDecided,
}: {
  project: Project;
  item: DesignItemDetail;
  unsaved: string | null;
  onDecided: (out: DecisionOut, action: DecisionAction, titles: Record<string, string>) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const roleWhy = it.can_decide
    ? null
    : (it.cannot_decide_reason ?? 'You cannot decide this item.');
  const stateWhy = it.status === 'proposed' ? null : notDecidableReason(it);
  const approveWhy = roleWhy ?? stateWhy ?? unsaved ?? it.readiness;
  const rejectWhy = roleWhy ?? (it.status === 'blocked' ? null : stateWhy);
  const mapping = it.stream === 'mapping';
  const hasTarget = !!it.target;
  const reasons = [...new Set([approveWhy, rejectWhy].filter((x): x is string => !!x))];
  const describedBy = reasons.length ? `why-${it.key}` : undefined;
  return (
    <section className={styles.section} aria-labelledby={`decide-${it.key}`}>
      <h3 id={`decide-${it.key}`} className={styles.sectionTitle}>
        Decision
      </h3>
      <div className={s.row}>
        <Button
          variant="primary"
          leadingIcon={<Check aria-hidden="true" />}
          disabled={!!approveWhy || (mapping && !hasTarget)}
          aria-describedby={describedBy}
          onClick={() => setMode('approve')}
        >
          {mapping ? 'Approve proposed target' : 'Approve'}
        </Button>
        {mapping ? (
          <>
            <Button
              disabled={!!approveWhy}
              aria-describedby={describedBy}
              onClick={() => setMode('no_target')}
            >
              Approve as not migrated
            </Button>
            <Button
              disabled={!!(roleWhy ?? stateWhy)}
              aria-describedby={describedBy}
              onClick={() => setMode('change')}
            >
              Change target
            </Button>
          </>
        ) : null}
        <Button
          variant="danger"
          disabled={!!rejectWhy}
          aria-describedby={describedBy}
          onClick={() => setMode('reject')}
        >
          Reject
        </Button>
      </div>
      {reasons.length || (mapping && !hasTarget && !approveWhy) ? (
        <ul id={describedBy} className={styles.bullets}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
          {mapping && !hasTarget && !approveWhy ? (
            <li>
              No target is proposed: change it to a target column, or approve it as not migrated.
            </li>
          ) : null}
        </ul>
      ) : null}
      {mode ? (
        <DecisionDialog
          project={project}
          stream={it.stream}
          mode={mode}
          titles={{ [it.key]: itemTitle(it) }}
          onClose={() => setMode(null)}
          onDecided={onDecided}
        />
      ) : null}
    </section>
  );
}

const MODE_TEXT: Record<Mode, { title: string; submit: string; about: string }> = {
  approve: {
    title: 'Approve',
    submit: 'Approve',
    about:
      'Approves each item with its proposal. Items that are not ready, in the review queue or already decided are refused and listed with the reason.',
  },
  no_target: {
    title: 'Approve as not migrated',
    submit: 'Approve as not migrated',
    about: 'The source column is not migrated: no target column receives its values.',
  },
  change: {
    title: 'Change the target',
    submit: 'Change and approve',
    about:
      'Give the target column as schema.table.column. It must be a column of the pinned target baseline.',
  },
  reject: {
    title: 'Reject',
    submit: 'Reject',
    about:
      'Rejected items are not built. A new design run proposes them again only when their source changes.',
  },
};

function DecisionDialog({
  project,
  stream,
  mode,
  titles,
  onClose,
  onDecided,
}: {
  project: Project;
  stream: DesignStream;
  mode: Mode;
  titles: Record<string, string>;
  onClose: () => void;
  onDecided: (out: DecisionOut, action: DecisionAction, titles: Record<string, string>) => void;
}) {
  const decide = useDesignDecision(project.id);
  const keys = Object.keys(titles);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: { reason?: string; target?: string } = {};
  const r = reasonError(reason);
  if (r) client.reason = r;
  if (mode === 'change') {
    const t = targetError(target);
    if (t) client.target = t;
  }
  const errors = mergeFieldErrors(client, decide.error, submitted);
  const text = MODE_TEXT[mode];
  const action: DecisionAction =
    mode === 'reject' ? 'reject' : mode === 'change' ? 'change' : 'approve';
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={
        keys.length === 1
          ? `${text.title}: ${Object.values(titles)[0] ?? ''}`
          : `${text.title} ${String(keys.length)} items`
      }
      description={text.about}
      submitLabel={keys.length === 1 ? text.submit : `${text.submit} ${String(keys.length)}`}
      tone={mode === 'reject' ? 'danger' : 'default'}
      pending={decide.isPending}
      error={decide.error}
      fields={['reason', 'target']}
      onSubmit={() => {
        setSubmitted(true);
        if (client.reason || client.target) return;
        decide.mutate(
          {
            stream,
            keys,
            action,
            reason: reason.trim(),
            ...(mode === 'change' ? { target: target.trim() } : {}),
            ...(mode === 'no_target' ? { no_target: true } : {}),
          },
          {
            onSuccess: (out) => {
              onDecided(out, action, titles);
              onClose();
            },
          },
        );
      }}
    >
      {keys.length > 1 ? (
        <details>
          <summary className={s.small}>{keys.length} selected item(s)</summary>
          <ul className={styles.bullets}>
            {Object.entries(titles).map(([k, t]) => (
              <li key={k}>
                <Mono className={s.xs}>{t}</Mono>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {mode === 'change' ? (
        <Field
          label="Target column"
          required
          error={errors.target}
          help="schema.table.column, for example dbo.party.party_name. Two parts mean the dbo schema."
        >
          <Input
            mono
            value={target}
            maxLength={400}
            autoComplete="off"
            onChange={(e) => {
              setTarget(e.target.value);
              if (decide.error) decide.reset();
            }}
          />
        </Field>
      ) : null}
      <Field
        label="Reason"
        required
        error={errors.reason}
        help="At least 10 characters. It is recorded in the audit log."
      >
        <Textarea
          rows={3}
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
