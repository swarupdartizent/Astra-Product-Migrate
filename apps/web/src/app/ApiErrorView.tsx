import { Clock, CloudOff, LogIn, ShieldBan, ShieldLock } from 'lucide-react';
import { useState } from 'react';
import { type ApiError, isApiError } from '@/api/errors';
import { useAuth } from '@/auth/useAuth';
import { Button, ErrorState } from '@/ui';

export interface ApiErrorViewProps {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
  headingLevel?: 1 | 2 | 3 | 4;
  /** Context for generic failures, e.g. "Could not load your role assignments". */
  title?: string;
}

function currentPath(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

function reference(error: ApiError): string | undefined {
  if (error.status === 0) return undefined;
  const parts = [`HTTP ${error.status}`];
  if (error.problem.type && error.problem.type !== 'about:blank') parts.push(error.problem.type);
  if (error.problem.instance) parts.push(error.problem.instance);
  return parts.join(' · ');
}

/**
 * Turns any API failure into the right, honest UI state:
 * multi-factor step-up, permission denied, session ended, API unreachable, or a generic
 * failure with the problem details. Use it wherever a query or mutation can fail.
 */
export function ApiErrorView({
  error,
  onRetry,
  retrying,
  compact = false,
  headingLevel = 3,
  title,
}: ApiErrorViewProps) {
  const auth = useAuth();
  const [redirecting, setRedirecting] = useState(false);

  function signIn(mode: 'mfa' | 'fresh' | 'normal') {
    setRedirecting(true);
    auth
      .signIn({ returnTo: currentPath(), mfa: mode === 'mfa', fresh: mode === 'fresh' })
      .catch(() => setRedirecting(false));
  }

  const common = { compact, headingLevel } as const;

  if (!isApiError(error)) {
    return (
      <ErrorState
        {...common}
        title={title ?? 'Something went wrong'}
        body={error instanceof Error ? error.message : 'An unexpected error occurred.'}
        {...(onRetry ? { onRetry } : {})}
        retrying={retrying ?? false}
      />
    );
  }

  switch (error.kind) {
    case 'mfa_required':
      return (
        <ErrorState
          {...common}
          tone="warning"
          icon={<ShieldLock />}
          title="Multi-factor sign-in required"
          body={
            error.detail ??
            'This area needs a sign-in that includes a second factor. Sign in again and complete the multi-factor step to continue.'
          }
          actions={
            <Button
              variant="primary"
              size="sm"
              loading={redirecting}
              leadingIcon={<ShieldLock aria-hidden="true" />}
              onClick={() => signIn('mfa')}
            >
              Sign in with multi-factor
            </Button>
          }
        />
      );
    case 'session_expired':
      return (
        <ErrorState
          {...common}
          tone="warning"
          icon={<Clock />}
          title={error.title}
          body={
            error.detail ??
            'This tenant limits how long a sign-in lasts. Sign in again to continue working on it.'
          }
          actions={
            <Button
              variant="primary"
              size="sm"
              loading={redirecting}
              onClick={() => signIn('fresh')}
            >
              Sign in again
            </Button>
          }
        />
      );
    case 'forbidden':
      return (
        <ErrorState
          {...common}
          tone="neutral"
          icon={<ShieldBan />}
          title="You don't have permission to view this"
          body={
            error.detail ??
            'Your role assignments do not include access to this. Ask an administrator if you need it.'
          }
          reference={reference(error)}
        />
      );
    case 'unauthorized':
      return (
        <ErrorState
          {...common}
          tone="neutral"
          icon={<LogIn />}
          title="Your session has ended"
          body="Sign in again to continue."
          actions={
            <Button
              variant="primary"
              size="sm"
              loading={redirecting}
              onClick={() => signIn('normal')}
            >
              Sign in
            </Button>
          }
        />
      );
    case 'network':
      return (
        <ErrorState
          {...common}
          icon={<CloudOff />}
          title={error.title}
          body={error.detail}
          {...(onRetry ? { onRetry } : {})}
          retrying={retrying ?? false}
        />
      );
    default:
      return (
        <ErrorState
          {...common}
          title={title ?? error.title}
          body={title ? (error.detail ?? error.title) : error.detail}
          reference={reference(error)}
          {...(onRetry && error.isRetryable ? { onRetry } : {})}
          retrying={retrying ?? false}
        />
      );
  }
}
