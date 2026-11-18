import { Download } from 'lucide-react';
import { saveBlob } from '@/api/client';
import { useVendorChanges, useVendorChangesCsv } from '@/api/planning';
import type { Programme } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { Badge, Button, EmptyState, Sheet, Skeleton } from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';

/** Open vendor product changes across the programme's customers, ranked by the migrations they block. */
export function VendorChangesSheet({
  programme,
  onClose,
}: {
  programme: Programme;
  onClose: () => void;
}) {
  const q = useVendorChanges(programme.id);
  const csv = useVendorChangesCsv(programme.id);
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={`Vendor changes: ${programme.name}`}
      description="Gaps routed to a vendor product change and still open, grouped by vendor reference and ranked by how many customers and waves they block."
      actions={
        <Button
          size="sm"
          leadingIcon={<Download aria-hidden="true" />}
          loading={csv.isPending}
          onClick={() => csv.mutate(undefined, { onSuccess: (r) => saveBlob(r) })}
        >
          Download CSV
        </Button>
      }
      size="lg"
    >
      <FormError error={csv.error} />
      {q.isPending ? (
        <Skeleton height="10rem" />
      ) : q.isError ? (
        <ApiErrorView
          error={q.error}
          title="Could not load vendor changes"
          onRetry={() => void q.refetch()}
        />
      ) : q.data.changes.length === 0 ? (
        <EmptyState compact title="No open vendor product changes" />
      ) : (
        <ol className={styles.gapList} aria-label="Vendor changes by rank">
          {q.data.changes.map((c) => (
            <li key={c.change} className={styles.gap}>
              <span className={s.row}>
                <Badge tone="accent">#{c.rank}</Badge>
                <strong>{c.change}</strong>
                {c.product ? <span className={`${s.muted} ${s.xs}`}>{c.product}</span> : null}
              </span>
              <span className={s.small}>
                Blocks {c.customer_count} customer(s) and {c.waves_blocked} wave(s)
              </span>
              <span className={`${s.muted} ${s.xs}`}>
                Customers: {c.customers.join(', ')} · projects: {c.projects.join(', ')} ·{' '}
                {c.gaps.length} gap(s)
              </span>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}
