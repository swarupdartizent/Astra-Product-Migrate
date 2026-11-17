import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, ErrorState } from '@/ui';
import styles from '@/pages/StandalonePage.module.css';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence for errors outside the router (providers, shell). Route errors are
 * handled by the router's error component (RouteErrorPage).
 */
export class GlobalErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className={styles.page}>
        <ErrorState
          headingLevel={1}
          title="Astra Migrate hit an unexpected error"
          body="The page could not be displayed. Reloading usually fixes this. If it keeps happening, share the reference below with support."
          reference={this.state.error.message}
          actions={
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </main>
    );
  }
}
