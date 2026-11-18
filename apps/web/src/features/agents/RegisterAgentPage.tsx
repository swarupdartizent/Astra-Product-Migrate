import { useNavigate } from '@tanstack/react-router';
import { FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { useManifestValidation, useRegisterAgentVersion } from '@/api/agents';
import { isApiError } from '@/api/errors';
import { FormError } from '@/app/FormError';
import { RequirePermission } from '@/app/RequirePermission';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Mono,
  PageHeader,
  Spinner,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { describeFieldPath } from './model';

export function RegisterAgentPage() {
  return (
    <RequirePermission permission="agent:manage">
      <RegisterAgent />
    </RequirePermission>
  );
}

function RegisterAgent() {
  useDocumentTitle('Register an agent version');
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const debounced = useDebouncedValue(text, 500);
  const validation = useManifestValidation(debounced);
  const register = useRegisterAgentVersion();
  const checking = validation.isFetching || debounced !== text;
  const serverErrors =
    isApiError(register.error) && register.error.fieldErrorList.length > 0
      ? register.error.fieldErrorList
      : [];
  const issues = serverErrors.length > 0 ? serverErrors : (validation.data?.errors ?? []);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Agents', to: '/agents' }, { label: 'Register a version' }]}
        title="Register an agent version"
        description="Paste the agent's manifest. It is registered as a draft; its test suite must pass on this exact manifest before it can be released."
      />
      <div className={s.stack}>
        <Card aria-labelledby="manifest-title">
          <CardHeader titleId="manifest-title" title="Manifest (YAML)" />
          <CardBody className={s.stack}>
            <Field
              label="Manifest"
              hideLabel
              help="Checked as you type. Nothing is stored until you register."
            >
              <Textarea
                mono
                rows={28}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (register.error) register.reset();
                }}
                spellCheck={false}
                autoCapitalize="off"
                wrap="off"
              />
            </Field>
            <div className={s.row} role="status" aria-live="polite">
              {text.trim().length < 10 ? (
                <span className={s.muted}>Paste a manifest to check it.</span>
              ) : checking ? (
                <span className={s.row}>
                  <Spinner size={14} /> Checking…
                </span>
              ) : validation.data?.valid && serverErrors.length === 0 ? (
                <StatusPill tone="success">The manifest is valid</StatusPill>
              ) : (
                <StatusPill tone="danger">
                  {issues.length} problem{issues.length === 1 ? '' : 's'}
                </StatusPill>
              )}
            </div>
            {issues.length > 0 && text.trim().length >= 10 ? (
              <Callout tone="danger" title="Fix these before registering">
                <ul style={{ paddingLeft: 'var(--space-4)' }}>
                  {issues.map((e, i) => (
                    <li key={i}>
                      <Mono className={s.small}>{e.field}</Mono>
                      {e.field.includes('.') ? (
                        <span className={`${s.muted} ${s.xs}`}>
                          {' '}
                          ({describeFieldPath(e.field)})
                        </span>
                      ) : null}
                      : {e.message}
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {register.error && serverErrors.length === 0 ? (
              <FormError error={register.error} />
            ) : null}
            <div>
              <Button
                variant="primary"
                leadingIcon={<FilePlus2 aria-hidden="true" />}
                loading={register.isPending}
                disabled={text.trim().length < 10}
                onClick={() =>
                  register.mutate(text, {
                    onSuccess: (v) => {
                      toast.success(`${v.agent} ${v.version} registered as a draft`, {
                        description: 'Run its test suite next.',
                      });
                      void navigate({
                        to: '/agents/$name/$version',
                        params: { name: v.agent, version: v.version },
                        search: { tab: 'tests' },
                      });
                    },
                  })
                }
              >
                Register as draft
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
