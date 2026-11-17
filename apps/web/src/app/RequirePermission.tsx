import { ShieldBan } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorState, Skeleton } from '@/ui';
import { ApiErrorView } from './ApiErrorView';
import { usePermissions } from './permissions';

export interface RequirePermissionProps {
  permission: string;
  children: ReactNode;
}

/**
 * Renders children only when the user holds `permission`. Wrap feature pages with it so a
 * direct link shows a clear permission-denied state instead of a broken page.
 */
export function RequirePermission({ permission, children }: RequirePermissionProps) {
  const { can, isLoading, error } = usePermissions();
  if (isLoading) {
    return (
      <div aria-busy="true" aria-label="Checking access">
        <Skeleton height="1.5rem" width="40%" />
      </div>
    );
  }
  if (error) return <ApiErrorView error={error} headingLevel={1} />;
  if (!can(permission)) {
    return (
      <ErrorState
        tone="neutral"
        headingLevel={1}
        icon={<ShieldBan />}
        title="You don't have permission to view this page"
        body="Your role assignments do not include access to this page. Ask an administrator if you need it."
        reference={`Requires ${permission}`}
      />
    );
  }
  return <>{children}</>;
}
