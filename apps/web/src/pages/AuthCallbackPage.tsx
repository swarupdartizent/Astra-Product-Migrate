import { useNavigate } from '@tanstack/react-router';
import { ErrorResponse } from 'oidc-client-ts';
import { useEffect, useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Button, ErrorState } from '@/ui';
import { Splash } from './Splash';

function describe(error: unknown): string {
  if (error instanceof ErrorResponse) {
    return error.error_description ?? error.error ?? error.message;
  }
  if (error instanceof Error) return error.message;
  return 'The sign-in response could not be processed.';
}

/** Completes the OIDC redirect (code exchange with PKCE) and returns the user to their page. */
export function AuthCallbackPage() {
  useDocumentTitle('Signing in');
  const auth = useAuth();
  const navigate = useNavigate();
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    auth
      .completeSignIn()
      .then((path) => {
        if (active) setReturnTo(path);
      })
      .catch((err: unknown) => {
        if (active) setError(err);
      });
    return () => {
      active = false;
    };
    // Run once per mount; completeSignIn is idempotent per callback URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigate only once the auth state reflects the new session, so route guards see it.
  useEffect(() => {
    if (returnTo !== null && auth.status === 'authenticated') {
      void navigate({ href: returnTo, replace: true });
    }
  }, [returnTo, auth.status, navigate]);

  if (error) {
    return (
      <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: '1rem' }}>
        <ErrorState
          headingLevel={1}
          title="Sign-in did not complete"
          body={describe(error)}
          actions={
            <Button variant="primary" onClick={() => void auth.signIn()}>
              Try signing in again
            </Button>
          }
        />
      </main>
    );
  }

  return <Splash label="Signing you in…" />;
}
