import { KeyRound, Plus, RotateCw, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCreateSecret, useDeleteSecret, useRotateSecret, useSecrets } from '@/api/tenancy';
import type { Secret, Tenant } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  Textarea,
  Timestamp,
  toast,
  Tooltip,
  type DataTableColumn,
} from '@/ui';
import s from '../shared.module.css';
import { can, validateSecret, type SecretForm } from './model';

const col = createDataTableColumns<Secret>();

function baseColumns() {
  return col.columns([
    col.accessor('name', {
      header: 'Secret',
      size: 260,
      cell: (info) => {
        const secret = info.row.original;
        return (
          <span className={s.cellStack}>
            <span className={s.row}>
              <Mono>{secret.reference}</Mono>
              <CopyButton value={secret.reference} label={`Copy reference ${secret.reference}`} />
            </span>
            {secret.description ? (
              <span className={`${s.muted} ${s.small}`}>{secret.description}</span>
            ) : null}
          </span>
        );
      },
    }),
    col.accessor('current_version', {
      header: 'Version',
      size: 90,
      meta: { align: 'end' },
      cell: (info) => `v${info.getValue()}`,
    }),
    col.accessor('created_at', {
      header: 'Created',
      size: 190,
      cell: (info) => (
        <span className={s.cellStack}>
          <Timestamp value={info.getValue()} />
          <span className={`${s.muted} ${s.small}`}>
            {info.row.original.created_by_name ?? 'Unknown user'}
          </span>
        </span>
      ),
    }),
    col.accessor((row) => row.rotated_at ?? '', {
      id: 'rotated_at',
      header: 'Rotated',
      size: 130,
      cell: (info) =>
        info.row.original.rotated_at ? (
          <Timestamp value={info.row.original.rotated_at} />
        ) : (
          <span className={s.muted}>Never</span>
        ),
    }),
    col.accessor((row) => row.last_read_at ?? '', {
      id: 'last_read',
      header: 'Last read',
      size: 190,
      cell: (info) => {
        const secret = info.row.original;
        if (!secret.last_read_at) return <span className={s.muted}>Never read</span>;
        return (
          <span className={s.cellStack}>
            <Timestamp value={secret.last_read_at} />
            {secret.last_read_by ? (
              <span className={`${s.muted} ${s.small}`}>by {secret.last_read_by}</span>
            ) : null}
          </span>
        );
      },
    }),
  ]);
}

const readColumns = baseColumns();

export function SecretsTab({ tenant }: { tenant: Tenant }) {
  const secrets = useSecrets(tenant.id);
  const manage = can(tenant, 'secrets:manage');
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Secret | null>(null);
  const [deleting, setDeleting] = useState<Secret | null>(null);
  const remove = useDeleteSecret(tenant.id);

  const columns = useMemo<DataTableColumn<Secret>[]>(
    () =>
      manage
        ? [
            ...readColumns,
            col.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              size: 96,
              enableSorting: false,
              enableResizing: false,
              cell: (info) => (
                <span className={s.rowActions}>
                  <Tooltip content="Rotate">
                    <IconButton
                      size="sm"
                      label={`Rotate ${info.row.original.name}`}
                      icon={<RotateCw aria-hidden="true" />}
                      onClick={() => setRotating(info.row.original)}
                    />
                  </Tooltip>
                  <Tooltip content="Delete">
                    <IconButton
                      size="sm"
                      label={`Delete ${info.row.original.name}`}
                      icon={<Trash aria-hidden="true" />}
                      onClick={() => setDeleting(info.row.original)}
                    />
                  </Tooltip>
                </span>
              ),
            }),
          ]
        : readColumns,
    [manage],
  );

  const addButton = manage ? (
    <Button
      variant="primary"
      size="sm"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      Add secret
    </Button>
  ) : null;

  return (
    <div className={s.stack}>
      <Card flush aria-labelledby="secrets-title">
        <CardHeader
          titleId="secrets-title"
          title="Connector secrets"
          description="Credentials connectors use to reach this tenant's systems. Stored in the vault under this tenant; connectors refer to them by reference, and values are never shown again."
          actions={addButton}
        />
        <CardBody>
          {secrets.isError ? (
            <ApiErrorView
              error={secrets.error}
              title="Could not load connector secrets"
              onRetry={() => void secrets.refetch()}
              retrying={secrets.isFetching}
              compact
            />
          ) : (
            <DataTable
              label="Connector secrets"
              data={secrets.data}
              columns={columns}
              getRowId={(x) => x.id}
              loading={secrets.isPending}
              skeletonRows={3}
              initialSorting={[{ id: 'name', desc: false }]}
              empty={
                <EmptyState
                  compact
                  icon={<KeyRound />}
                  title="No connector secrets"
                  body="Add a secret when a connector needs a password, token or key for this tenant."
                  action={addButton}
                />
              }
            />
          )}
        </CardBody>
      </Card>

      {creating ? (
        <CreateSecretDialog tenantId={tenant.id} onClose={() => setCreating(false)} />
      ) : null}
      {rotating ? (
        <RotateSecretDialog
          tenantId={tenant.id}
          secret={rotating}
          onClose={() => setRotating(null)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        tone="danger"
        title={`Delete ${deleting?.name ?? 'secret'}?`}
        description="The secret and all its versions are destroyed in the vault. Connectors that use this reference stop working. This cannot be undone."
        confirmLabel="Delete secret"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`Secret ${deleting.name} deleted`);
        }}
      />
    </div>
  );
}

function CreateSecretDialog({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const create = useCreateSecret(tenantId);
  const [form, setForm] = useState<SecretForm>({ name: '', description: '', value: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateSecret(form);
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);

  function set(key: keyof SecretForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (create.error) create.reset();
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add connector secret"
      submitLabel="Add secret"
      pending={create.isPending}
      error={create.error}
      fields={['name', 'description', 'value']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          { name: form.name, description: form.description.trim(), value: form.value },
          {
            onSuccess: (secret) => {
              toast.success(`Secret ${secret.name} added`, {
                description: `Connectors can now use ${secret.reference}.`,
              });
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Name"
        help={
          form.name ? `Reference: secret://${form.name}` : 'Lowercase letters, digits and hyphens.'
        }
        error={errors.name}
        required
      >
        <Input
          value={form.name}
          onChange={(e) => set('name', e.target.value.toLowerCase())}
          mono
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
        />
      </Field>
      <Field
        label="Description"
        help="What it is for. Visible to everyone who can read secrets."
        error={errors.description}
      >
        <Textarea
          rows={2}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={500}
        />
      </Field>
      <Field
        label="Value"
        help="Stored encrypted in the vault. It will never be displayed again, here or anywhere else."
        error={errors.value}
        required
      >
        <Input
          type="password"
          value={form.value}
          onChange={(e) => set('value', e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
        />
      </Field>
    </FormDialog>
  );
}

function RotateSecretDialog({
  tenantId,
  secret,
  onClose,
}: {
  tenantId: string;
  secret: Secret;
  onClose: () => void;
}) {
  const rotate = useRotateSecret(tenantId);
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'value'> = value ? {} : { value: 'Enter the new value.' };
  const errors = mergeFieldErrors(clientErrors, rotate.error, submitted);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Rotate ${secret.name}`}
      description={`Creates version ${secret.current_version + 1}. Connectors pick up the new value on their next read.`}
      submitLabel="Rotate secret"
      pending={rotate.isPending}
      error={rotate.error}
      fields={['value']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        rotate.mutate(
          { secretId: secret.id, body: { value } },
          {
            onSuccess: (updated) => {
              toast.success(`Secret ${updated.name} rotated`, {
                description: `Now at version ${updated.current_version}.`,
              });
              onClose();
            },
          },
        );
      }}
    >
      <Callout tone="info">The new value is never displayed again after you save it.</Callout>
      <Field label="New value" error={errors.value} required>
        <Input
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (rotate.error) rotate.reset();
          }}
          autoComplete="new-password"
          spellCheck={false}
        />
      </Field>
    </FormDialog>
  );
}
