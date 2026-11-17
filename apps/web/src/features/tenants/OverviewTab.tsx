import type { Tenant } from '@/api/types';
import { Badge, Card, CardBody, CardHeader, CopyButton, KeyValueList, Mono, Timestamp } from '@/ui';
import s from '../shared.module.css';
import { formatMinutes } from './model';
import { TenantStatusPill } from './TenantStatusPill';

export function OverviewTab({ tenant: t }: { tenant: Tenant }) {
  return (
    <Card aria-labelledby="tenant-overview">
      <CardHeader titleId="tenant-overview" title="Overview" />
      <CardBody>
        <KeyValueList
          items={[
            {
              key: 'id',
              label: 'Tenant ID',
              value: (
                <span className={s.row}>
                  <Mono>{t.id}</Mono>
                  <CopyButton value={t.id} label="Copy tenant ID" />
                </span>
              ),
            },
            { key: 'slug', label: 'Short name', value: <Mono>{t.slug}</Mono> },
            {
              key: 'region',
              label: 'Region',
              value: (
                <>
                  {t.region_name ?? 'Unknown region'}{' '}
                  <Mono className={s.muted}>({t.region_code})</Mono>
                </>
              ),
            },
            { key: 'programme', label: 'Programme', value: t.programme_name },
            { key: 'partner', label: 'Partner', value: t.partner_name },
            {
              key: 'status',
              label: 'Status',
              value: (
                <span className={s.stackSm}>
                  <TenantStatusPill status={t.status} />
                  {t.status_detail ? <span className={s.muted}>{t.status_detail}</span> : null}
                </span>
              ),
            },
            {
              key: 'mfa',
              label: 'Multi-factor sign-in',
              value: t.mfa_required ? (
                <Badge tone="success">Required</Badge>
              ) : (
                <Badge tone="warning">Not required</Badge>
              ),
            },
            {
              key: 'timeout',
              label: 'Session timeout',
              value: formatMinutes(t.session_timeout_minutes),
            },
            {
              key: 'key',
              label: 'Encryption key',
              value: (
                <span className={s.cellStack}>
                  <Mono>{t.key_name}</Mono>
                  <span className={`${s.muted} ${s.small}`}>
                    Held in the key service; it cannot be exported. Deleting the tenant destroys it.
                  </span>
                </span>
              ),
            },
            { key: 'created', label: 'Created', value: <Timestamp value={t.created_at} /> },
          ]}
        />
      </CardBody>
    </Card>
  );
}
