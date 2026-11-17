import { useNavigate } from '@tanstack/react-router';
import { Trash } from 'lucide-react';
import { useState } from 'react';
import { useDeleteTenant } from '@/api/tenancy';
import type { Tenant } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, reasonError, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Mono,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';

export function DangerZoneTab({ tenant }: { tenant: Tenant }) {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="danger-title">
      <CardHeader
        titleId="danger-title"
        title="Delete this tenant"
        description="Crypto-shredding: permanent and immediate."
        actions={
          <Button
            variant="danger"
            size="sm"
            leadingIcon={<Trash aria-hidden="true" />}
            onClick={() => setOpen(true)}
            disabled={tenant.status !== 'active' && tenant.status !== 'failed'}
          >
            Delete tenant
          </Button>
        }
      />
      <CardBody className={s.prose}>
        <p>Deleting a tenant:</p>
        <ul style={{ paddingLeft: 'var(--space-5)', marginTop: 'var(--space-2)' }}>
          <li>drops its database and database role,</li>
          <li>destroys every connector secret stored for it,</li>
          <li>
            destroys its encryption key <Mono>{tenant.key_name}</Mono>, so any copy of its data
            (backups included) becomes unreadable.
          </li>
        </ul>
        <p>
          It cannot be undone. The audit record of the tenant and its deletion is kept, and the
          short name <Mono>{tenant.slug}</Mono> stays reserved.
        </p>
      </CardBody>
      {open ? <DeleteTenantDialog tenant={tenant} onClose={() => setOpen(false)} /> : null}
    </Card>
  );
}

interface DeleteForm {
  confirm_slug: string;
  reason: string;
}

function DeleteTenantDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const navigate = useNavigate();
  const remove = useDeleteTenant(tenant.id);
  const [form, setForm] = useState<DeleteForm>({ confirm_slug: '', reason: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<keyof DeleteForm> = {};
  if (form.confirm_slug !== tenant.slug) {
    clientErrors.confirm_slug = `Type ${tenant.slug} exactly to confirm.`;
  }
  const reason = reasonError(form.reason);
  if (reason) clientErrors.reason = reason;
  const errors = mergeFieldErrors(clientErrors, remove.error, submitted);

  function set(key: keyof DeleteForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (remove.error) remove.reset();
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      tone="danger"
      size="sm"
      title={`Delete ${tenant.name}?`}
      description="The database is dropped, secrets are destroyed and the encryption key is destroyed. This cannot be undone."
      submitLabel="Delete tenant permanently"
      pending={remove.isPending}
      error={remove.error}
      fields={['confirm_slug', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        remove.mutate(
          { confirm_slug: form.confirm_slug, reason: form.reason.trim() },
          {
            onSuccess: () => {
              toast.success(`${tenant.name} deleted`, {
                description: 'Data, secrets and key destroyed. The audit record is kept.',
              });
              onClose();
              void navigate({ to: '/tenants' });
            },
          },
        );
      }}
    >
      <Callout tone="danger" title="This is permanent">
        Nothing can recover this tenant&apos;s data once its key is destroyed.
      </Callout>
      <Field
        label={
          <>
            Type <Mono chip>{tenant.slug}</Mono> to confirm
          </>
        }
        error={errors.confirm_slug}
        required
      >
        <Input
          value={form.confirm_slug}
          onChange={(e) => set('confirm_slug', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          mono
        />
      </Field>
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={errors.reason}
        required
      >
        <Textarea
          rows={3}
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          maxLength={1000}
        />
      </Field>
    </FormDialog>
  );
}
