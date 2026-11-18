import { useMemo } from 'react';
import { useMe } from '@/api/queries';
import { holdsAny } from './navigation';

const NO_PERMISSIONS: ReadonlySet<string> = new Set();

export interface PermissionsState {
  /** Permission codes from GET /api/v1/me. Empty until loaded. */
  permissions: ReadonlySet<string>;
  isLoading: boolean;
  error: unknown;
  /** True when the user holds the permission, or any one of a list (null = any signed-in user). */
  can: (permission: string | readonly string[] | null) => boolean;
}

/**
 * The signed-in user's permissions, for showing or hiding UI. The API is the real
 * enforcement point; hiding UI is a convenience, never a security control.
 */
export function usePermissions(): PermissionsState {
  const me = useMe();
  const permissions = useMemo(
    () => (me.data ? new Set(me.data.permissions) : NO_PERMISSIONS),
    [me.data],
  );
  return {
    permissions,
    isLoading: me.isPending,
    error: me.error,
    can: (permission) => holdsAny(permissions, permission),
  };
}
