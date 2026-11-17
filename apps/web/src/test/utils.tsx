import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/auth/context';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { TooltipProvider } from '@/ui';

export function createAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'authenticated',
    user: { sub: 'test-subject', name: 'Test User', email: 'test.user@example.test' },
    endReason: null,
    signIn: vi.fn(() => Promise.resolve()),
    signOut: vi.fn(() => Promise.resolve()),
    completeSignIn: vi.fn(() => Promise.resolve('/')),
    ...overrides,
  };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

interface ProvidersOptions {
  auth?: AuthContextValue;
  queryClient?: QueryClient;
}

export function renderWithProviders(
  ui: ReactElement,
  {
    auth = createAuthValue(),
    queryClient = createTestQueryClient(),
    ...options
  }: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {},
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  return { auth, queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

/** A fetch Response with a JSON body. */
export function jsonResponse(
  body: unknown,
  status = 200,
  contentType = 'application/json',
): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

/**
 * Renders UI that uses router hooks/links inside a throwaway memory router (one catch-all
 * root route). Await a findBy* query before asserting: the router renders asynchronously.
 */
export function renderWithRouter(ui: ReactElement, options: ProvidersOptions = {}) {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { router, ...renderWithProviders(<RouterProvider router={router} />, options) };
}
