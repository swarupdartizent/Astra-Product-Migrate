import { useRoles } from '@/api/tenancy';

/** Role key → readable label from GET /roles (falls back to the key). */
export function useRoleLabel(): (key: string) => string {
  const roles = useRoles();
  return (key: string) => roles.data?.find((r) => r.key === key)?.label ?? key.replace(/_/g, ' ');
}
