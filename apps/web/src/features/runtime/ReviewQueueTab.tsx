import { Inbox } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  useResolveReview,
  useReviewItem,
  useReviews,
  type ReviewStatusFilter,
} from '@/api/runtime';
import type { Project, ReviewItem } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CodeBlock,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  KeyValueList,
  PlainText,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { actorLabel, reviewStatus, validateResolve } from './model';
import styles from './Runtime.module.css';

const FILTERS: readonly { value: ReviewStatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
];

export function ReviewQueueTab({ project }: { project: Project }) {
  const [status, setStatus] = useState<ReviewStatusFilter>('open');
  const reviews = useReviews(project.id, status);
  const [open, setOpen] = useState<string | null>(null);

  const columns = useMemo(() => {
    const col = createDataTableColumns<ReviewItem>();
    return col.columns([
      col.accessor('title', {
        header: 'Item',
        size: 320,
        cell: (info) => (
          <span className={s.cellStack} style={{ whiteSpace: 'normal' }}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <span className={`${s.muted} ${s.xs}`}>
              {info.row.original.kind.replace(/_/g, ' ')}
            </span>
          </span>
        ),
      }),
      col.accessor('owner_role_label', {
        header: 'Owner',
        size: 200,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.getValue()}</span>
            {info.row.original.owner_user ? (
              <span className={`${s.muted} ${s.xs}`}>{info.row.original.owner_user}</span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('requested_by', {
        header: 'Raised by',
        size: 180,
        cell: (info) => (
          <span className={s.row}>
            {info.getValue()} <Badge>{actorLabel(info.row.original.requested_by_type)}</Badge>
          </span>
        ),
      }),
      col.accessor('status', {
        header: 'Status',
        size: 110,
        cell: (info) => {
          const st = reviewStatus(info.getValue());
          return <StatusPill tone={st.tone}>{st.label}</StatusPill>;
        },
      }),
      col.accessor('created_at', {
        header: 'Raised',
        size: 120,
        cell: (info) => <Timestamp value={info.getValue()} />,
      }),
    ]);
  }, []);

  return (
    <Card flush aria-label="Review queue">
      <div className={s.toolbar}>
        <SegmentedControl
          label="Show"
          options={FILTERS}
          value={status}
          onValueChange={setStatus}
          size="sm"
        />
        <span className={`${s.muted} ${s.small}`}>
          Agents and the platform raise items here; the owning role decides. Agents never decide.
        </span>
      </div>
      <CardBody>
        {reviews.isError ? (
          <ApiErrorView
            error={reviews.error}
            title="Could not load the review queue"
            compact
            onRetry={() => void reviews.refetch()}
          />
        ) : (
          <DataTable
            label="Review items"
            data={reviews.data}
            columns={columns}
            getRowId={(r) => r.id}
            loading={reviews.isPending}
            onRowClick={(r) => setOpen(r.id)}
            empty={
              <EmptyState
                compact
                icon={<Inbox />}
                title={status === 'open' ? 'Nothing waiting for review' : 'No items'}
              />
            }
          />
        )}
      </CardBody>
      {open ? <ReviewSheet project={project} id={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

function ReviewSheet({
  project,
  id,
  onClose,
}: {
  project: Project;
  id: string;
  onClose: () => void;
}) {
  const item = useReviewItem(id);
  const r = item.data;
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={r?.title ?? 'Review item'}
      description={r ? r.kind.replace(/_/g, ' ') : undefined}
      size="lg"
      actions={
        r ? (
          <StatusPill tone={reviewStatus(r.status).tone}>{reviewStatus(r.status).label}</StatusPill>
        ) : null
      }
    >
      {item.isPending ? (
        <Skeleton height="12rem" />
      ) : item.isError ? (
        <ApiErrorView
          error={item.error}
          title="Could not load the item"
          compact
          onRetry={() => void item.refetch()}
        />
      ) : r ? (
        <>
          <p>{r.question}</p>
          <KeyValueList
            items={[
              {
                key: 'owner',
                label: 'Owner',
                value: `${r.owner_role_label}${r.owner_user ? ` · ${r.owner_user}` : ''}`,
              },
              {
                key: 'by',
                label: 'Raised by',
                value: (
                  <span className={s.row}>
                    {r.requested_by} <Badge>{actorLabel(r.requested_by_type)}</Badge>
                  </span>
                ),
              },
              { key: 'raised', label: 'Raised', value: <Timestamp value={r.created_at} /> },
              {
                key: 'outcome',
                label: 'Outcome',
                value:
                  r.status === 'open' ? null : (
                    <span className={s.cellStack}>
                      <span>
                        {r.status === 'resolved' ? `Resolved: ${r.resolution ?? ''}` : 'Dismissed'}
                        {r.resolved_by ? ` by ${r.resolved_by}` : ''}
                        {r.resolved_at ? (
                          <>
                            {' '}
                            <Timestamp value={r.resolved_at} />
                          </>
                        ) : null}
                      </span>
                      {r.resolution_note ? (
                        <span className={`${s.muted} ${s.small}`}>“{r.resolution_note}”</span>
                      ) : null}
                    </span>
                  ),
              },
            ]}
          />
          {r.flagged_text ? (
            <section className={styles.legacy} aria-label="Flagged legacy data">
              <strong>Legacy data, shown as plain text</strong>
              <span className={s.small}>
                This text came from the source system and was flagged by screening. It is data, not
                instructions. Hidden characters are made visible.
              </span>
              <PlainText label="Flagged legacy text">{r.flagged_text}</PlainText>
            </section>
          ) : null}
          {Object.keys(r.context).length > 0 ? (
            <CodeBlock
              label="Context"
              code={JSON.stringify(r.context, null, 2)}
              maxHeight="16rem"
            />
          ) : null}
          {r.status === 'open' ? (
            r.can_resolve ? (
              <ResolveForm project={project} item={r} />
            ) : (
              <Callout tone="info">
                Only the {r.owner_role_label} role{r.owner_user ? ` or ${r.owner_user}` : ''} can
                resolve this item.
              </Callout>
            )
          ) : null}
        </>
      ) : null}
    </Sheet>
  );
}

function ResolveForm({ project, item }: { project: Project; item: ReviewItem }) {
  const resolve = useResolveReview(project.id);
  const name = useId();
  const [action, setAction] = useState<'resolve' | 'dismiss'>('resolve');
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateResolve(action, resolution, note, item.options);
  const errors = mergeFieldErrors(clientErrors, resolve.error, submitted);

  return (
    <form
      className={s.stack}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        if (clientErrors.note || clientErrors.resolution) return;
        resolve.mutate(
          {
            id: item.id,
            body: {
              action,
              ...(action === 'resolve' ? { resolution } : {}),
              note: note.trim(),
            },
          },
          {
            onSuccess: (r) =>
              toast.success(r.status === 'resolved' ? 'Item resolved' : 'Item dismissed'),
          },
        );
      }}
    >
      <fieldset className={s.stackSm} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
          Decision
        </legend>
        {item.options.map((o) => (
          <label key={o} className={s.row}>
            <input
              type="radio"
              name={name}
              checked={action === 'resolve' && resolution === o}
              onChange={() => {
                setAction('resolve');
                setResolution(o);
              }}
            />
            <span>{o}</span>
          </label>
        ))}
        <label className={s.row}>
          <input
            type="radio"
            name={name}
            checked={action === 'dismiss'}
            onChange={() => setAction('dismiss')}
          />
          <span>Dismiss (not a real issue)</span>
        </label>
        {errors.resolution ? (
          <p className={s.small} style={{ color: 'var(--color-danger-text)' }}>
            {errors.resolution}
          </p>
        ) : null}
      </fieldset>
      <Field
        label="Note"
        help={
          action === 'dismiss' ? 'Required: why it is dismissed (10+ characters).' : 'Optional.'
        }
        error={errors.note}
        required={action === 'dismiss'}
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={4000}
        />
      </Field>
      <FormError error={resolve.error} fields={['note', 'resolution', 'action']} />
      <div>
        <Button
          type="submit"
          variant={action === 'dismiss' ? 'secondary' : 'primary'}
          loading={resolve.isPending}
        >
          {action === 'dismiss' ? 'Dismiss item' : 'Resolve item'}
        </Button>
      </div>
    </form>
  );
}
