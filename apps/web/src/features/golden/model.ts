import { stringify } from 'yaml';
import type { GoldenMeasure } from '@/api/types';
import type { Tone } from '@/ui';

export const GOLDEN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  passed: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
};

export function goldenStatus(status: string) {
  return GOLDEN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

/** "adapter@1.0.0:name" → parts for the files endpoint. */
export function parseDataset(
  dataset: string,
): { adapter: string; version: string; name: string } | null {
  const m = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+):([a-z][a-z0-9-]*)$/.exec(dataset);
  if (!m) return null;
  const [, adapter = '', version = '', name = ''] = m;
  return { adapter, version, name };
}

/** Failing measures first, then by name. */
export function orderMeasures(measures: readonly GoldenMeasure[]): GoldenMeasure[] {
  return [...measures].sort((a, b) =>
    a.passed === b.passed ? a.name.localeCompare(b.name) : a.passed ? 1 : -1,
  );
}

/** Expected / actual values: scalars as text, structures as compact YAML. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stringify(value, { lineWidth: 0 }).trim();
}

export function formatRatio(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(value === 1 ? 0 : 1)}%`;
}

/** Readable section titles for expected.yaml keys. */
export function sectionTitle(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
