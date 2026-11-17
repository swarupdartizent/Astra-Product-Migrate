import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Button } from '@/ui';

/** Rendered by the router when a route component or loader throws. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  useDocumentTitle('Error');
  const router = useRouter();
  return (
    <div role="presentation" style={{ padding: 'var(--space-8) var(--space-4)' }}>
      <ApiErrorView
        error={error}
        headingLevel={1}
        title="This page failed to load"
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">Go to Home</Link>
        </Button>
      </div>
    </div>
  );
}
