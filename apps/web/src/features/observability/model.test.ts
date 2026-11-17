import { describe, expect, it } from 'vitest';
import type { Span } from '@/api/types';
import { barPercent, formatCost, formatDuration, layoutWaterfall } from './model';

function span(id: string, parent: string | null, startMs: number, duration: number): Span {
  return {
    span_id: id,
    parent_span_id: parent,
    name: id,
    category: 'http',
    started_at: new Date(Date.UTC(2026, 10, 17, 12, 0, 0) + startMs).toISOString(),
    duration_ms: duration,
    status: 'ok',
    stage: null,
    agent: null,
    model: null,
    cost_usd: null,
    attributes: {},
  };
}

describe('layoutWaterfall', () => {
  it('positions spans relative to the trace start and nests children depth-first', () => {
    const spans = [
      span('db2', 'handler', 60, 20),
      span('root', null, 0, 100),
      span('handler', 'root', 10, 80),
      span('db1', 'handler', 20, 30),
    ];
    const { rows, totalMs } = layoutWaterfall(spans);
    expect(totalMs).toBe(100);
    expect(rows.map((r) => [r.span.span_id, r.depth])).toEqual([
      ['root', 0],
      ['handler', 1],
      ['db1', 2],
      ['db2', 2],
    ]);
    const db1 = rows[2]!;
    expect(db1.offsetMs).toBe(20);
    expect(db1.offsetPct).toBeCloseTo(20);
    expect(db1.widthPct).toBeCloseTo(30);
  });

  it('treats spans with a missing parent as roots and never overflows the timeline', () => {
    const { rows, totalMs } = layoutWaterfall([
      span('a', null, 0, 50),
      span('orphan', 'not-in-trace', 40, 100),
    ]);
    expect(totalMs).toBe(140);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
    for (const row of rows) expect(row.offsetPct + row.widthPct).toBeLessThanOrEqual(100.0001);
  });

  it('handles empty and zero-length traces', () => {
    expect(layoutWaterfall([])).toEqual({ rows: [], totalMs: 0, startedAt: 0 });
    const { rows } = layoutWaterfall([span('only', null, 0, 0)]);
    expect(rows[0]?.offsetPct).toBe(0);
    expect(rows[0]?.widthPct).toBe(100);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0.4)).toBe('0.40 ms');
    expect(formatDuration(125.4)).toBe('125 ms');
    expect(formatDuration(1240)).toBe('1.24 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });

  it('shows an em dash for unknown cost', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(0.0123)).toBe('$0.0123');
  });

  it('computes bar widths against the maximum', () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(0, 200)).toBe(0);
    expect(barPercent(10, 0)).toBe(0);
  });
});
