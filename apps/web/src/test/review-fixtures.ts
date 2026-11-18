import type { ReviewItem, ReviewQueue, ReviewWorkbench } from '@/api/types';

// Test fixtures only: shapes follow /api/v1 (review workbench, I8); values are synthetic.

export function reviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'r1',
    project_id: 'pr1',
    kind: 'decision',
    title: 'Fixture review item',
    question: 'Which option applies?',
    options: ['Keep', 'Drop'],
    context: {},
    owner_role: 'migration_lead',
    owner_role_label: 'Migration lead',
    owner_user: null,
    requested_by: 'Fixture rule',
    requested_by_type: 'system',
    agent_run_id: null,
    status: 'open',
    resolution: null,
    resolution_note: null,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-11-15T10:00:00Z',
    can_resolve: true,
    cannot_resolve_reason: null,
    flagged_text: null,
    stream: 'data',
    segment: 'table',
    subject_type: 'decision',
    risk: 'medium',
    confidence: null,
    compliance: 'none',
    compliance_controls: [],
    required_approvals: 1,
    approvals: [],
    owner_user_id: null,
    agent: null,
    pattern_key: null,
    evidence: [],
    outcome: null,
    changed_value: null,
    follow_up_run_id: null,
    priority: 210,
    priority_reasons: ['medium risk', 'confidence not stated'],
    can_assign_reviewer: false,
    ...overrides,
  };
}

export function reviewQueue(
  items: ReviewItem[],
  overrides: Partial<ReviewQueue> = {},
): ReviewQueue {
  return {
    items,
    total: items.length,
    facets: {},
    groups: [],
    can_decide_any: true,
    ...overrides,
  };
}

export function reviewWorkbench(
  item: ReviewItem,
  overrides: Partial<ReviewWorkbench> = {},
): ReviewWorkbench {
  return {
    item,
    why: ['Raised by Fixture rule (system) on 15 Nov 2026 10:00 UTC.'],
    samples: null,
    precedents: { pattern_key: item.pattern_key, items: [], outcomes: {} },
    assistant: {
      agent: 'review-assistant',
      pinned_version: '1.0.0',
      can_ask: true,
      unavailable_reason: null,
    },
    assistant_runs: [],
    reviewers: [],
    ...overrides,
  };
}
