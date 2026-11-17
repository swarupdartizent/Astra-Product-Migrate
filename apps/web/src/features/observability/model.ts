import type { Span, SummaryGroupBy } from '@/api/types';

export const GROUP_BY_OPTIONS: readonly { value: SummaryGroupBy; label: string }[] = [
  { value: 'category', label: 'Category' },
  { value: 'tenant', label: 'Tenant' },
  { value: 'name', label: 'Operation' },
  { value: 'stage', label: 'Stage' },
  { value: 'agent', label: 'Agent' },
  { value: 'project', label: 'Project' },
];

/** Human duration: "0.42 ms", "125 ms", "1.24 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** US dollars with enough precision for per-call model cost; null → em dash. */
export function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: usd < 1 ? 4 : 2,
    maximumFractionDigits: usd < 1 ? 4 : 2,
  }).format(usd);
}

/** Share of the largest value, 0–100, for proportional bars. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

// ---------- Trace waterfall ----------

export interface WaterfallRow {
  span: Span;
  /** Nesting level: 0 for roots. */
  depth: number;
  /** Milliseconds from the trace start to this span's start. */
  offsetMs: number;
  /** Left edge as a percentage of the trace duration. */
  offsetPct: number;
  /** Width as a percentage of the trace duration (never past the right edge). */
  widthPct: number;
}

export interface WaterfallLayout {
  rows: WaterfallRow[];
  /** From the earliest span start to the latest span end, in ms. */
  totalMs: number;
  startedAt: number;
}

/**
 * Lays spans out on a shared timeline: depth-first by parent, children in start order,
 * horizontal position by start time relative to the earliest span, width by duration.
 * Spans whose parent is not in the trace are treated as roots.
 */
export function layoutWaterfall(spans: readonly Span[]): WaterfallLayout {
  if (spans.length === 0) return { rows: [], totalMs: 0, startedAt: 0 };
  const start = (sp: Span) => new Date(sp.started_at).getTime();
  const t0 = Math.min(...spans.map(start));
  const end = Math.max(...spans.map((sp) => start(sp) + sp.duration_ms));
  const totalMs = Math.max(end - t0, 0);

  const ids = new Set(spans.map((sp) => sp.span_id));
  const children = new Map<string | null, Span[]>();
  for (const sp of spans) {
    const parent = sp.parent_span_id && ids.has(sp.parent_span_id) ? sp.parent_span_id : null;
    const list = children.get(parent) ?? [];
    list.push(sp);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => start(a) - start(b));

  const rows: WaterfallRow[] = [];
  const seen = new Set<string>();
  const visit = (sp: Span, depth: number) => {
    if (seen.has(sp.span_id)) return; // guard against malformed cycles
    seen.add(sp.span_id);
    const offsetMs = start(sp) - t0;
    const offsetPct = totalMs > 0 ? (offsetMs / totalMs) * 100 : 0;
    const rawWidth = totalMs > 0 ? (sp.duration_ms / totalMs) * 100 : 100;
    rows.push({
      span: sp,
      depth,
      offsetMs,
      offsetPct,
      widthPct: Math.max(0, Math.min(rawWidth, 100 - offsetPct)),
    });
    for (const child of children.get(sp.span_id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return { rows, totalMs, startedAt: t0 };
}
