import { KeyRound, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { ProductMark } from '@/app/ProductMark';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { useTheme } from '@/theme/useTheme';
import { Button, Callout, IconButton, Tooltip } from '@/ui';
import styles from './SignInPage.module.css';

export interface SignInPageProps {
  /** Same-origin path to return to after sign-in. */
  returnTo?: string | undefined;
}

export function SignInPage({ returnTo }: SignInPageProps) {
  useDocumentTitle('Sign in');
  const auth = useAuth();
  const { resolved, toggle } = useTheme();
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setRedirecting(true);
    setError(null);
    try {
      await auth.signIn(returnTo ? { returnTo } : {});
    } catch (err) {
      setRedirecting(false);
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'The identity provider did not respond.',
      );
    }
  }

  const themeLabel = resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <div className={styles.page}>
      <div className={styles.topRight}>
        <Tooltip content={themeLabel}>
          <IconButton
            label={themeLabel}
            icon={resolved === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            onClick={toggle}
          />
        </Tooltip>
      </div>
      <main className={styles.main}>
        <div className={styles.panel}>
          <ProductMark size="lg" className={styles.mark} />
          <div className={styles.heading}>
            <h1 className={styles.title}>Sign in</h1>
            <p className={styles.subtitle}>
              Use your organisation account. You will be sent to your identity provider and brought
              back here.
            </p>
          </div>

          {auth.endReason === 'expired' ? (
            <Callout tone="warning" title="Your session expired" live>
              Sign in again to continue where you left off.
            </Callout>
          ) : null}
          {auth.endReason === 'signed_out' ? (
            <Callout tone="info" title="You have been signed out" live />
          ) : null}
          {error ? (
            <Callout tone="danger" title="Could not start sign-in" live>
              {error} Check that the identity provider is running and try again.
            </Callout>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            block
            loading={redirecting}
            leadingIcon={<KeyRound aria-hidden="true" />}
            onClick={() => void signIn()}
          >
            Sign in with your organisation
          </Button>

          <p className={styles.footnote}>
            Access is limited to authorised users. Activity is recorded in the audit log.
          </p>
        </div>
      </main>
    </div>
  );
}
