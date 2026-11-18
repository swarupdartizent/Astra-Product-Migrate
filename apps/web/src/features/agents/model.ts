import type { AgentTestRun, GovernanceRecord, TestCaseResult } from '@/api/types';
import type { Tone } from '@/ui';

export const AGENT_TABS = ['registry', 'catalogue', 'readiness', 'governance', 'lab'] as const;
export type AgentsTab = (typeof AGENT_TABS)[number];

export const VERSION_TABS = ['overview', 'tests', 'manifest', 'governance'] as const;
export type VersionTab = (typeof VERSION_TABS)[number];

export const AGENT_VERSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'info' },
  released: { label: 'Released', tone: 'success' },
  deprecated: { label: 'Deprecated', tone: 'neutral' },
};

export function agentVersionStatus(status: string) {
  return AGENT_VERSION_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

/** Test run and test case statuses. Blocked is never shown as failed: it means a missing input. */
export const TEST_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  passed: { label: 'Passed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
};

export function testStatus(status: string | null | undefined) {
  if (!status) return { label: 'Not run', tone: 'neutral' as Tone };
  return TEST_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
}

export const CASE_KIND_LABELS: Record<string, string> = {
  tool_policy: 'Tool policy',
  screening: 'Screening',
  model: 'Model',
};

export const RISK_TONE: Record<string, Tone> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

/** "4 passed, 1 blocked of 5" from a run summary; the note when the run did not execute. */
export function summaryText(run: Pick<AgentTestRun, 'summary' | 'status'>): string {
  const s = run.summary;
  if (typeof s.note === 'string') return s.note;
  const n = (k: string) => (typeof s[k] === 'number' ? s[k] : 0);
  const total = n('total');
  if (!total)
    return run.status === 'queued' || run.status === 'running' ? 'In progress' : 'No results';
  const parts = [`${n('passed')} passed`];
  if (n('failed')) parts.push(`${n('failed')} failed`);
  if (n('blocked')) parts.push(`${n('blocked')} blocked`);
  return `${parts.join(', ')} of ${total}`;
}

/** Results grouped for display: blocked first (they need an input), then failed, then passed. */
export function orderCases(results: readonly TestCaseResult[]): TestCaseResult[] {
  const rank: Record<string, number> = { blocked: 0, failed: 1, passed: 2 };
  return [...results].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
}

export function isTestRunActive(status: string): boolean {
  return status === 'queued' || status === 'running';
}

export const EFFECT_WORDS: Record<string, string> = {
  read: 'Reads data',
  propose: 'Proposes for review',
  delegate: 'Asks another agent',
  record: 'Records a finding',
};

export function effectLabel(effect: string): string {
  return EFFECT_WORDS[effect] ?? effect.replace(/_/g, ' ');
}

/** Pretty JSON for a governance download. */
export function governanceJson(records: readonly GovernanceRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/** Parses validation field paths such as "tools.6" or "tests.3.expect.must_call". */
export function describeFieldPath(path: string): string {
  const parts = path.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i] ?? '';
    const next = parts[i + 1];
    if (next !== undefined && /^\d+$/.test(next)) {
      out.push(`${p} #${Number(next) + 1}`);
      i += 1;
    } else {
      out.push(p);
    }
  }
  return out.join(' › ');
}
