import type { ModelPrice, ModelProvider, ProviderKind, UsageGroupBy } from '@/api/types';
import type { FieldErrors } from '@/lib/forms';

/** Any one of these lets a person view the model gateway pages. */
export const MODEL_READ_PERMISSIONS = ['model:manage', 'audit:read', 'observability:read'] as const;

export const PROVIDER_KINDS: readonly {
  value: ProviderKind;
  label: string;
  endpointHelp: string;
}[] = [
  {
    value: 'anthropic',
    label: 'Anthropic API',
    endpointHelp: 'Optional. Leave empty for the default API address.',
  },
  {
    value: 'anthropic_foundry',
    label: 'Claude on Microsoft Foundry',
    endpointHelp: 'Required. The Foundry resource name or its HTTPS URL.',
  },
  {
    value: 'azure_openai',
    label: 'Azure OpenAI',
    endpointHelp: 'Required. The Azure OpenAI HTTPS endpoint.',
  },
];

export const PROVIDER_OPTIONS = [
  {
    key: 'refusal_fallback',
    label: 'Refusal fallback',
    description: 'Retry on a fallback model when the model declines a request.',
  },
  {
    key: 'reasoning_effort',
    label: 'Reasoning effort',
    description: 'Pass the agent’s effort setting to the provider.',
  },
] as const;

export interface ProviderForm {
  name: string;
  kind: ProviderKind | '';
  endpoint: string;
  api_version: string;
  no_training_terms: boolean;
  terms_reference: string;
  options: Record<string, boolean>;
  enabled: boolean;
}

export function providerToForm(p: ModelProvider | null): ProviderForm {
  return {
    name: p?.name ?? '',
    kind: (p?.kind as ProviderKind | undefined) ?? '',
    endpoint: p?.endpoint ?? '',
    api_version: p?.api_version ?? '',
    no_training_terms: p?.no_training_terms ?? false,
    terms_reference: p?.terms_reference ?? '',
    options: Object.fromEntries(
      Object.entries(p?.options ?? {}).filter(
        (e): e is [string, boolean] => typeof e[1] === 'boolean',
      ),
    ),
    enabled: p?.enabled ?? false,
  };
}

/** Mirrors the API's checks so problems show before submit; the server stays the authority. */
export function validateProvider(form: ProviderForm): FieldErrors<keyof ProviderForm> {
  const errors: FieldErrors<keyof ProviderForm> = {};
  const name = form.name.trim();
  if (name.length < 2 || name.length > 100) errors.name = 'Use 2–100 characters.';
  if (!form.kind) errors.kind = 'Choose the kind of provider.';
  const endpoint = form.endpoint.trim();
  if ((form.kind === 'anthropic_foundry' || form.kind === 'azure_openai') && !endpoint) {
    errors.endpoint = 'This kind of provider needs its endpoint.';
  } else if (endpoint.startsWith('http://')) {
    errors.endpoint = 'Model endpoints must use HTTPS.';
  }
  if (form.no_training_terms && form.terms_reference.trim().length < 10) {
    errors.terms_reference =
      'Say where the no-training terms are recorded (contract, order form or provider documentation), at least 10 characters.';
  }
  return errors;
}

export const USAGE_GROUPS: readonly { value: UsageGroupBy; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'served_model', label: 'Model' },
  { value: 'provider', label: 'Provider' },
  { value: 'alias', label: 'Alias' },
  { value: 'project', label: 'Project' },
  { value: 'tenant', label: 'Tenant' },
];

export function formatUsd(value: number | null): string {
  if (value === null) return 'Price not configured';
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

export function formatTokens(n: number): string {
  return new Intl.NumberFormat('en', { notation: n >= 100_000 ? 'compact' : 'standard' }).format(n);
}

export function priceRows(prices: Record<string, ModelPrice>) {
  return Object.entries(prices)
    .map(([model, price]) => ({ model, ...price }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** Alias names: 2–60 lowercase letters, digits and hyphens, starting with a letter. */
export const ALIAS_PATTERN = /^[a-z][a-z0-9-]{1,59}$/;

export interface AliasForm {
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  reason: string;
}

export function validateAlias(form: AliasForm): FieldErrors<keyof AliasForm> {
  const errors: FieldErrors<keyof AliasForm> = {};
  if (!ALIAS_PATTERN.test(form.alias)) {
    errors.alias = 'Use 2–60 lowercase letters, digits and hyphens, starting with a letter.';
  }
  if (!form.provider_id) errors.provider_id = 'Choose a provider.';
  const m = form.model.trim().length;
  if (m < 2 || m > 120) errors.model = 'Enter the model id (or the deployment name on Azure).';
  const r = form.reason.trim().length;
  if (r < 5) errors.reason = `Say why (at least 5 characters, ${r} so far).`;
  return errors;
}

/** Pill tone for a model call status. */
export function callTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  return status === 'ok' || status === 'succeeded'
    ? 'success'
    : status === 'refused'
      ? 'warning'
      : status === 'error'
        ? 'danger'
        : 'neutral';
}
