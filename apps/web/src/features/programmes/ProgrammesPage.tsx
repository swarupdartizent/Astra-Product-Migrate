import { Link } from '@tanstack/react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAddPartner, useCreateProgramme, useProgrammes } from '@/api/tenancy';
import type { Programme } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { usePermissions } from '@/app/permissions';
import { RequirePermission } from '@/app/RequirePermission';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Button,
  Card,
  CardBody,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Textarea,
  toast,
  type DataTableColumn,
} from '@/ui';
import { VendorChangesSheet } from './VendorChangesSheet';
import s from '../shared.module.css';

const col = createDataTableColumns<Programme>();
const baseColumns = col.columns([
  col.accessor('name', {
    header: 'Programme',
    size: 320,
    cell: (info) => (
      <span className={s.cellStack}>
        <Link
          to="/programmes/$programmeId"
          params={{ programmeId: info.row.original.id }}
          className={s.cellLink}
        >
          {info.getValue()}
        </Link>
        {info.row.original.description ? (
          <span className={`${s.muted} ${s.small}`}>{info.row.original.description}</span>
        ) : null}
      </span>
    ),
  }),
  col.accessor((row) => row.partners.length, {
    id: 'partners',
    header: 'Partners',
    size: 380,
    cell: (info) => {
      const partners = info.row.original.partners;
      if (partners.length === 0) return <span className={s.muted}>No partners yet</span>;
      return (
        <span className={s.badges}>
          {partners.map((p) => (
            <Badge key={p.id}>{p.name}</Badge>
          ))}
        </span>
      );
    },
  }),
]);

export function ProgrammesPage() {
  return (
    <RequirePermission permission="tenant:read">
      <ProgrammesView />
    </RequirePermission>
  );
}

function validateName(name: string): string | undefined {
  const n = name.trim().length;
  return n < 2 || n > 200 ? 'Use 2–200 characters.' : undefined;
}

function ProgrammesView() {
  const [vendorFor, setVendorFor] = useState<Programme | null>(null);
  useDocumentTitle('Programmes');
  const programmes = useProgrammes();
  const { can } = usePermissions();
  const canManage = can('programme:manage');
  const [creating, setCreating] = useState(false);
  const [addingTo, setAddingTo] = useState<Programme | null>(null);

  const vendorColumn = col.display({
    id: 'vendor',
    header: () => <span className="sr-only">Vendor changes</span>,
    size: 150,
    enableSorting: false,
    enableResizing: false,
    cell: (info) => (
      <span className={s.rowActions}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setVendorFor(info.row.original)}
          aria-label={`Vendor changes for ${info.row.original.name}`}
        >
          Vendor changes
        </Button>
      </span>
    ),
  });
  const columns = useMemo<DataTableColumn<Programme>[]>(
    () =>
      canManage
        ? [
            ...baseColumns,
            vendorColumn,
            col.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              size: 140,
              enableSorting: false,
              enableResizing: false,
              cell: (info) => (
                <span className={s.rowActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<Plus aria-hidden="true" />}
                    onClick={() => setAddingTo(info.row.original)}
                    aria-label={`Add partner to ${info.row.original.name}`}
                  >
                    Add partner
                  </Button>
                </span>
              ),
            }),
          ]
        : [...baseColumns, vendorColumn],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vendorColumn only calls a state setter
    [canManage],
  );

  const newButton = canManage ? (
    <Button
      variant="primary"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      New programme
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Programmes"
        description="An installed-base programme groups the tenants migrated together. Partners deliver within a programme and see only the tenants assigned to them."
        actions={newButton}
      />
      <Card flush aria-label="Programmes">
        <CardBody>
          {programmes.isError ? (
            <ApiErrorView
              error={programmes.error}
              title="Could not load programmes"
              onRetry={() => void programmes.refetch()}
              retrying={programmes.isFetching}
              compact
            />
          ) : (
            <DataTable
              label="Programmes"
              data={programmes.data}
              columns={columns}
              getRowId={(p) => p.id}
              loading={programmes.isPending}
              initialSorting={[{ id: 'name', desc: false }]}
              empty={
                <EmptyState
                  compact
                  icon={<FolderKanban />}
                  title="No programmes"
                  body={
                    canManage
                      ? 'Create a programme to group tenants and partners.'
                      : 'There are no programmes you can see.'
                  }
                  action={newButton}
                />
              }
            />
          )}
        </CardBody>
      </Card>
      {creating ? <CreateProgrammeDialog onClose={() => setCreating(false)} /> : null}
      {vendorFor ? (
        <VendorChangesSheet programme={vendorFor} onClose={() => setVendorFor(null)} />
      ) : null}
      {addingTo ? (
        <AddPartnerDialog programme={addingTo} onClose={() => setAddingTo(null)} />
      ) : null}
    </>
  );
}

function CreateProgrammeDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateProgramme();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'name' | 'description'> = {};
  const nameError = validateName(name);
  if (nameError) clientErrors.name = nameError;
  if (description.length > 2000) clientErrors.description = 'Use at most 2000 characters.';
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="New programme"
      submitLabel="Create programme"
      pending={create.isPending}
      error={create.error}
      fields={['name', 'description']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        create.mutate(
          { name: name.trim(), description: description.trim() },
          {
            onSuccess: (p) => {
              toast.success(`Programme ${p.name} created`);
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Name" error={errors.name} required>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (create.error) create.reset();
          }}
          maxLength={200}
          autoComplete="off"
        />
      </Field>
      <Field label="Description" error={errors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

export function AddPartnerDialog({
  programme,
  onClose,
}: {
  programme: Programme;
  onClose: () => void;
}) {
  const add = useAddPartner(programme.id);
  const [name, setName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<'name'> = {};
  const nameError = validateName(name);
  if (nameError) clientErrors.name = nameError;
  const errors = mergeFieldErrors(clientErrors, add.error, submitted);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Add partner to ${programme.name}`}
      description="Partners deliver migrations within this programme. People granted a role at a partner see only that partner's tenants."
      submitLabel="Add partner"
      size="sm"
      pending={add.isPending}
      error={add.error}
      fields={['name']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        add.mutate(
          { name: name.trim() },
          {
            onSuccess: (p) => {
              toast.success(`Partner ${p.name} added to ${programme.name}`);
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Partner name" error={errors.name} required>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (add.error) add.reset();
          }}
          maxLength={200}
          autoComplete="off"
        />
      </Field>
    </FormDialog>
  );
}
