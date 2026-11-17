import { Link, useRouterState } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { Button, EmptyState, Mono } from '@/ui';
import styles from './StandalonePage.module.css';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <main className={styles.page}>
      <EmptyState
        headingLevel={1}
        icon={<Compass />}
        title="Page not found"
        body={
          <>
            Nothing exists at <Mono chip>{pathname}</Mono>. It may have moved, or the link may be
            wrong.
          </>
        }
        action={
          <Button asChild variant="primary">
            <Link to="/">Go to Home</Link>
          </Button>
        }
      />
    </main>
  );
}
