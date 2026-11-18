import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/api/errors';
import { useAddGap, useGaps, useUpdateGap, useWaves } from '@/api/planning';
import { GAP_ROUTES, type GapPatch, type GapRoute, type PlanGap } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CheckboxGroup,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { GAP_ROUTE_LABELS, minLength } from './model';
import { PersonPicker } from './PlanShared';

export function GapsView({ project }: { project: Project }) {
  const q = useGaps(project.id);
  const canEdit = project.permissions.includes('blueprint:edit');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PlanGap | null>(null);
  return (
    <div className={s.stack}>
      <Card aria-labelledby="gaps-head">
        <CardHeader
          titleId="gaps-head"
          title="Gaps"
          description="What the target cannot do as the business needs. Each gap is routed (configuration, customer extension, vendor product change or process change) and owned; it cannot close without both."
          actions={
            canEdit ? (
              <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setAdding(true)}>
                Record a gap
              </Button>
            ) : null
          }
        />
        <CardBody>
          {q.isPending ? (
            <Skeleton height="6rem" />
          ) : q.isError ? (
            <ApiErrorView
              error={q.error}
              title="Could not load gaps"
              compact
              onRetry={() => void q.refetch()}
            />
          ) : q.data.length === 0 ? (
            <EmptyState compact title="No gaps recorded" />
          ) : (
            <ul className={styles.gapList} aria-label="Gaps">
              {q.data.map((g) => (
                <li key={g.id} className={styles.gap}>
                  <span className={s.row} style={{ width: '100%' }}>
                    <StatusPill tone={g.status === 'closed' ? 'success' : 'warning'}>
                      {g.status === 'closed' ? 'Closed' : 'Open'}
                    </StatusPill>
                    <strong>{g.title}</strong>
                    {g.route ? (
                      <Badge tone={g.route === 'vendor_product_change' ? 'accent' : 'neutral'}>
                        {GAP_ROUTE_LABELS[g.route]}
                      </Badge>
                    ) : (
                      <Badge tone="danger">Not routed</Badge>
                    )}
                    {canEdit ? (
                      <span style={{ marginLeft: 'auto' }}>
                        <IconButton
                          size="sm"
                          label={`Update gap ${g.title}`}
                          icon={<Pencil aria-hidden="true" />}
                          onClick={() => setEditing(g)}
                        />
                      </span>
                    ) : null}
                  </span>
                  {g.detail ? <span className={s.small}>{g.detail}</span> : null}
                  <span className={`${s.muted} ${s.xs}`}>
                    Owner {g.owner_name ?? 'not assigned'}
                    {g.scope_key ? ` · scope ${g.scope_key}` : ''}
                    {g.vendor_ref ? ` · vendor reference ${g.vendor_ref}` : ''}
                    {g.product ? ` · product ${g.product}` : ''}
                    {g.blocks_waves.length ? ` · blocks ${g.blocks_waves.join(', ')}` : ''} · raised
                    by {g.created_by ?? 'unknown'} <Timestamp value={g.created_at} />
                  </span>
                  {g.status === 'closed' ? (
                    <span className={`${s.muted} ${s.xs}`}>
                      Closed by {g.closed_by ?? 'unknown'}
                      {g.closed_at ? (
                        <>
                          {' '}
                          <Timestamp value={g.closed_at} />
                        </>
                      ) : null}
                      : “{g.close_note ?? ''}”
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      {adding ? <AddGapDialog project={project} onClose={() => setAdding(false)} /> : null}
      {editing ? (
        <EditGapDialog project={project} gap={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function AddGapDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const add = useAddGap(project.id);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [scopeKey, setScopeKey] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: FieldErrors<'title' | 'detail' | 'scope_key'> = {};
  const t = minLength(title, 5, 'Name the gap');
  if (t) client.title = t;
  const errors = mergeFieldErrors(client, add.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Record a gap"
      submitLabel="Record gap"
      pending={add.isPending}
      error={add.error}
      fields={['title', 'detail', 'scope_key']}
      onSubmit={() => {
        setSubmitted(true);
        if (t) return;
        add.mutate(
          { title: title.trim(), detail: detail.trim(), scope_key: scopeKey.trim() || null },
          {
            onSuccess: () => {
              toast.success('Gap recorded');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Title" error={errors.title} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
      </Field>
      <Field label="Detail" error={errors.detail}>
        <Textarea
          rows={3}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          maxLength={4000}
        />
      </Field>
      <Field
        label="Scope item key"
        help="Optional, from the scope register."
        error={errors.scope_key}
      >
        <Input
          mono
          value={scopeKey}
          onChange={(e) => setScopeKey(e.target.value)}
          maxLength={400}
        />
      </Field>
    </FormDialog>
  );
}

const KEEP = '__keep__';

function EditGapDialog({
  project,
  gap,
  onClose,
}: {
  project: Project;
  gap: PlanGap;
  onClose: () => void;
}) {
  const update = useUpdateGap(project.id);
  const waves = useWaves(project.id);
  const [route, setRoute] = useState<string>(gap.route ?? '');
  const [owner, setOwner] = useState(gap.owner_user_id ?? '');
  const [vendorRef, setVendorRef] = useState(gap.vendor_ref ?? '');
  const [blocks, setBlocks] = useState<string[]>(gap.blocks_waves);
  const [status, setStatus] = useState<string>(KEEP);
  const [closeNote, setCloseNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const closing = status === 'closed';
  const client: FieldErrors<
    'route' | 'owner_user_id' | 'close_note' | 'vendor_ref' | 'blocks_waves' | 'status'
  > = {};
  if (closing) {
    if (!route) client.route = 'Route the gap before closing it.';
    if (!owner) client.owner_user_id = 'Assign an owner before closing.';
    if (!closeNote.trim()) client.close_note = 'Say how the gap was resolved.';
  }
  const err = update.error;
  const missing = isApiError(err) && err.status === 409 ? err.fieldErrorList : [];
  const errors = mergeFieldErrors(client, err, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Update gap: ${gap.title}`}
      submitLabel="Save"
      size="lg"
      pending={update.isPending}
      error={missing.length ? null : err}
      fields={['route', 'owner_user_id', 'vendor_ref', 'blocks_waves', 'status', 'close_note']}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        const patch: GapPatch = {};
        if (route && route !== gap.route) patch.route = route as GapRoute;
        if ((owner || null) !== gap.owner_user_id) patch.owner_user_id = owner || null;
        if (vendorRef.trim() !== (gap.vendor_ref ?? '')) patch.vendor_ref = vendorRef.trim();
        if ([...blocks].sort().join() !== [...gap.blocks_waves].sort().join())
          patch.blocks_waves = blocks;
        if (status !== KEEP) patch.status = status as 'open' | 'closed';
        if (closing) patch.close_note = closeNote.trim();
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        update.mutate(
          { id: gap.id, patch },
          {
            onSuccess: () => {
              toast.success('Gap updated');
              onClose();
            },
          },
        );
      }}
    >
      {missing.length && isApiError(err) ? (
        <Callout tone="danger" title={err.title} live>
          <ul className={styles.plainList}>
            {missing.map((m) => (
              <li key={m.field}>
                <Mono className={s.xs}>{m.field}</Mono>: {m.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Field label="Route" error={errors.route}>
        <Select
          options={GAP_ROUTES.map((r) => ({ value: r, label: GAP_ROUTE_LABELS[r] }))}
          value={route}
          onValueChange={setRoute}
          placeholder="Choose a route"
        />
      </Field>
      <PersonPicker
        label="Owner"
        value={owner}
        currentName={gap.owner_name}
        onChange={setOwner}
        error={errors.owner_user_id}
      />
      {route === 'vendor_product_change' ? (
        <Field
          label="Vendor reference"
          help="The vendor's change or idea number, so the same change across customers is grouped."
          error={errors.vendor_ref}
        >
          <Input
            mono
            value={vendorRef}
            onChange={(e) => setVendorRef(e.target.value)}
            maxLength={100}
          />
        </Field>
      ) : null}
      <CheckboxGroup
        legend="Waves it blocks"
        options={(waves.data?.waves ?? []).map((w) => ({
          value: w.key,
          label: w.name,
          description: w.key,
        }))}
        value={blocks}
        onValueChange={setBlocks}
        emptyText={waves.isPending ? 'Loading…' : 'No waves defined.'}
        error={errors.blocks_waves}
      />
      <Field label="Status" error={errors.status}>
        <Select
          options={
            gap.status === 'closed'
              ? [
                  { value: KEEP, label: 'Keep closed' },
                  { value: 'open', label: 'Reopen' },
                ]
              : [
                  { value: KEEP, label: 'Keep open' },
                  { value: 'closed', label: 'Close the gap' },
                ]
          }
          value={status}
          onValueChange={setStatus}
        />
      </Field>
      {closing ? (
        <Field label="How it was resolved" error={errors.close_note} required>
          <Textarea
            rows={3}
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            maxLength={4000}
          />
        </Field>
      ) : null}
    </FormDialog>
  );
}
