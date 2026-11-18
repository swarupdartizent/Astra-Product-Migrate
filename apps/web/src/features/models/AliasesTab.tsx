import { Pencil, Plus, Tags, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAliases, useDeleteAlias, useProviders, useSetAlias } from '@/api/models';
import type { ModelAlias } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { usePermissions } from '@/app/permissions';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  ConfirmDialog,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  Select,
  StatusPill,
  Textarea,
  Timestamp,
  toast,
  Tooltip,
} from '@/ui';
import s from '../shared.module.css';
import { validateAlias, type AliasForm } from './model';

export function AliasesTab() {
  const aliases = useAliases();
  const { can } = usePermissions();
  const manage = can('model:manage');
  const [editing, setEditing] = useState<ModelAlias | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ModelAlias | null>(null);
  const remove = useDeleteAlias();

  const columns = useMemo(() => {
    const col = createDataTableColumns<ModelAlias>();
    return col.columns([
      col.accessor('alias', {
        header: 'Alias',
        size: 200,
        cell: (info) => (
          <span className={s.cellStack}>
            <Mono>{info.getValue()}</Mono>
            {info.row.original.description ? (
              <span className={`${s.muted} ${s.xs}`} style={{ whiteSpace: 'normal' }}>
                {info.row.original.description}
              </span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('provider_name', {
        header: 'Provider',
        size: 200,
        cell: (info) => (
          <span className={s.cellStack}>
            <span>{info.getValue()}</span>
            {!info.row.original.provider_usable ? (
              <StatusPill tone="warning">Provider not usable</StatusPill>
            ) : null}
          </span>
        ),
      }),
      col.accessor('model', {
        header: 'Model',
        size: 200,
        cell: (info) => (
          <span className={s.cellStack}>
            <Mono>{info.getValue()}</Mono>
            {!info.row.original.price_configured ? (
              <Badge tone="warning">Price not configured</Badge>
            ) : null}
          </span>
        ),
      }),
      col.accessor('updated_at', {
        header: 'Changed',
        size: 130,
        cell: (info) => <Timestamp value={info.getValue()} />,
      }),
      ...(manage
        ? [
            col.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              size: 96,
              enableSorting: false,
              enableResizing: false,
              cell: (info) => (
                <span className={s.rowActions}>
                  <Tooltip content="Change">
                    <IconButton
                      size="sm"
                      label={`Change ${info.row.original.alias}`}
                      icon={<Pencil aria-hidden="true" />}
                      onClick={() => setEditing(info.row.original)}
                    />
                  </Tooltip>
                  <Tooltip content="Delete">
                    <IconButton
                      size="sm"
                      label={`Delete ${info.row.original.alias}`}
                      icon={<Trash aria-hidden="true" />}
                      onClick={() => setDeleting(info.row.original)}
                    />
                  </Tooltip>
                </span>
              ),
            }),
          ]
        : []),
    ]);
  }, [manage]);

  return (
    <div className={s.stack}>
      <Callout tone="info" title="Agents name aliases, never models">
        Each agent version names an alias such as <Mono>reasoning-default</Mono>. Changing what an
        alias points to changes the model for every agent that uses it, with no change to any agent.
        Each change needs a reason and is recorded in the audit log.
      </Callout>
      <Card flush aria-label="Model aliases">
        <CardBody>
          {aliases.isError ? (
            <ApiErrorView
              error={aliases.error}
              title="Could not load aliases"
              compact
              onRetry={() => void aliases.refetch()}
            />
          ) : (
            <DataTable
              label="Model aliases"
              data={aliases.data}
              columns={columns}
              getRowId={(a) => a.alias}
              loading={aliases.isPending}
              initialSorting={[{ id: 'alias', desc: false }]}
              empty={
                <EmptyState
                  compact
                  icon={<Tags />}
                  title="No aliases"
                  body="Agents cannot call models until their alias exists."
                />
              }
            />
          )}
        </CardBody>
      </Card>
      {manage ? (
        <div>
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing('new')}>
            Add alias
          </Button>
        </div>
      ) : null}
      {editing ? (
        <AliasDialog alias={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        tone="danger"
        title={`Delete alias ${deleting?.alias ?? ''}?`}
        description="Agents that use this alias are blocked until it exists again."
        confirmLabel="Delete alias"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.alias);
          toast.success(`Alias ${deleting.alias} deleted`);
        }}
      />
    </div>
  );
}

function AliasDialog({ alias, onClose }: { alias: ModelAlias | null; onClose: () => void }) {
  const providers = useProviders();
  const save = useSetAlias();
  const [form, setForm] = useState<AliasForm>({
    alias: alias?.alias ?? '',
    provider_id: alias?.provider_id ?? '',
    model: alias?.model ?? '',
    description: alias?.description ?? '',
    reason: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateAlias(form);
  const errors = mergeFieldErrors(clientErrors, save.error, submitted);
  const provider = providers.data?.find((p) => p.id === form.provider_id);
  const known = provider ? Object.keys(provider.prices).sort() : [];
  const set = (key: keyof AliasForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (save.error) save.reset();
  };

  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={alias ? `Change alias ${alias.alias}` : 'Add alias'}
      description="Every agent that names this alias will use the model you choose here."
      submitLabel="Save alias"
      pending={save.isPending}
      error={save.error}
      fields={['alias', 'provider_id', 'model', 'description', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        save.mutate(
          {
            alias: form.alias,
            body: {
              provider_id: form.provider_id,
              model: form.model.trim(),
              description: form.description.trim(),
              reason: form.reason.trim(),
            },
          },
          {
            onSuccess: (a) => {
              toast.success(`${a.alias} now points to ${a.model} on ${a.provider_name}`);
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Alias" error={errors.alias} required>
        <Input
          mono
          value={form.alias}
          onChange={(e) => set('alias', e.target.value.toLowerCase())}
          disabled={alias !== null}
          spellCheck={false}
        />
      </Field>
      <Field
        label="Provider"
        error={
          errors.provider_id ?? (providers.isError ? 'Providers could not be loaded.' : undefined)
        }
        required
      >
        <Select
          options={(providers.data ?? []).map((p) => ({
            value: p.id,
            label: `${p.name} (${p.kind_label})${p.usable ? '' : ' · not usable'}`,
          }))}
          value={form.provider_id}
          onValueChange={(v) => set('provider_id', v)}
          placeholder={providers.isPending ? 'Loading…' : 'Choose a provider'}
        />
      </Field>
      <Field
        label="Model"
        help={
          known.length
            ? `Priced models on this provider: ${known.join(', ')}. Other models are allowed but their calls have no cost.`
            : 'The model id, or the deployment name on Azure.'
        }
        error={errors.model}
        required
      >
        <Input
          mono
          value={form.model}
          onChange={(e) => set('model', e.target.value)}
          spellCheck={false}
        />
      </Field>
      <Field label="Description" error={errors.description}>
        <Input
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={1000}
        />
      </Field>
      <Field label="Reason" help="Recorded in the audit log." error={errors.reason} required>
        <Textarea
          rows={2}
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
