import { isApiError } from '@/api/errors';
import type { RunEvent, StageStatus } from '@/api/types';
import type { Tone } from '@/ui';

export const STAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'warning' },
  done: { label: 'Done', tone: 'success' },
};

export const STAGE_STATUS_OPTIONS: readonly { value: StageStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];

export function stageStatus(status: string) {
  return STAGE_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

/** The reasons a stage gate gave for refusing a change (409 /problems/gate-closed). */
export function gateRefusal(error: unknown): string[] | null {
  if (!isApiError(error) || !error.problem.type.endsWith('/gate-closed')) return null;
  const reasons = error.fieldErrorList.map((e) => e.message);
  return reasons.length > 0 ? reasons : [error.detail ?? error.title];
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  stopped: { label: 'Stopped', tone: 'warning' },
};

export function runStatus(status: string) {
  return RUN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export const REVIEW_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warning' },
  resolved: { label: 'Resolved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  changes_requested: { label: 'Changes requested', tone: 'info' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
};

export function reviewStatus(status: string) {
  return REVIEW_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export function actorLabel(type: string | null | undefined): string {
  if (type === 'agent') return 'Agent';
  if (type === 'system') return 'System';
  return 'Person';
}

export interface TimelineEntry {
  seq: number;
  kind: string;
  title: string;
  /** Plain text to show; never rendered as HTML. */
  text: string | null;
  /** Structured details (tool input/output), shown as JSON text. */
  data: unknown;
  tone: Tone;
  at: string;
}

/** A payload value as display text (strings as-is, anything else as JSON). */
function txt(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined || v === null || v === '') return fallback;
  return JSON.stringify(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Turns transcript events into readable timeline entries. */
export function timeline(events: readonly RunEvent[]): TimelineEntry[] {
  return events.map((e) => {
    const p = e.payload;
    const base = { seq: e.seq, kind: e.kind, at: e.created_at };
    switch (e.kind) {
      case 'model_request':
        return {
          ...base,
          title: 'Request to the model',
          text: str(p.first_message),
          data: Array.isArray(p.tools) && p.tools.length ? { tools_offered: p.tools } : null,
          tone: 'neutral',
        };
      case 'model_response': {
        const calls = Array.isArray(p.tool_calls) ? p.tool_calls : [];
        return {
          ...base,
          title: `Model answered${str(p.model) ? ` (${String(p.model)})` : ''}${calls.length ? `, asking for ${calls.length} tool call${calls.length === 1 ? '' : 's'}` : ''}`,
          text: str(p.text),
          data: calls.length ? calls : null,
          tone: 'info',
        };
      }
      case 'tool_call':
        return {
          ...base,
          title: `Tool call: ${txt(p.name, '?')}`,
          text: null,
          data: p.input ?? null,
          tone: 'neutral',
        };
      case 'tool_result':
        return {
          ...base,
          title: `Tool result: ${txt(p.name, '?')} (${txt(p.outcome, 'ok')})`,
          text: str(p.content),
          data: null,
          tone: p.outcome === 'ok' || p.outcome === undefined ? 'success' : 'warning',
        };
      case 'guardrail':
        return {
          ...base,
          title:
            p.rule === 'tool_not_allowed'
              ? `Guardrail refused a tool call: ${txt(p.tool, '?')}`
              : p.rule === 'screening_flag'
                ? `Guardrail flagged input from ${txt(p.source, 'legacy data')}`
                : `Guardrail: ${txt(p.rule, '?')}`,
          text: null,
          data: Array.isArray(p.findings) ? { findings: p.findings } : null,
          tone: 'warning',
        };
      case 'error':
        return {
          ...base,
          title: `Error${str(p.code) ? ` (${String(p.code)})` : ''}`,
          text: str(p.message),
          data: null,
          tone: 'danger',
        };
      default:
        return { ...base, title: e.kind, text: null, data: p, tone: 'neutral' };
    }
  });
}
