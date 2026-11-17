import { useState, type SyntheticEvent } from 'react';
import { isApiError } from '@/api/errors';
import { useUpdatePolicy } from '@/api/tenancy';
import type { Tenant } from '@/api/types';
import { FormError } from '@/app/FormError';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  Input,
  Switch,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import {
  TIMEOUT_MAX,
  TIMEOUT_MIN,
  can,
  formatMinutes,
  validatePolicy,
  type PolicyForm,
} from './model';

const FIELDS = ['mfa_required', 'session_timeout_minutes', 'reason'] as const;

function initial(t: Tenant): PolicyForm {
  return {
    mfa_required: t.mfa_required,
    session_timeout_minutes: String(t.session_timeout_minutes),
    reason: '',
  };
}

export function PolicyTab({ tenant }: { tenant: Tenant }) {
  // Remount the form whenever the saved policy changes, so it always starts from the server.
  const key = `${tenant.mfa_required}-${tenant.session_timeout_minutes}`;
  return <PolicyFormCard key={key} tenant={tenant} />;
}

function PolicyFormCard({ tenant }: { tenant: Tenant }) {
  const editable = can(tenant, 'tenant:update_policy');
  const update = useUpdatePolicy(tenant.id);
  const [form, setForm] = useState<PolicyForm>(() => initial(tenant));
  const [submitted, setSubmitted] = useState(false);

  const current = {
    mfa_required: tenant.mfa_required,
    session_timeout_minutes: tenant.session_timeout_minutes,
  };
  const { errors: clientErrors, loosening, changed } = validatePolicy(current, form);
  const serverWantsReason =
    isApiError(update.error) && update.error.problem.type.endsWith('/reason-required');
  const errors = mergeFieldErrors(clientErrors, update.error, submitted);
  if (serverWantsReason && !errors.reason && isApiError(update.error)) {
    errors.reason = update.error.detail ?? update.error.title;
  }
  const reasonRequired = loosening || serverWantsReason;

  function set<K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (update.error) update.reset();
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (hasErrors(clientErrors) || !changed) return;
    update.mutate(
      {
        mfa_required: form.mfa_required,
        session_timeout_minutes: Number(form.session_timeout_minutes),
        reason: form.reason.trim(),
      },
      {
        onSuccess: () =>
          toast.success('Security policy saved', {
            description: 'The change is in the audit log.',
          }),
      },
    );
  }

  return (
    <Card aria-labelledby="policy-title">
      <CardHeader
        titleId="policy-title"
        title="Security policy"
        description="Applies to everyone acting on this tenant, administrators included."
      />
      <form onSubmit={submit} noValidate>
        <CardBody className={s.stack}>
          {!editable ? (
            <Callout tone="info" title="Read only">
              You need the permission to update this tenant&apos;s policy to change it.
            </Callout>
          ) : null}
          <Field
            label="Require multi-factor sign-in"
            help="People must have signed in with a second factor to act on this tenant."
            error={errors.mfa_required}
            disabled={!editable}
            inline
          >
            <Switch checked={form.mfa_required} onCheckedChange={(v) => set('mfa_required', v)} />
          </Field>
          <Field
            label="Session timeout (minutes)"
            help={`${TIMEOUT_MIN}–${TIMEOUT_MAX}. Currently ${formatMinutes(tenant.session_timeout_minutes)}: older sign-ins must sign in again for this tenant.`}
            error={errors.session_timeout_minutes}
            disabled={!editable}
            required
          >
            <Input
              type="number"
              inputMode="numeric"
              min={TIMEOUT_MIN}
              max={TIMEOUT_MAX}
              step={1}
              value={form.session_timeout_minutes}
              onChange={(e) => set('session_timeout_minutes', e.target.value)}
              style={{ maxWidth: '12rem' }}
            />
          </Field>
          {loosening ? (
            <Callout tone="warning" title="This weakens the security policy" live>
              {!form.mfa_required && tenant.mfa_required
                ? 'Turning off multi-factor sign-in'
                : 'Lengthening the session timeout'}{' '}
              needs a written reason of at least 10 characters. It is recorded in the audit log.
            </Callout>
          ) : null}
          {editable ? (
            <Field
              label="Reason"
              help={
                reasonRequired
                  ? 'Required for this change. Recorded in the audit log.'
                  : 'Optional for changes that tighten the policy. Recorded in the audit log.'
              }
              error={errors.reason}
              required={reasonRequired}
            >
              <Textarea
                rows={3}
                value={form.reason}
                onChange={(e) => set('reason', e.target.value)}
                maxLength={1000}
              />
            </Field>
          ) : null}
          {serverWantsReason ? null : <FormError error={update.error} fields={FIELDS} />}
        </CardBody>
        {editable ? (
          <CardFooter>
            <Button
              variant="secondary"
              disabled={!changed || update.isPending}
              onClick={() => {
                setForm(initial(tenant));
                setSubmitted(false);
                update.reset();
              }}
            >
              Discard changes
            </Button>
            <Button type="submit" variant="primary" loading={update.isPending} disabled={!changed}>
              Save policy
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}
