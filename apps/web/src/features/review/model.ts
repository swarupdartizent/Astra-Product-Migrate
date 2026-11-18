import type {
  ReviewDecideOut,
  ReviewAction,
  ReviewEvidence,
  ReviewItem,
  ReviewQueueQuery,
  ReviewStatusFilter,
} from '@/api/types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';

// ---------- URL state ----------

/** The review workbench's view, kept in the URL so a link opens the same view. */
export interface ReviewSearch {
  /** The selected review item. */
  item?: string;
  status?: ReviewStatusFilter;
  stream?: string;
  segment?: string;
  agent?: string;
  kind?: string;
  risk?: string;
  compliance?: string;
  owner_role?: string;
  pattern?: string;
  mine?: boolean;
  q?: string;
  offset?: number;
}

export const REVIEW_STATUS_FILTERS: readonly { value: ReviewStatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'decided', label: 'Decided' },
  { value: 'all', label: 'All' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'dismissed', label: 'Dismissed' },
];

const STRING_KEYS = [
  'item',
  'stream',
  'segment',
  'agent',
  'kind',
  'risk',
  'compliance',
  'owner_role',
  'pattern',
  'q',
] as const;

/** Reads the review search params from an untrusted URL; unknown values are dropped. */
export function parseReviewSearch(raw: Record<string, unknown>): ReviewSearch {
  const out: ReviewSearch = {};
  for (const k of STRING_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim() && v.length <= 200) out[k] = v;
    else if (typeof v === 'number' && k !== 'q') out[k] = String(v);
  }
  if (REVIEW_STATUS_FILTERS.some((f) => f.value === raw.status)) {
    out.status = raw.status as ReviewStatusFilter;
  }
  if (raw.mine === true || raw.mine === 'true') out.mine = true;
  const offset = Number(raw.offset);
  if (Number.isInteger(offset) && offset > 0) out.offset = offset;
  return out;
}

export const QUEUE_PAGE = 25;

/** The queue request for a view. */
export function queueQuery(s: ReviewSearch): ReviewQueueQuery {
  const q: ReviewQueueQuery = {
    status: s.status ?? 'open',
    offset: s.offset ?? 0,
    limit: QUEUE_PAGE,
  };
  if (s.stream) q.stream = s.stream;
  if (s.segment) q.segment = s.segment;
  if (s.agent) q.agent = s.agent;
  if (s.kind) q.kind = s.kind;
  if (s.risk) q.risk = s.risk;
  if (s.compliance) q.compliance = s.compliance;
  if (s.owner_role) q.owner_role = s.owner_role;
  if (s.pattern) q.pattern_key = s.pattern;
  if (s.mine) q.mine = true;
  if (s.q?.trim()) q.q = s.q.trim();
  return q;
}

/** Filters that narrow the queue beyond the status. */
export function activeFilterCount(s: ReviewSearch): number {
  return (
    (
      [
        'stream',
        'segment',
        'agent',
        'kind',
        'risk',
        'compliance',
        'owner_role',
        'pattern',
        'q',
      ] as const
    ).filter((k) => !!s[k]).length + (s.mine ? 1 : 0)
  );
}

// ---------- Labels ----------

export const RISK_INFO: Record<string, { label: string; tone: Tone }> = {
  low: { label: 'Low risk', tone: 'neutral' },
  medium: { label: 'Medium risk', tone: 'info' },
  high: { label: 'High risk', tone: 'warning' },
  critical: { label: 'Critical risk', tone: 'danger' },
};

export function riskInfo(risk: string) {
  return RISK_INFO[risk] ?? { label: `${risk} risk`, tone: 'neutral' as Tone };
}

export const COMPLIANCE_INFO: Record<string, { label: string; tone: Tone }> = {
  none: { label: 'No compliance impact', tone: 'neutral' },
  relevant: { label: 'Compliance relevant', tone: 'info' },
  critical: { label: 'Compliance critical', tone: 'danger' },
};

export function complianceInfo(c: string) {
  return COMPLIANCE_INFO[c] ?? { label: `Compliance ${c}`, tone: 'neutral' as Tone };
}

export const OUTCOME_LABELS: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  changed: 'Changed',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
  changes_requested: 'Changes requested',
  unknown: 'Unknown',
};

export function outcomeLabel(o: string): string {
  return OUTCOME_LABELS[o] ?? o.replace(/_/g, ' ');
}

export function outcomeTone(o: string): Tone {
  if (o === 'approved' || o === 'resolved') return 'success';
  if (o === 'rejected') return 'danger';
  if (o === 'changed' || o === 'changes_requested') return 'info';
  return 'neutral';
}

/** "62%", or "Not stated" (rules state no confidence). */
export function formatConfidence(c: number | null): string {
  return c === null ? 'Not stated' : `${String(Math.round(c * 100))}%`;
}

/** Compact age: "40 min", "5 h", "3 d". */
export function ageOf(created: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(created).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'new';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${String(Math.max(min, 1))} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${String(h)} h`;
  return `${String(Math.floor(h / 24))} d`;
}

/** "kind_name" → "Kind name". */
export function humanizeKey(key: string): string {
  const w = key.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// ---------- Decisions ----------

/** A change goes back to the agent only when an agent raised the item from a run. */
export function changeGoesToAgent(item: ReviewItem): boolean {
  return item.requested_by_type === 'agent' && item.agent_run_id !== null;
}

/** No agent raised it, so the reviewer's changed answer is the decision. */
export function needsChangedValue(item: ReviewItem): boolean {
  return !changeGoesToAgent(item);
}

/** Why a change cannot be recorded on this item (the API refuses it), or null. */
export function changeBlockedReason(item: ReviewItem): string | null {
  if (!changeGoesToAgent(item) && item.required_approvals > 1) {
    return 'Two people must approve this item, so its answer cannot be changed here. Approve one of its options, or reject it with a reason.';
  }
  return null;
}

/** The option the first approver chose, which a second approver must match. */
export function firstApprovedOption(item: ReviewItem): string | null {
  return item.approvals[0]?.option ?? null;
}

export interface DecisionForm {
  action: ReviewAction | '';
  option: string;
  note: string;
  changedValue: string;
}

export type DecisionField = 'action' | 'option' | 'note' | 'changed_value';

/** Mirrors the API's rules so the reviewer sees problems before submitting. */
export function validateDecision(f: DecisionForm, item: ReviewItem): FieldErrors<DecisionField> {
  const e: FieldErrors<DecisionField> = {};
  const note = f.note.trim().length;
  if (!f.action) {
    e.action = 'Choose a decision.';
    return e;
  }
  if (f.action === 'approve') {
    if (!item.options.includes(f.option)) e.option = 'Choose one of the options.';
    const first = firstApprovedOption(item);
    if (first && f.option && f.option !== first) {
      e.option = `The first approver chose “${first}”. Approve the same option, or reject the item with a reason.`;
    }
  } else if (note < 10) {
    e.note = `Give a reason (at least 10 characters, ${String(note)} so far).`;
  }
  if (f.action === 'change') {
    const blocked = changeBlockedReason(item);
    if (blocked) e.action = blocked;
    else if (needsChangedValue(item) && !f.changedValue.trim()) {
      e.changed_value =
        'Give the changed answer: no agent raised this item, so your answer is the decision.';
    }
  }
  return e;
}

/** What the API recorded, in words. */
export function recordedMessage(out: ReviewDecideOut): { tone: 'success' | 'info'; text: string } {
  const it = out.item;
  switch (out.recorded) {
    case 'approval_recorded': {
      const n = it.approvals.length;
      const left = Math.max(it.required_approvals - n, 1);
      return {
        tone: 'info',
        text: `Your approval is recorded — ${String(n)} of ${String(it.required_approvals)}; ${
          left === 1 ? 'a second person must approve' : `${String(left)} more people must approve`
        } before the item is resolved.`,
      };
    }
    case 'approved':
      return {
        tone: 'success',
        text: `Approved: “${it.resolution ?? ''}”. ${
          it.required_approvals > 1
            ? `All ${String(it.required_approvals)} approvals are in; the item is resolved.`
            : 'The item is resolved.'
        }`,
      };
    case 'rejected':
      return { tone: 'success', text: 'Rejected. The item is closed with your reason.' };
    case 'changed':
      return {
        tone: 'success',
        text: `Your changed answer is the decision: “${it.changed_value ?? it.resolution ?? ''}”. The item is resolved.`,
      };
    case 'changes_requested':
      return {
        tone: 'info',
        text: 'Changes requested. The agent that raised the item is asked to revise its work with your note.',
      };
    case 'dismissed':
      return { tone: 'success', text: 'Dismissed with your reason.' };
    default:
      return { tone: 'info', text: `Recorded: ${out.recorded.replace(/_/g, ' ')}.` };
  }
}

export const ACTION_SUBMIT: Record<ReviewAction, string> = {
  approve: 'Approve',
  reject: 'Reject item',
  change: 'Record change',
  dismiss: 'Dismiss item',
};

// ---------- Evidence links ----------

export type EvidenceTarget =
  | {
      to: 'project';
      search: {
        tab: 'conversion' | 'delta' | 'agents';
        run?: string;
        object?: string;
        agent_run?: string;
      };
      /** The screen opens near the object but cannot target it exactly. */
      gap?: string;
    }
  | { to: 'discovery-run'; runId: string; gap?: string };

/** Where an evidence link opens, on the existing screens. Null when the kind is unknown. */
export function evidenceTarget(ev: ReviewEvidence): EvidenceTarget | null {
  const run = ev.ref.run_id;
  switch (ev.kind) {
    case 'conversion_object':
      return run
        ? {
            to: 'project',
            search: { tab: 'conversion', run, ...(ev.ref.name ? { object: ev.ref.name } : {}) },
          }
        : null;
    case 'conversion_run':
      return run ? { to: 'project', search: { tab: 'conversion', run } } : null;
    case 'delta_run':
      return run ? { to: 'project', search: { tab: 'delta', run } } : null;
    case 'discovery_run':
      return run ? { to: 'discovery-run', runId: run } : null;
    case 'agent_run':
      return run ? { to: 'project', search: { tab: 'agents', agent_run: run } } : null;
    default:
      return null;
  }
}

export const EVIDENCE_KIND_LABELS: Record<string, string> = {
  conversion_object: 'Converted object',
  conversion_run: 'Conversion run',
  delta_run: 'Version delta run',
  discovery_run: 'Discovery run',
  agent_run: 'Agent run',
};
