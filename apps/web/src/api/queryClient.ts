import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './errors';

const MAX_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // Retry only transient failures. Auth, permission and validation errors are final.
        retry: (failureCount, error) =>
          failureCount < MAX_RETRIES && (!isApiError(error) || error.isRetryable),
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}
