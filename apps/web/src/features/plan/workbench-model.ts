import { isApiError } from '@/api/errors';
import type { PlanTask, WorkbenchEdit, WorkbenchItem } from '@/api/planning-types';
import type { FieldErrors } from '@/lib/forms';
import { humanize, minLength } from './model';

/** An edit waiting to be applied, with a stable id for list keys and error mapping. */
export interface PendingEdit {
  id: number;
  edit: WorkbenchEdit;
}

/** Adds an edit, replacing an earlier pending edit of the same thing (the last word wins). */
export function upsertEdit(list: PendingEdit[], edit: WorkbenchEdit, id: number): PendingEdit[] {
  const same = (e: WorkbenchEdit): boolean => {
    if (e.op !== edit.op) {
      // Adding then removing the same new dependency cancels out below.
      return false;
    }
    switch (edit.op) {
      case 'move':
        return e.op === 'move' && e.scope_key === edit.scope_key;
      case 'task':
        return e.op === 'task' && e.key === edit.key;
      case 'remove_dependency':
        return e.op === 'remove_dependency' && e.key === edit.key;
      case 'add_dependency':
        return e.op === 'add_dependency' && e.src === edit.src && e.dst === edit.dst;
    }
  };
  const rest = list.filter((p) => !same(p.edit));
  return [...rest, { id, edit }];
}

/** The pending wave for an item: undefined when no move is pending, null for "unpin". */
export function pendingWave(list: PendingEdit[], scopeKey: string): string | null | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]?.edit;
    if (e?.op === 'move' && e.scope_key === scopeKey) return e.wave;
  }
  return undefined;
}

export function pendingTask(
  list: PendingEdit[],
  key: string,
): Extract<WorkbenchEdit, { op: 'task' }> | undefined {
  for (const p of list) if (p.edit.op === 'task' && p.edit.key === key) return p.edit;
  return undefined;
}

/** A sentence for each pending edit. */
export function describeEdit(e: WorkbenchEdit, name: (scopeKey: string) => string): string {
  switch (e.op) {
    case 'move':
      return e.wave === null
        ? `Unpin ${name(e.scope_key)}: let the solver place it`
        : `Pin ${name(e.scope_key)} to wave ${e.wave}`;
    case 'add_dependency':
      return `Add: ${name(e.src)} depends on ${name(e.dst)} (“${e.reason}”)`;
    case 'remove_dependency': {
      const [src, dst] = e.key.split('->');
      return `Remove: ${name(src ?? e.key)} depends on ${name(dst ?? '')} (“${e.reason}”)`;
    }
    case 'task': {
      const parts: string[] = [];
      if (e.role) parts.push(`role ${humanize(e.role)}`);
      for (const k of ['low', 'likely', 'high'] as const) {
        const v = e[k];
        if (v !== undefined) parts.push(`${k} ${v.toLocaleString()} h`);
      }
      return `Change task ${e.key}: ${parts.join(', ')} (“${e.reason}”)`;
    }
  }
}

const EDIT_FIELD = /^edits\.(\d+)\.(?:(?:move|add_dependency|remove_dependency|task)\.)?(.+)$/;

/**
 * Maps a 422 from POST /plan/workbench/edits onto the pending edits: the API names the edit as
 * `edits.{n}.{field}` (request validation adds the edit kind: `edits.{n}.task.reason`).
 */
export function editErrors(
  error: unknown,
  pending: PendingEdit[],
): { byId: Map<number, string>; other: string[] } {
  const byId = new Map<number, string>();
  const other: string[] = [];
  if (!isApiError(error) || error.status !== 422) return { byId, other };
  for (const fe of error.fieldErrorList) {
    const m = EDIT_FIELD.exec(fe.field);
    const p = m ? pending[Number(m[1])] : undefined;
    if (m && p) {
      const field = m[2] ?? '';
      const text = `${humanize(field.replace(/\./g, ' '))}: ${fe.message}`;
      byId.set(p.id, byId.has(p.id) ? `${byId.get(p.id) ?? ''} ${text}` : text);
    } else other.push(fe.field ? `${fe.field}: ${fe.message}` : fe.message);
  }
  return { byId, other };
}

// ---------- Task edit ----------

export interface TaskEditForm {
  role: string;
  low: string;
  likely: string;
  high: string;
  reason: string;
}

export function taskForm(t: PlanTask): TaskEditForm {
  const n = (v: number | null) => (v === null ? '' : String(v));
  return { role: t.role, low: n(t.low), likely: n(t.likely), high: n(t.high), reason: '' };
}

type TaskField = 'role' | 'low' | 'likely' | 'high' | 'reason';

/** Mirrors the API: low ≤ likely ≤ high, likely within the largest task, a 10-character reason. */
export function validateTaskEdit(
  f: TaskEditForm,
  t: PlanTask,
  maxTaskHours: number | null,
): { errors: FieldErrors<TaskField>; edit: Extract<WorkbenchEdit, { op: 'task' }> | null } {
  const errors: FieldErrors<TaskField> = {};
  const num = (k: 'low' | 'likely' | 'high'): number | null => {
    const v = f[k].trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors[k] = 'Enter zero or more hours.';
      return null;
    }
    return n;
  };
  const low = num('low');
  const likely = num('likely');
  const high = num('high');
  const lo = low ?? t.low;
  const li = likely ?? t.likely;
  const hi = high ?? t.high;
  if (!errors.low && !errors.likely && !errors.high && lo !== null && li !== null && hi !== null) {
    if (!(lo <= li && li <= hi)) errors.likely = 'An estimate needs low ≤ likely ≤ high.';
  }
  if (!errors.likely && li !== null && maxTaskHours !== null && li > maxTaskHours) {
    errors.likely = `Tasks are at most ${String(maxTaskHours)} hours (likely). Split the work instead.`;
  }
  const r = minLength(f.reason, 10, 'Say why');
  if (r) errors.reason = r;
  const edit: Extract<WorkbenchEdit, { op: 'task' }> = {
    op: 'task',
    key: t.key,
    reason: f.reason.trim(),
  };
  if (f.role && f.role !== t.role) edit.role = f.role;
  if (low !== null && low !== t.low) edit.low = low;
  if (likely !== null && likely !== t.likely) edit.likely = likely;
  if (high !== null && high !== t.high) edit.high = high;
  const changed =
    edit.role !== undefined ||
    edit.low !== undefined ||
    edit.likely !== undefined ||
    edit.high !== undefined;
  if (!changed && Object.keys(errors).length === 0)
    errors.role = 'Change the role or the estimate.';
  return { errors, edit: Object.keys(errors).length === 0 ? edit : null };
}

// ---------- Graph layout ----------

export interface GraphNode {
  key: string;
  label: string;
  depth: number;
  x: number;
  y: number;
  cycle: boolean;
}

export const NODE_W = 184;
export const NODE_H = 40;
const COL_GAP = 72;
const ROW_GAP = 14;
const PAD = 16;

/** Columns by dependency depth, rows in key order. */
export function layoutGraph(
  items: WorkbenchItem[],
  inCycle: Set<string>,
  limit: number,
): { nodes: GraphNode[]; width: number; height: number; truncated: number } {
  const sorted = [...items].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  const shown = sorted.slice(0, limit);
  const rows = new Map<number, number>();
  const nodes = shown.map((it) => {
    const row = rows.get(it.depth) ?? 0;
    rows.set(it.depth, row + 1);
    return {
      key: it.key,
      label: it.element,
      depth: it.depth,
      x: PAD + it.depth * (NODE_W + COL_GAP),
      y: PAD + row * (NODE_H + ROW_GAP),
      cycle: inCycle.has(it.key),
    };
  });
  const maxDepth = Math.max(0, ...shown.map((n) => n.depth));
  const maxRows = Math.max(1, ...rows.values());
  return {
    nodes,
    width: PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * COL_GAP,
    height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP,
    truncated: sorted.length - shown.length,
  };
}

/** "dbo.very_long_table_name" → "dbo.very_long_tabl…" for a node label. */
export function shorten(label: string, max = 24): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** Position of a date between the first start and the last end, as a percentage. */
export function datePct(date: string | null, min: number, max: number): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (!Number.isFinite(t) || max <= min) return null;
  return Math.min(100, Math.max(0, ((t - min) / (max - min)) * 100));
}
