import { ClipboardCheck, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useUsers } from '@/api/access';
import { isApiError } from '@/api/errors';
import { useMe } from '@/api/queries';
import type { Project } from '@/api/types';
import { useChecklist, useSyncChecklist, useUpdateChecklistItem } from '@/api/upgrade';
import type { ChecklistItem, ChecklistPatch, ChecklistStatus } from '@/api/upgrade-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  ProgressBar,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { confidence } from '../adapters/model';
import {
  checklistStatus,
  closeProblem,
  groupByArea,
  isClosing,
  roleLabel,
  STATUS_OPTIONS,
} from './model';

const NOBODY = '__none__';

export function ChecklistTab({ project }: { project: Project }) {
  const q = useChecklist(project.id);
  const sync = useSyncChecklist(project.id);
  const me = useMe();
  const [editing, setEditing] = useState<ChecklistItem | null>(null);

  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load the checklist"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const c = q.data;
  const myId = me.data?.id ?? null;
  return (
    <div className={s.stack}>
      <Card aria-labelledby="cl-head">
        <CardHeader
          titleId="cl-head"
          title="Hosting checklist"
          description="What the customer must set up before cut-over on the hosted target: items from the target adapter's recorded constraints, and the four areas every hosted cut-over needs (single sign-on, multi-factor authentication, network access and printing)."
          actions={
            c.complete ? (
              <StatusPill tone="success">Complete</StatusPill>
            ) : (
              <StatusPill tone="neutral">
                {c.done} of {c.total} closed
              </StatusPill>
            )
          }
        />
        <CardBody className={s.stackSm}>
          {c.total > 0 ? (
            <ProgressBar value={Math.round((100 * c.done) / c.total)} label="Checklist progress" />
          ) : null}
          <p className={s.small}>
            {c.adapter ? (
              <>
                Items come from the target adapter <Mono>{c.adapter}</Mono>.
              </>
            ) : (
              'No target adapter is known for this project (pin a target baseline), so only the generic items apply.'
            )}
          </p>
          {c.missing.length > 0 ? (
            <Callout
              tone="info"
              title={`${String(c.missing.length)} item(s) not on the checklist yet`}
            >
              {c.can_manage
                ? 'Add them to bring the checklist in line with the target adapter. Existing items keep their owner, status and note.'
                : 'Someone who manages this project’s stages can add them.'}
            </Callout>
          ) : null}
          <FormError error={sync.error} />
        </CardBody>
        {c.can_manage && c.missing.length > 0 ? (
          <div className={s.toolbar}>
            <Button
              variant="primary"
              leadingIcon={<RefreshCw aria-hidden="true" />}
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: () => toast.success('Checklist updated'),
                })
              }
            >
              Add {c.missing.length} missing item{c.missing.length === 1 ? '' : 's'}
            </Button>
          </div>
        ) : null}
      </Card>

      {c.items.length === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title="The checklist is empty" />
      ) : (
        groupByArea(c.items).map((g) => (
          <Card key={g.area} aria-labelledby={`cl-${g.area}`}>
            <CardHeader titleId={`cl-${g.area}`} title={g.title} />
            <CardBody>
              <ul className={styles.gapList}>
                {g.items.map((i) => {
                  const st = checklistStatus(i.status);
                  const canEdit = c.can_manage || (myId !== null && i.owner_user_id === myId);
                  return (
                    <li key={i.id} className={styles.gap} aria-label={i.title}>
                      <span className={s.row} style={{ width: '100%' }}>
                        <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        <strong>{i.title}</strong>
                        {canEdit ? (
                          <span style={{ marginLeft: 'auto' }}>
                            <IconButton
                              size="sm"
                              label={`Update ${i.title}`}
                              icon={<Pencil aria-hidden="true" />}
                              onClick={() => setEditing(i)}
                            />
                          </span>
                        ) : null}
                      </span>
                      <span className={s.small}>{i.detail}</span>
                      <SourceLine item={i} />
                      <span className={`${s.muted} ${s.xs}`}>
                        Owner: {i.owner_name ?? 'not assigned'} · expected role{' '}
                        {roleLabel(i.owner_role)}
                      </span>
                      {i.note ? <span className={s.small}>Note: {i.note}</span> : null}
                      {i.updated_at ? (
                        <span className={`${s.muted} ${s.xs}`}>
                          Updated by {i.updated_by ?? 'unknown'} <Timestamp value={i.updated_at} />
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        ))
      )}
      {editing ? (
        <EditItemDialog
          project={project}
          item={editing}
          canAssign={c.can_manage}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function SourceLine({ item }: { item: ChecklistItem }) {
  const src = item.source;
  if (src.kind === 'generic') {
    return (
      <span className={s.row}>
        <Badge tone="warning">Generic: confirm with the vendor</Badge>
        <span className={`${s.muted} ${s.xs}`}>{src.note}</span>
      </span>
    );
  }
  const conf = confidence(src.confidence);
  return (
    <span className={s.row}>
      <Badge tone="accent">From the target adapter</Badge>
      <Mono className={s.xs}>{src.constraint}</Mono>
      <Badge tone={conf.tone}>{conf.label}</Badge>
      <span className={`${s.muted} ${s.xs}`}>
        {src.reference.url ? (
          <a href={src.reference.url} target="_blank" rel="noopener noreferrer">
            {src.reference.reference}
          </a>
        ) : (
          src.reference.reference
        )}{' '}
        · recorded {src.recorded_on}
      </span>
    </span>
  );
}

function EditItemDialog({
  project,
  item,
  canAssign,
  onClose,
}: {
  project: Project;
  item: ChecklistItem;
  canAssign: boolean;
  onClose: () => void;
}) {
  const update = useUpdateChecklistItem(project.id);
  const [search, setSearch] = useState('');
  const users = useUsers(search);
  const [owner, setOwner] = useState<string>(item.owner_user_id ?? '');
  const [status, setStatus] = useState<string>(item.status);
  const [note, setNote] = useState(item.note);
  const [submitted, setSubmitted] = useState(false);
  const problem = closeProblem(item, { status, note, owner: owner || null });
  const err = update.error;
  const ownerServer =
    isApiError(err) && err.status === 409
      ? (err.detail ?? err.title)
      : isApiError(err)
        ? err.fieldErrors.owner_user_id
        : undefined;
  const noteServer = isApiError(err) ? err.fieldErrors.note : undefined;
  const ownerOptions = [
    { value: NOBODY, label: 'Nobody' },
    ...(item.owner_user_id && !users.data?.some((u) => u.id === item.owner_user_id)
      ? [{ value: item.owner_user_id, label: item.owner_name ?? 'Current owner' }]
      : []),
    ...(users.data ?? [])
      .filter((u) => u.status === 'active')
      .map((u) => ({ value: u.id, label: `${u.display_name} (${u.email})` })),
  ];
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={item.title}
      description={`${item.category_title} · expected owner role ${roleLabel(item.owner_role)}`}
      submitLabel="Save"
      pending={update.isPending}
      error={isApiError(err) && err.status === 409 ? null : err}
      fields={['owner_user_id', 'note', 'status']}
      onSubmit={() => {
        setSubmitted(true);
        if (problem) return;
        const patch: ChecklistPatch = {};
        if (canAssign && (owner || null) !== item.owner_user_id)
          patch.owner_user_id = owner || null;
        if (status !== item.status) patch.status = status as ChecklistStatus;
        if (note.trim() !== item.note) patch.note = note.trim();
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        update.mutate(
          { id: item.id, patch },
          {
            onSuccess: () => {
              toast.success('Checklist item updated');
              onClose();
            },
          },
        );
      }}
    >
      {canAssign ? (
        <>
          <Field label="Find a person" help="Search by name or email.">
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          {users.isError ? (
            <ApiErrorView error={users.error} title="Could not list people" compact />
          ) : null}
          <Field
            label="Owner"
            error={
              (submitted && problem?.field === 'owner_user_id' ? problem.message : undefined) ??
              ownerServer
            }
          >
            <Select
              options={ownerOptions}
              value={owner || NOBODY}
              onValueChange={(v) => setOwner(v === NOBODY ? '' : v)}
            />
          </Field>
        </>
      ) : (
        <p className={s.small}>Owner: {item.owner_name ?? 'not assigned'}</p>
      )}
      <Field label="Status">
        <Select options={STATUS_OPTIONS} value={status} onValueChange={setStatus} />
      </Field>
      <Field
        label="Note"
        help={
          isClosing(status)
            ? 'Required to close: say how the item was done, or why it does not apply.'
            : undefined
        }
        error={(submitted && problem?.field === 'note' ? problem.message : undefined) ?? noteServer}
        required={isClosing(status)}
      >
        <Textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={4000}
        />
      </Field>
      {!canAssign && ownerServer ? <Callout tone="danger">{ownerServer}</Callout> : null}
    </FormDialog>
  );
}
