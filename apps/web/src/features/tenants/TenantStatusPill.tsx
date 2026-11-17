import { StatusPill } from '@/ui';
import { tenantStatus } from './model';

export function TenantStatusPill({ status }: { status: string }) {
  const { label, tone, busy } = tenantStatus(status);
  return (
    <StatusPill tone={tone} pulse={busy}>
      {label}
    </StatusPill>
  );
}
