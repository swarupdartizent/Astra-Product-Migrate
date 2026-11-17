import { isApiError } from '@/api/errors';
import { Callout } from '@/ui';
import { ApiErrorView } from './ApiErrorView';

export interface FormErrorProps {
  error: unknown;
  /** Fields rendered by the form; their messages appear inline, not here. */
  fields?: readonly string[];
}

/**
 * Form-level error for a failed submit. Auth and permission problems render the matching
 * state (e.g. multi-factor step-up); other problems show title and detail, plus any field
 * messages the form does not display inline.
 */
export function FormError({ error, fields = [] }: FormErrorProps) {
  if (!error) return null;
  if (
    isApiError(error) &&
    ['mfa_required', 'session_expired', 'unauthorized', 'forbidden', 'network'].includes(error.kind)
  ) {
    return <ApiErrorView error={error} compact headingLevel={3} />;
  }
  if (!isApiError(error)) {
    return (
      <Callout tone="danger" title="The request failed" live>
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </Callout>
    );
  }
  const fieldErrors = error.fieldErrors;
  const unmapped = Object.entries(fieldErrors).filter(([field]) => !fields.includes(field));
  const allInline = Object.keys(fieldErrors).length > 0 && unmapped.length === 0;
  return (
    <Callout tone="danger" title={error.title} live>
      {allInline ? 'Check the highlighted fields.' : error.detail}
      {unmapped.length > 0 ? (
        <ul style={{ margin: 'var(--space-1) 0 0', paddingLeft: 'var(--space-4)' }}>
          {unmapped.map(([field, message]) => (
            <li key={field}>
              {field ? `${field}: ` : ''}
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </Callout>
  );
}
