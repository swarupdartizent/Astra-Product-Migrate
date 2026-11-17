import { Link } from '@tanstack/react-router';
import type { AuditEvent } from '@/api/types';
import { usePermissions } from '@/app/permissions';
import {
  Badge,
  CodeBlock,
  CopyButton,
  KeyValueList,
  Mono,
  Sheet,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { outcome } from './model';

export interface AuditEventPanelProps {
  event: AuditEvent;
  tenantName: string | null;
  onClose: () => void;
}

export function AuditEventPanel({ event: e, tenantName, onClose }: AuditEventPanelProps) {
  const { can } = usePermissions();
  const o = outcome(e.outcome);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <>
          Event <Mono>#{e.seq}</Mono>
        </>
      }
      description={<Mono>{e.action}</Mono>}
      size="lg"
    >
      <KeyValueList
        items={[
          {
            key: 'time',
            label: 'Occurred',
            value: <Timestamp value={e.occurred_at} format="absolute" />,
          },
          {
            key: 'actor',
            label: 'Actor',
            value: (
              <span className={s.cellStack}>
                <span className={s.row}>
                  {e.actor_name} <Badge>{e.actor_type}</Badge>
                </span>
                <Mono className={`${s.muted} ${s.xs}`}>{e.actor_id}</Mono>
              </span>
            ),
          },
          {
            key: 'outcome',
            label: 'Outcome',
            value: <StatusPill tone={o.tone}>{o.label}</StatusPill>,
          },
          {
            key: 'tenant',
            label: 'Tenant',
            value: e.tenant_id ? (
              <span className={s.cellStack}>
                {tenantName ? (
                  <Link to="/tenants/$tenantId" params={{ tenantId: e.tenant_id }} search={{}}>
                    {tenantName}
                  </Link>
                ) : null}
                <Mono className={`${s.muted} ${s.xs}`}>{e.tenant_id}</Mono>
              </span>
            ) : (
              'Platform event'
            ),
          },
          {
            key: 'project',
            label: 'Project',
            value: e.project_id ? <Mono>{e.project_id}</Mono> : null,
          },
          {
            key: 'target',
            label: 'Target',
            value:
              e.target_type || e.target_id ? (
                <span className={s.cellStack}>
                  <span>{e.target_type}</span>
                  {e.target_id ? <Mono className={s.xs}>{e.target_id}</Mono> : null}
                </span>
              ) : null,
          },
          {
            key: 'trace',
            label: 'Trace',
            value: e.trace_id ? (
              <span className={s.row}>
                {can('observability:read') ? (
                  <Link to="/observability/traces/$traceId" params={{ traceId: e.trace_id }}>
                    <Mono>{e.trace_id}</Mono>
                  </Link>
                ) : (
                  <Mono>{e.trace_id}</Mono>
                )}
                <CopyButton value={e.trace_id} label="Copy trace ID" />
              </span>
            ) : null,
          },
          {
            key: 'hash',
            label: 'Hash',
            value: (
              <span className={s.row}>
                <Mono className={s.xs} style={{ overflowWrap: 'anywhere' }}>
                  {e.hash}
                </Mono>
                <CopyButton value={e.hash} label="Copy hash" />
              </span>
            ),
          },
        ]}
      />
      <CodeBlock
        label="Details (JSON)"
        code={JSON.stringify(e.details, null, 2)}
        maxHeight="24rem"
      />
    </Sheet>
  );
}
