import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/errors';
import type { RunEvent } from '@/api/types';
import { holdsAny } from '@/app/navigation';
import { describeFieldPath, orderCases, summaryText, testStatus } from './agents/model';
import {
  formatUsd,
  priceRows,
  providerToForm,
  validateAlias,
  validateProvider,
} from './models/model';
import { gateRefusal, timeline, validateResolve } from './runtime/model';

describe('provider form', () => {
  const base = { ...providerToForm(null), name: 'Primary', kind: 'anthropic' as const };

  it('needs a terms reference when no-training terms are claimed', () => {
    expect(validateProvider(base)).toEqual({});
    expect(validateProvider({ ...base, no_training_terms: true }).terms_reference).toMatch(
      /where the no-training terms/,
    );
    expect(
      validateProvider({
        ...base,
        no_training_terms: true,
        terms_reference: 'Enterprise order form, clause 9',
      }),
    ).toEqual({});
  });

  it('needs an HTTPS endpoint for Foundry and Azure OpenAI', () => {
    expect(validateProvider({ ...base, kind: 'azure_openai' }).endpoint).toMatch(
      /needs its endpoint/,
    );
    expect(
      validateProvider({ ...base, endpoint: 'http://insecure.example.test' }).endpoint,
    ).toMatch(/HTTPS/);
  });

  it('formats prices and unknown cost', () => {
    expect(formatUsd(null)).toBe('Price not configured');
    expect(formatUsd(4)).toBe('$4.00');
    expect(
      priceRows({
        'b-model': { input: 1, output: 2, cache_read: 0, cache_write: 0 },
        'a-model': { input: 3, output: 4, cache_read: 0, cache_write: 0 },
      }).map((r) => r.model),
    ).toEqual(['a-model', 'b-model']);
  });

  it('validates aliases', () => {
    const ok = {
      alias: 'reasoning-default',
      provider_id: 'p1',
      model: 'model-x',
      description: '',
      reason: 'Initial setup',
    };
    expect(validateAlias(ok)).toEqual({});
    expect(validateAlias({ ...ok, alias: 'Bad Alias' }).alias).toBeDefined();
    expect(validateAlias({ ...ok, reason: 'no' }).reason).toMatch(/at least 5/);
  });
});

describe('agent tests', () => {
  it('never reports blocked as failed, and lists blocked cases first', () => {
    expect(testStatus('blocked')).toEqual({ label: 'Blocked', tone: 'warning' });
    expect(testStatus(null).label).toBe('Not run');
    const ordered = orderCases([
      { name: 'a', kind: 'tool_policy', status: 'passed', detail: '' },
      { name: 'b', kind: 'model', status: 'blocked', detail: 'No alias' },
      { name: 'c', kind: 'screening', status: 'failed', detail: '' },
    ]);
    expect(ordered.map((c) => c.status)).toEqual(['blocked', 'failed', 'passed']);
    expect(
      summaryText({ status: 'blocked', summary: { total: 5, passed: 4, failed: 0, blocked: 1 } }),
    ).toBe('4 passed, 1 blocked of 5');
    expect(
      summaryText({
        status: 'error',
        summary: { note: 'The manifest changed before the suite ran.' },
      }),
    ).toMatch(/manifest changed/);
  });

  it('describes manifest field paths', () => {
    expect(describeFieldPath('tools.6')).toBe('tools #7');
    expect(describeFieldPath('tests.3.expect.must_call')).toBe('tests #4 › expect › must_call');
  });
});

describe('runtime', () => {
  it('turns transcript events into readable entries without interpreting text', () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        kind: 'model_request',
        payload: { first_message: 'Map the tables', tools: ['read_schema'] },
        created_at: '2026-11-18T10:00:00Z',
      },
      {
        seq: 2,
        kind: 'model_response',
        payload: {
          text: '<script>x</script>',
          tool_calls: [{ id: '1', name: 'read_schema', input: {} }],
          model: 'm-1',
        },
        created_at: '2026-11-18T10:00:01Z',
      },
      {
        seq: 3,
        kind: 'guardrail',
        payload: { rule: 'tool_not_allowed', tool: 'write_target' },
        created_at: '2026-11-18T10:00:02Z',
      },
      {
        seq: 4,
        kind: 'error',
        payload: { code: 'alias-missing', message: "Alias 'x' does not exist" },
        created_at: '2026-11-18T10:00:03Z',
      },
    ];
    const t = timeline(events);
    expect(t[0]?.title).toBe('Request to the model');
    expect(t[1]?.title).toBe('Model answered (m-1), asking for 1 tool call');
    expect(t[1]?.text).toBe('<script>x</script>');
    expect(t[2]).toMatchObject({
      title: 'Guardrail refused a tool call: write_target',
      tone: 'warning',
    });
    expect(t[3]).toMatchObject({ title: 'Error (alias-missing)', tone: 'danger' });
  });

  it('requires an option to resolve and a 10-character note to dismiss', () => {
    expect(validateResolve('resolve', '', '', ['Keep', 'Drop'])).toEqual({
      resolution: 'Choose one of the options.',
    });
    expect(validateResolve('resolve', 'Keep', '', ['Keep', 'Drop'])).toEqual({});
    expect(validateResolve('dismiss', '', 'short', ['Keep']).note).toMatch(/at least 10/);
    expect(validateResolve('dismiss', '', 'Not a real instruction', ['Keep'])).toEqual({});
  });

  it('reads stage gate refusals', () => {
    const e = new ApiError({
      type: '/problems/gate-closed',
      title: 'The stage gate refused this change',
      status: 409,
      errors: [
        { field: 'status', message: 'Blueprint must be done first.' },
        { field: 'status', message: 'No approved migration plan exists for this project.' },
      ],
    });
    expect(gateRefusal(e)).toEqual([
      'Blueprint must be done first.',
      'No approved migration plan exists for this project.',
    ]);
    expect(
      gateRefusal(new ApiError({ type: '/problems/conflict', title: 'x', status: 409 })),
    ).toBeNull();
  });
});

describe('navigation permissions', () => {
  it('accepts any one of a list', () => {
    const perms = new Set(['audit:read']);
    expect(holdsAny(perms, null)).toBe(true);
    expect(holdsAny(perms, 'model:manage')).toBe(false);
    expect(holdsAny(perms, ['model:manage', 'audit:read'])).toBe(true);
  });
});
