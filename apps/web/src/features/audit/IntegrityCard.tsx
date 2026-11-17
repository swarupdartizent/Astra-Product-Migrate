import { ShieldCheck } from 'lucide-react';
import { useAuditAnchors, useVerifyAudit } from '@/api/audit';
import type { AuditAnchor } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { usePermissions } from '@/app/permissions';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  KeyValueList,
  Mono,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';

const col = createDataTableColumns<AuditAnchor>();
const anchorColumns = col.columns([
  col.accessor('head_seq', { header: 'Up to seq', size: 100, meta: { align: 'end', mono: true } }),
  col.accessor('anchored_at', {
    header: 'Signed',
    size: 140,
    cell: (info) => <Timestamp value={info.getValue()} />,
  }),
  col.accessor('head_hash', {
    header: 'Head hash',
    size: 260,
    cell: (info) => <Mono className={s.xs}>{info.getValue()}</Mono>,
  }),
  col.accessor((row) => `${row.key_name} v${row.key_version}`, {
    id: 'key',
    header: 'Signing key',
    size: 200,
    cell: (info) => <Mono className={s.xs}>{info.getValue()}</Mono>,
  }),
]);

export function IntegrityCard() {
  const { can } = usePermissions();
  const verify = useVerifyAudit();
  const anchors = useAuditAnchors();
  const result = verify.data;

  return (
    <Card flush aria-labelledby="integrity-title">
      <CardHeader
        titleId="integrity-title"
        title="Integrity"
        description="Verification recomputes every hash in the chain and checks every signed anchor, then signs the current head as a new anchor."
        actions={
          can('audit:verify') ? (
            <Button
              size="sm"
              leadingIcon={<ShieldCheck aria-hidden="true" />}
              loading={verify.isPending}
              onClick={() => verify.mutate()}
            >
              Verify integrity
            </Button>
          ) : null
        }
      />
      {verify.isError ? (
        <CardBody>
          <FormError error={verify.error} />
        </CardBody>
      ) : null}
      {result ? (
        <CardBody className={s.stackSm}>
          <Callout
            tone={result.ok ? 'success' : 'danger'}
            title={result.ok ? 'The audit log is intact' : 'The audit log failed verification'}
            live
          >
            {result.ok
              ? `Every hash matched and every anchor signature was valid.${result.anchored_seq !== null ? ` A new anchor was signed at seq ${result.anchored_seq}.` : ''}`
              : 'Investigate the problems below. No new anchor was signed.'}
          </Callout>
          <KeyValueList
            items={[
              {
                key: 'events',
                label: 'Events checked',
                value: result.events_checked.toLocaleString(),
              },
              {
                key: 'anchors',
                label: 'Anchors checked',
                value: result.anchors_checked.toLocaleString(),
              },
              { key: 'head', label: 'Head seq', value: <Mono>{result.head_seq}</Mono> },
              {
                key: 'hash',
                label: 'Head hash',
                value: result.head_hash ? <Mono className={s.xs}>{result.head_hash}</Mono> : null,
              },
              {
                key: 'anchored',
                label: 'Anchored at seq',
                value: result.anchored_seq !== null ? <Mono>{result.anchored_seq}</Mono> : null,
              },
            ]}
          />
          {result.problems.length > 0 ? (
            <section aria-labelledby="problems-title">
              <h3 id="problems-title" className={s.cellPrimary}>
                Problems ({result.problems.length})
              </h3>
              <ul style={{ paddingLeft: 'var(--space-5)', marginTop: 'var(--space-1)' }}>
                {result.problems.map((p, i) => (
                  <li key={i}>
                    <Mono className={s.small}>{p}</Mono>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CardBody>
      ) : null}
      <CardBody>
        <h3 className="sr-only">Signed anchors</h3>
        {anchors.isError ? (
          <ApiErrorView
            error={anchors.error}
            title="Could not load signed anchors"
            onRetry={() => void anchors.refetch()}
            retrying={anchors.isFetching}
            compact
          />
        ) : (
          <DataTable
            label="Signed anchors, newest first"
            data={anchors.data}
            columns={anchorColumns}
            getRowId={(a) => String(a.id)}
            loading={anchors.isPending}
            skeletonRows={3}
            maxHeight="20rem"
            empty={
              <EmptyState
                compact
                icon={<ShieldCheck />}
                title="No signed anchors yet"
                body="Run a verification to sign the first anchor."
              />
            }
          />
        )}
      </CardBody>
    </Card>
  );
}
