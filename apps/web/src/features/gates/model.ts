import type { Gate, GateItem, GateItemKind, GateStatus } from '@/api/gates-types';
import type { FieldErrors } from '@/lib/forms';
import type { Tone } from '@/ui';
import { isDesignSection, type DesignSection } from '../design/model';
import type { LoadsSection } from '../loads/model';
import type { PlanSection } from '../plan/model';

// ---------- Sections and URL state ----------

export const GATES_SECTIONS = ['gates', 'packs', 'signing-key'] as const;
export type GatesSection = (typeof GATES_SECTIONS)[number];

export function isGatesSection(v: unknown): v is GatesSection {
  return typeof v === 'string' && (GATES_SECTIONS as readonly string[]).includes(v);
}

export const GATES_SECTION_LABELS: Record<GatesSection, string> = {
  gates: 'Gates',
  packs: 'Proof packs',
  'signing-key': 'Signing key',
};

/** The Gates and proof tab's view in the URL: section and the selected gate. */
export interface GatesSearch {
  section?: GatesSection;
  /** Gates section: the selected gate's key. */
  gate?: string;
}

// ---------- Labels ----------

const STATUS: Record<GateStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  passed: { label: 'Passed', tone: 'success' },
  changed_since_pass: { label: 'Changed since pass', tone: 'warning' },
};

export function gateStatus(status: string): { label: string; tone: Tone } {
  return (
    (STATUS as Record<string, { label: string; tone: Tone }>)[status] ?? {
      label: status,
      tone: 'neutral',
    }
  );
}

export const KIND_ORDER: readonly GateItemKind[] = ['evidence', 'control', 'attestation'];

export const KIND_INFO: Record<GateItemKind, { label: string; about: string }> = {
  evidence: {
    label: 'Evidence from the platform’s records',
    about: 'Met when the platform’s own records show it. Each item links to its record.',
  },
  control: {
    label: 'Compliance controls',
    about:
      'Controls of the blueprint’s compliance packs for this gate. A person attests each with evidence.',
  },
  attestation: {
    label: 'Attestations',
    about: 'Conditions no record can prove. A person attests each one.',
  },
};

export function shortDigest(digest: string, n = 12): string {
  return digest.length > n ? `${digest.slice(0, n)}…` : digest;
}

export function metCount(gate: Gate): { met: number; total: number } {
  return { met: gate.items.filter((i) => i.met).length, total: gate.items.length };
}

export function itemsByKind(items: GateItem[]): { kind: GateItemKind; items: GateItem[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
}

// ---------- Approval ----------

export interface ApproveState {
  /** Approver roles the caller can approve for now. */
  roles: { role: string; label: string }[];
  /** Why approving is not possible; null when it is. */
  reason: string | null;
  /** Unmet items, listed when the checklist is incomplete. */
  unmet: GateItem[];
}

/**
 * Mirrors the API's checks (gates.approve): a role the caller holds that is among the gate's
 * approvers, a complete checklist, one approval per person and per role on this digest.
 */
export function approveState(
  gate: Gate,
  myRoles: readonly string[],
  myId: string | null,
): ApproveState {
  const mine = gate.approvers.filter((a) => myRoles.includes(a.role));
  const done = new Set(gate.approvals.map((a) => a.role));
  const unmet = gate.items.filter((i) => !i.met);
  const none: ApproveState = { roles: [], reason: null, unmet: [] };
  if (mine.length === 0) {
    const names = gate.approvers.map((a) => a.label).join(', ');
    return {
      ...none,
      reason: `You hold none of this gate’s approver roles on this project (${names}).`,
    };
  }
  if (!gate.all_met) {
    return {
      ...none,
      unmet,
      reason: `The checklist is not complete: ${String(unmet.length)} item(s) are not met. Only a complete checklist can be approved.`,
    };
  }
  if (myId !== null && gate.approvals.some((a) => a.user_id === myId)) {
    return {
      ...none,
      reason: 'You approved this checklist already. Another person approves for each other role.',
    };
  }
  const open = mine.filter((a) => !done.has(a.role));
  if (open.length === 0) {
    return {
      ...none,
      reason:
        gate.status === 'passed'
          ? 'This checklist has passed: every required role has approved it.'
          : 'Each role you hold has already approved this checklist.',
    };
  }
  return { roles: open, reason: null, unmet: [] };
}

// ---------- Attestation ----------

export type AttestField = 'note' | 'reference';
export const NOTE_MIN = 10;
export const NOTE_MAX = 4000;
export const REFERENCE_MAX = 1000;

export function attestErrors(note: string, reference: string): FieldErrors<AttestField> {
  const out: FieldErrors<AttestField> = {};
  const n = note.trim().length;
  if (n === 0) out.note = 'Describe the evidence.';
  else if (n < NOTE_MIN)
    out.note = `Write at least ${String(NOTE_MIN)} characters (${String(n)} so far).`;
  else if (n > NOTE_MAX) out.note = `Keep it under ${String(NOTE_MAX)} characters.`;
  if (reference.trim().length > REFERENCE_MAX) {
    out.reference = `Keep the reference under ${String(REFERENCE_MAX)} characters.`;
  }
  return out;
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------- Where a source opens ----------

/** A project-page view (a subset of ProjectSearch, kept local to avoid an import cycle). */
export interface ProjectView {
  tab: 'versions' | 'plan' | 'design' | 'loads' | 'agents' | 'gates';
  version?: number;
  section?: PlanSection | DesignSection | LoadsSection | GatesSection;
  key?: string;
  artifact?: string;
  run?: string;
  parity_run?: string;
  agent_run?: string;
}

export type SourceTarget =
  { to: 'project'; search: ProjectView } | { to: 'discovery-run'; runId: string };

/**
 * Maps a record's API path (`source.href`) to the screen that shows it. Null when no screen
 * shows that record; the caller then shows the path itself.
 */
export function sourceTarget(href: string | null | undefined): SourceTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, 'http://local.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://local.invalid') return null;
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const q = url.searchParams;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const project = (search: ProjectView): SourceTarget => ({ to: 'project', search });

  if (parts[0] === 'discovery-runs' && parts[1]) return { to: 'discovery-run', runId: parts[1] };
  if (parts[0] === 'load-runs' && parts[1]) {
    return parts[2] === 'document-checks'
      ? project({ tab: 'loads', section: 'documents', run: parts[1] })
      : project({ tab: 'loads', section: 'runs', run: parts[1] });
  }
  if (parts[0] === 'agent-runs' && parts[1]) return project({ tab: 'agents', agent_run: parts[1] });
  if (parts[0] === 'parity-runs' && parts[1]) {
    return project({ tab: 'loads', section: 'parity', parity_run: parts[1] });
  }
  if (parts[0] !== 'projects' || !parts[1]) return null;
  const rest = parts.slice(2);
  switch (rest[0]) {
    case 'blueprint': {
      const n = Number(rest[2]);
      return rest[1] === 'versions' && Number.isInteger(n) && n > 0
        ? project({ tab: 'versions', version: n })
        : project({ tab: 'versions' });
    }
    case 'plan': {
      const sec = rest[1];
      if (sec === 'baselines') return project({ tab: 'plan', section: 'baselines' });
      if (sec === 'cutover' || sec === 'runbook')
        return project({ tab: 'plan', section: 'cutover' });
      if (sec === 'scope' || sec === 'items') return project({ tab: 'plan', section: 'scope' });
      if (sec === 'controls') return project({ tab: 'plan', section: 'controls' });
      if (sec === 'waves') return project({ tab: 'plan', section: 'waves' });
      return project({ tab: 'plan' });
    }
    case 'design': {
      const stream = q.get('stream');
      return isDesignSection(stream)
        ? project({ tab: 'design', section: stream, ...(rest[2] ? { key: rest[2] } : {}) })
        : project({ tab: 'design' });
    }
    case 'build-artifacts':
      return project({
        tab: 'design',
        section: 'build',
        ...(rest[1] ? { artifact: rest[1] } : {}),
      });
    case 'load-runs':
      return project({ tab: 'loads', section: 'runs' });
    case 'recon-breaks': {
      const run = q.get('load_run_id');
      return project({ tab: 'loads', section: 'breaks', ...(run ? { run } : {}) });
    }
    case 'parity-runs':
      return project({ tab: 'loads', section: 'parity' });
    case 'coexistence':
      return project({ tab: 'loads', section: 'coexistence' });
    case 'gates':
      return project({ tab: 'gates', section: 'gates' });
    default:
      return null;
  }
}

// ---------- Proof packs ----------

/** proof.py SECTIONS, in order. */
export const PACK_SECTIONS: { key: string; title: string }[] = [
  { key: 'configuration', title: 'Configuration' },
  { key: 'scope', title: 'Scope' },
  { key: 'lineage', title: 'Lineage' },
  { key: 'decisions', title: 'Decisions' },
  { key: 'controls', title: 'Controls and gates' },
  { key: 'tests', title: 'Tests' },
  { key: 'agents', title: 'Agent records' },
  { key: 'cutover', title: 'Cutover' },
  { key: 'decommission', title: 'Decommission' },
];

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
