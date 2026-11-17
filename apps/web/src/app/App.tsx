import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';
import { useAuth } from '@/auth/useAuth';
import { Splash } from '@/pages/Splash';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { Toaster, TooltipProvider } from '@/ui';
import { GlobalErrorBoundary } from './ErrorBoundary';
import type { AppRouter } from './router';

function RoutedApp({ router, queryClient }: { router: AppRouter; queryClient: QueryClient }) {
  const auth = useAuth();
  const context = useMemo(() => ({ auth, queryClient }), [auth, queryClient]);

  // Re-run route guards when the session starts or ends (e.g. expiry redirects to sign-in).
  useEffect(() => {
    if (auth.status !== 'loading') void router.invalidate();
  }, [auth.status, router]);

  if (auth.status === 'loading') return <Splash />;
  return <RouterProvider router={router} context={context} />;
}

export interface AppProps {
  router: AppRouter;
  queryClient: QueryClient;
}

export function App({ router, queryClient }: AppProps) {
  return (
    <GlobalErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AuthProvider onSessionEnd={() => queryClient.clear()}>
              <RoutedApp router={router} queryClient={queryClient} />
            </AuthProvider>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </GlobalErrorBoundary>
  );
}
