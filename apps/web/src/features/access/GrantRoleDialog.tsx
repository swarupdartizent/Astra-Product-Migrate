import { useState } from 'react';
import { useGrantRole } from '@/api/access';
import { useProgrammes, useRoles, useTenants } from '@/api/tenancy';
import type { ScopeType, User } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { Field, Select, toast } from '@/ui';
import { grantableScopes, SCOPE_LABELS, scopeOptions } from './model';

interface GrantForm {
  role: string;
  scope_type: ScopeType | '';
  scope_id: string;
}

export function GrantRoleDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const roles = useRoles();
  const programmes = useProgrammes();
  const tenants = useTenants();
  const grant = useGrantRole();
  const [form, setForm] = useState<GrantForm>({ role: '', scope_type: '', scope_id: '' });
  const [submitted, setSubmitted] = useState(false);

  const role = roles.data?.find((r) => r.key === form.role);
  const scopes = grantableScopes(role);
  const options = scopeOptions(form.scope_type, programmes.data ?? [], tenants.data ?? []);
  const needsScopeId = form.scope_type !== '' && form.scope_type !== 'platform';

  const clientErrors: FieldErrors<keyof GrantForm> = {};
  if (!form.role) clientErrors.role = 'Choose a role.';
  if (!form.scope_type) clientErrors.scope_type = 'Choose where the role applies.';
  if (needsScopeId && !form.scope_id) {
    clientErrors.scope_id = `Choose the ${SCOPE_LABELS[form.scope_type as ScopeType].toLowerCase()}.`;
  }
  const errors = mergeFieldErrors(clientErrors, grant.error, submitted);

  function setRole(key: string) {
    const next = roles.data?.find((r) => r.key === key);
    const allowed = grantableScopes(next);
    setForm({
      role: key,
      // Keep the scope type when still allowed; preselect when there is only one choice.
      scope_type:
        form.scope_type && allowed.includes(form.scope_type)
          ? form.scope_type
          : allowed.length === 1
            ? (allowed[0] ?? '')
            : '',
      scope_id: '',
    });
    if (grant.error) grant.reset();
  }

  const scopeLabel = form.scope_type ? SCOPE_LABELS[form.scope_type] : 'Scope';
  const loadingScope =
    (form.scope_type === 'tenant' && tenants.isPending) ||
    ((form.scope_type === 'programme' || form.scope_type === 'partner') && programmes.isPending);

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Grant a role to ${user.display_name}`}
      description="The role's permissions apply to everything inside the chosen scope. You can grant only within the scopes you manage."
      submitLabel="Grant role"
      pending={grant.isPending}
      error={grant.error}
      fields={['role', 'scope_type', 'scope_id', 'user_id']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors) || !form.scope_type) return;
        grant.mutate(
          {
            user_id: user.id,
            role: form.role,
            scope_type: form.scope_type,
            scope_id: needsScopeId ? form.scope_id : null,
          },
          {
            onSuccess: (a) => {
              toast.success(`${a.role_label} granted to ${user.display_name}`, {
                description: a.scope_name ?? SCOPE_LABELS[a.scope_type],
              });
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Role"
        help={role ? role.description : 'What the person can do.'}
        error={errors.role ?? (roles.isError ? 'Roles could not be loaded.' : undefined)}
        required
      >
        <Select
          options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.label }))}
          value={form.role}
          onValueChange={setRole}
          placeholder={roles.isPending ? 'Loading roles…' : 'Choose a role'}
          disabled={roles.isPending}
        />
      </Field>
      <Field
        label="Applies to"
        help={
          role
            ? `${role.label} can be granted at: ${scopes.map((x) => SCOPE_LABELS[x].toLowerCase()).join(', ')}.`
            : 'Choose a role first.'
        }
        error={errors.scope_type}
        required
      >
        <Select
          options={scopes.map((x) => ({ value: x, label: SCOPE_LABELS[x] }))}
          value={form.scope_type}
          onValueChange={(v) => {
            setForm((prev) => ({ ...prev, scope_type: v as ScopeType, scope_id: '' }));
            if (grant.error) grant.reset();
          }}
          placeholder="Choose a scope type"
          disabled={!role}
        />
      </Field>
      {needsScopeId ? (
        <Field
          label={scopeLabel}
          error={errors.scope_id}
          help={
            options.length === 0 && !loadingScope
              ? `There are no ${scopeLabel.toLowerCase()}s you can see.`
              : undefined
          }
          required
        >
          <Select
            options={options}
            value={form.scope_id}
            onValueChange={(v) => {
              setForm((prev) => ({ ...prev, scope_id: v }));
              if (grant.error) grant.reset();
            }}
            placeholder={loadingScope ? 'Loading…' : `Choose a ${scopeLabel.toLowerCase()}`}
            disabled={loadingScope || options.length === 0}
          />
        </Field>
      ) : null}
    </FormDialog>
  );
}
