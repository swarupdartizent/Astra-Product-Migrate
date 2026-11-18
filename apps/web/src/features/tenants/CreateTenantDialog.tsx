import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useCreateTenant, useProgrammes, useRegions } from '@/api/tenancy';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import { Field, Input, Select, Spinner, Switch, toast } from '@/ui';
import s from '../shared.module.css';
import {
  TIMEOUT_DEFAULT,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  formatMinutes,
  validateCreateTenant,
  type CreateTenantForm,
} from './model';

const NONE = '__none__';
const FIELDS = [
  'slug',
  'name',
  'region_code',
  'programme_id',
  'partner_id',
  'mfa_required',
  'session_timeout_minutes',
] as const;

export interface CreateTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTenantDialog({ open, onOpenChange }: CreateTenantDialogProps) {
  const navigate = useNavigate();
  const regions = useRegions();
  const programmes = useProgrammes();
  const create = useCreateTenant();
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<CreateTenantForm>({
    slug: '',
    name: '',
    region_code: '',
    programme_id: '',
    partner_id: '',
    mfa_required: true,
    session_timeout_minutes: String(TIMEOUT_DEFAULT),
  });

  const clientErrors = validateCreateTenant(form);
  const errors = mergeFieldErrors(clientErrors, create.error, submitted);
  const programme = programmes.data?.find((p) => p.id === form.programme_id);
  const regionName = regions.data?.find((r) => r.code === form.region_code)?.name;

  const regionOptions = useMemo(
    () =>
      (regions.data ?? []).map((r) => ({
        value: r.code,
        label: `${r.name} (${r.code}) · ${r.jurisdiction}`,
      })),
    [regions.data],
  );
  const programmeOptions = useMemo(
    () => [
      { value: NONE, label: 'No programme' },
      ...(programmes.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    ],
    [programmes.data],
  );
  const partnerOptions = [
    { value: NONE, label: 'No partner' },
    ...(programme?.partners ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];

  function update<K extends keyof CreateTenantForm>(key: K, value: CreateTenantForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (create.error) create.reset();
  }

  function submit() {
    setSubmitted(true);
    if (hasErrors(clientErrors)) return;
    create.mutate(
      {
        slug: form.slug,
        name: form.name.trim(),
        region_code: form.region_code,
        programme_id: form.programme_id || null,
        partner_id: form.partner_id || null,
        mfa_required: form.mfa_required,
        session_timeout_minutes: Number(form.session_timeout_minutes),
      },
      {
        onSuccess: (tenant) => {
          if (tenant.status === 'failed') {
            toast.error(`${tenant.name} could not be provisioned`, {
              description: tenant.status_detail ?? 'See the tenant for details.',
            });
          } else if (tenant.active_job || tenant.status === 'provisioning') {
            toast.info(`Provisioning ${tenant.name}`, {
              description:
                'The database, role and key are being built. Progress shows on the tenant page.',
            });
          } else {
            toast.success(`Tenant ${tenant.name} created`, {
              description: `Storage and key are ready in ${tenant.region_name ?? tenant.region_code}.`,
            });
          }
          onOpenChange(false);
          void navigate({ to: '/tenants/$tenantId', params: { tenantId: tenant.id } });
        },
      },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New tenant"
      description="A tenant is one customer's isolated workspace: its own database, database role and encryption key."
      submitLabel="Create tenant"
      onSubmit={submit}
      pending={create.isPending}
      error={create.error}
      fields={FIELDS}
      size="lg"
      progress={
        <span className={`${s.row} ${s.muted}`}>
          <Spinner />
          Building the database, database role and encryption key
          {regionName ? ` in ${regionName}` : ''}. This takes a few seconds.
        </span>
      }
    >
      <div className={s.grid2}>
        <Field label="Name" error={errors.name} required>
          <Input
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            autoComplete="off"
            maxLength={200}
          />
        </Field>
        <Field
          label="Short name"
          help="Used in identifiers. Lowercase letters, digits and hyphens. Reserved for good, even after deletion."
          error={errors.slug}
          required
        >
          <Input
            value={form.slug}
            onChange={(e) => update('slug', e.target.value.toLowerCase())}
            autoComplete="off"
            spellCheck={false}
            mono
            maxLength={32}
          />
        </Field>
      </div>
      <Field
        label="Region"
        help="Where the tenant's data is stored. The region is fixed at creation; moving later is a recorded region migration."
        error={errors.region_code ?? (regions.isError ? 'Regions could not be loaded.' : undefined)}
        required
      >
        <Select
          options={regionOptions}
          value={form.region_code}
          onValueChange={(v) => update('region_code', v)}
          placeholder={regions.isPending ? 'Loading regions…' : 'Choose a region'}
          disabled={regions.isPending}
        />
      </Field>
      <div className={s.grid2}>
        <Field
          label="Programme"
          help="Optional. Programme owners manage the tenants in their programme."
          error={
            errors.programme_id ??
            (programmes.isError ? 'Programmes could not be loaded.' : undefined)
          }
        >
          <Select
            options={programmeOptions}
            value={form.programme_id || NONE}
            onValueChange={(v) => {
              update('programme_id', v === NONE ? '' : v);
              update('partner_id', '');
            }}
            disabled={programmes.isPending}
          />
        </Field>
        <Field
          label="Partner"
          help={
            programme
              ? 'Partners see only the tenants assigned to them.'
              : 'Choose a programme first.'
          }
          error={errors.partner_id}
        >
          <Select
            options={partnerOptions}
            value={form.partner_id || NONE}
            onValueChange={(v) => update('partner_id', v === NONE ? '' : v)}
            disabled={!programme || programme.partners.length === 0}
          />
        </Field>
      </div>
      <div className={s.grid2}>
        <Field
          label="Require multi-factor sign-in"
          help="Everyone acting on this tenant must sign in with a second factor."
          error={errors.mfa_required}
          inline
        >
          <Switch checked={form.mfa_required} onCheckedChange={(v) => update('mfa_required', v)} />
        </Field>
        <Field
          label="Session timeout (minutes)"
          help={
            errors.session_timeout_minutes
              ? `${TIMEOUT_MIN}–${TIMEOUT_MAX} minutes.`
              : `Sign-ins older than ${formatMinutes(Number(form.session_timeout_minutes))} must sign in again for this tenant.`
          }
          error={errors.session_timeout_minutes}
          required
        >
          <Input
            type="number"
            inputMode="numeric"
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            step={1}
            value={form.session_timeout_minutes}
            onChange={(e) => update('session_timeout_minutes', e.target.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
