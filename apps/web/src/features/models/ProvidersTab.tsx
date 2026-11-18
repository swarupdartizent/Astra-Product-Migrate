import { KeyRound, PlugZap, Plus, Server, Settings2, Trash } from 'lucide-react';
import { useState } from 'react';
import {
  useCheckProvider,
  useCreateProvider,
  useDeleteProvider,
  useProviders,
  useSetCredential,
  useUpdateProvider,
} from '@/api/models';
import type { ModelProvider, ProviderKind } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { usePermissions } from '@/app/permissions';
import { hasErrors, mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Textarea,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import {
  formatUsd,
  priceRows,
  PROVIDER_KINDS,
  PROVIDER_OPTIONS,
  providerToForm,
  validateProvider,
  type ProviderForm,
} from './model';
import styles from './Models.module.css';

export function ProvidersTab() {
  const providers = useProviders();
  const { can } = usePermissions();
  const manage = can('model:manage');
  const [creating, setCreating] = useState(false);

  const addButton = manage ? (
    <Button
      variant="primary"
      leadingIcon={<Plus aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      Add provider
    </Button>
  ) : null;

  return (
    <div className={s.stack}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <p className={`${s.muted} ${s.small}`} style={{ maxWidth: '48rem' }}>
          A provider is a model service the platform may call. It can be enabled only when it is
          usable: it has a stored credential, recorded no-training terms, and an endpoint where its
          kind needs one.
        </p>
        {addButton}
      </div>
      {providers.isPending ? (
        <Skeleton height="12rem" />
      ) : providers.isError ? (
        <ApiErrorView
          error={providers.error}
          title="Could not load providers"
          onRetry={() => void providers.refetch()}
        />
      ) : providers.data.length === 0 ? (
        <EmptyState
          icon={<Server />}
          title="No model providers"
          body="Agents cannot call any model until a provider is added, given a credential and enabled."
          action={addButton}
        />
      ) : (
        providers.data.map((p) => <ProviderCard key={p.id} provider={p} manage={manage} />)
      )}
      {creating ? <ProviderDialog provider={null} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function ProviderCard({ provider: p, manage }: { provider: ModelProvider; manage: boolean }) {
  const check = useCheckProvider(p.id);
  const remove = useDeleteProvider();
  const [editing, setEditing] = useState(false);
  const [credential, setCredential] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const prices = priceRows(p.prices);

  return (
    <Card aria-labelledby={`provider-${p.id}`}>
      <CardHeader
        titleId={`provider-${p.id}`}
        title={p.name}
        description={p.kind_label}
        actions={
          <span className={s.row}>
            <StatusPill tone={p.enabled ? 'success' : 'neutral'}>
              {p.enabled ? 'Enabled' : 'Disabled'}
            </StatusPill>
            <StatusPill tone={p.usable ? 'success' : 'warning'}>
              {p.usable ? 'Usable' : 'Not usable'}
            </StatusPill>
          </span>
        }
      />
      <CardBody className={s.stack}>
        {p.problems.length > 0 ? (
          <Callout tone="warning" title="Why this provider cannot be used yet">
            <ul style={{ paddingLeft: 'var(--space-4)' }}>
              {p.problems.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        <KeyValueList
          items={[
            {
              key: 'endpoint',
              label: 'Endpoint',
              value: p.endpoint ? <Mono>{p.endpoint}</Mono> : null,
            },
            {
              key: 'api',
              label: 'API version',
              value: p.api_version ? <Mono>{p.api_version}</Mono> : null,
            },
            {
              key: 'credential',
              label: 'Credential',
              value: p.has_credential ? (
                <Badge tone="success">
                  Stored in the vault · version {p.credential_version ?? '?'}
                </Badge>
              ) : (
                <Badge tone="warning">No credential</Badge>
              ),
            },
            {
              key: 'terms',
              label: 'No training on customer data',
              value: p.no_training_terms ? (
                <span className={s.cellStack}>
                  <Badge tone="success">Terms recorded</Badge>
                  <span className={s.small} style={{ whiteSpace: 'pre-line' }}>
                    {p.terms_reference}
                  </span>
                </span>
              ) : (
                <Badge tone="warning">Not recorded</Badge>
              ),
            },
            {
              key: 'check',
              label: 'Connection test',
              value: (
                <span className={s.cellStack}>
                  <StatusPill
                    tone={
                      p.check_status === 'ok'
                        ? 'success'
                        : p.check_status === 'failed'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {p.check_status === 'ok'
                      ? 'Passed'
                      : p.check_status === 'failed'
                        ? 'Failed'
                        : 'Not tested'}
                  </StatusPill>
                  {p.check_detail ? <span className={s.small}>{p.check_detail}</span> : null}
                  {p.checked_at ? (
                    <span className={`${s.muted} ${s.xs}`}>
                      <Timestamp value={p.checked_at} />
                    </span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'regions',
              label: 'Serves regions',
              value: p.regions.length ? (
                <span className={s.badges}>
                  {p.regions.map((r) => (
                    <Badge key={r}>{r}</Badge>
                  ))}
                </span>
              ) : (
                'No region lists this provider kind'
              ),
            },
            {
              key: 'aliases',
              label: 'Used by aliases',
              value: p.aliases.length ? (
                <span className={s.badges}>
                  {p.aliases.map((a) => (
                    <Badge key={a} tone="accent">
                      {a}
                    </Badge>
                  ))}
                </span>
              ) : null,
            },
            {
              key: 'options',
              label: 'Options',
              value:
                Object.entries(p.options)
                  .filter(([, v]) => v === true)
                  .map(([k]) => PROVIDER_OPTIONS.find((o) => o.key === k)?.label ?? k)
                  .join(', ') || null,
            },
          ]}
        />
        <section aria-label={`Prices for ${p.name}`}>
          <h3 className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
            Prices (USD per million tokens)
          </h3>
          {prices.length === 0 ? (
            <p className={`${s.muted} ${s.small}`}>
              No prices configured. Calls through this provider are recorded without a cost.
            </p>
          ) : (
            <table className={styles.priceTable}>
              <caption className="sr-only">Prices per model, USD per million tokens</caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                  <th scope="col">Cache read</th>
                  <th scope="col">Cache write</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((row) => (
                  <tr key={row.model}>
                    <th scope="row">
                      <Mono>{row.model}</Mono>
                    </th>
                    <td>{formatUsd(row.input)}</td>
                    <td>{formatUsd(row.output)}</td>
                    <td>{formatUsd(row.cache_read)}</td>
                    <td>{formatUsd(row.cache_write)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {check.isError ? <FormError error={check.error} /> : null}
      </CardBody>
      {manage ? (
        <CardFooter>
          <Button
            variant="ghost"
            leadingIcon={<Trash aria-hidden="true" />}
            onClick={() => setDeleting(true)}
          >
            Delete
          </Button>
          <Button leadingIcon={<KeyRound aria-hidden="true" />} onClick={() => setCredential(true)}>
            {p.has_credential ? 'Rotate credential' : 'Set credential'}
          </Button>
          <Button
            leadingIcon={<PlugZap aria-hidden="true" />}
            loading={check.isPending}
            disabled={!p.has_credential}
            onClick={() =>
              check.mutate(undefined, {
                onSuccess: (r) =>
                  r.check_status === 'ok'
                    ? toast.success('Connection test passed', {
                        description: r.check_detail ?? undefined,
                      })
                    : toast.error('Connection test failed', {
                        description: r.check_detail ?? undefined,
                      }),
              })
            }
          >
            Test connection
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Settings2 aria-hidden="true" />}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        </CardFooter>
      ) : null}
      {editing ? <ProviderDialog provider={p} onClose={() => setEditing(false)} /> : null}
      {credential ? <CredentialDialog provider={p} onClose={() => setCredential(false)} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone="danger"
        title={`Delete ${p.name}?`}
        description="The provider and its stored credential are removed. Aliases that use it must point elsewhere first."
        confirmLabel="Delete provider"
        onConfirm={async () => {
          await remove.mutateAsync(p.id);
          toast.success(`${p.name} deleted`);
        }}
      />
    </Card>
  );
}

const FIELDS = [
  'name',
  'kind',
  'endpoint',
  'api_version',
  'no_training_terms',
  'terms_reference',
  'options',
  'enabled',
];

function ProviderDialog({
  provider,
  onClose,
}: {
  provider: ModelProvider | null;
  onClose: () => void;
}) {
  const create = useCreateProvider();
  const update = useUpdateProvider(provider?.id ?? '');
  const mutation = provider ? update : create;
  const [form, setForm] = useState<ProviderForm>(() => providerToForm(provider));
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = validateProvider(form);
  const errors = mergeFieldErrors(clientErrors, mutation.error, submitted);
  const kind = PROVIDER_KINDS.find((k) => k.value === form.kind);

  function set<K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (mutation.error) mutation.reset();
  }

  function submit() {
    setSubmitted(true);
    if (hasErrors(clientErrors) || !form.kind) return;
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      endpoint: form.endpoint.trim() || null,
      api_version: form.api_version.trim() || null,
      no_training_terms: form.no_training_terms,
      terms_reference: form.terms_reference.trim(),
      options: form.options,
    };
    if (provider) {
      update.mutate(
        { ...body, enabled: form.enabled },
        {
          onSuccess: (p) => {
            toast.success(`${p.name} saved`);
            onClose();
          },
        },
      );
    } else {
      create.mutate(body, {
        onSuccess: (p) => {
          toast.success(`${p.name} added`, {
            description: 'Set its credential, test the connection, then enable it.',
          });
          onClose();
        },
      });
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={provider ? `Edit ${provider.name}` : 'Add model provider'}
      description={
        provider
          ? undefined
          : 'New providers start disabled. Published list prices are filled in for known models.'
      }
      submitLabel={provider ? 'Save provider' : 'Add provider'}
      size="lg"
      pending={mutation.isPending}
      error={mutation.error}
      fields={FIELDS}
      onSubmit={submit}
    >
      <div className={s.grid2}>
        <Field label="Name" error={errors.name} required>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
        </Field>
        <Field
          label="Kind"
          help={provider ? 'A provider’s kind cannot change.' : undefined}
          error={errors.kind}
          required
        >
          <Select
            options={PROVIDER_KINDS.map((k) => ({ value: k.value, label: k.label }))}
            value={form.kind}
            onValueChange={(v) => set('kind', v as ProviderKind)}
            placeholder="Choose a kind"
            disabled={provider !== null}
          />
        </Field>
      </div>
      <div className={s.grid2}>
        <Field label="Endpoint" help={kind?.endpointHelp} error={errors.endpoint}>
          <Input
            value={form.endpoint}
            onChange={(e) => set('endpoint', e.target.value)}
            mono
            spellCheck={false}
            placeholder="https://"
          />
        </Field>
        <Field
          label="API version"
          help="Optional, where the provider versions its API."
          error={errors.api_version}
        >
          <Input
            value={form.api_version}
            onChange={(e) => set('api_version', e.target.value)}
            mono
          />
        </Field>
      </div>
      <Field
        label="The provider’s terms exclude training on customer data"
        help="Required before the provider can be enabled."
        error={errors.no_training_terms}
        inline
      >
        <Checkbox
          checked={form.no_training_terms}
          onCheckedChange={(v) => set('no_training_terms', v === true)}
        />
      </Field>
      <Field
        label="Where the terms are recorded"
        help="Contract, order form or provider documentation, so auditors can find them."
        error={errors.terms_reference}
        required={form.no_training_terms}
      >
        <Textarea
          rows={2}
          value={form.terms_reference}
          onChange={(e) => set('terms_reference', e.target.value)}
          maxLength={2000}
        />
      </Field>
      <fieldset className={s.stackSm} style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className={s.cellPrimary} style={{ marginBottom: 'var(--space-2)' }}>
          Options
        </legend>
        {PROVIDER_OPTIONS.map((o) => (
          <Field key={o.key} label={o.label} help={o.description} inline>
            <Switch
              checked={form.options[o.key] === true}
              onCheckedChange={(v) => set('options', { ...form.options, [o.key]: v })}
            />
          </Field>
        ))}
        {errors.options ? <p className={styles.error}>{errors.options}</p> : null}
      </fieldset>
      {provider ? (
        <Field
          label="Enabled"
          help={
            provider.usable
              ? 'Agents can call models through this provider.'
              : 'It can be enabled once it is usable.'
          }
          error={errors.enabled}
          inline
        >
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
        </Field>
      ) : null}
    </FormDialog>
  );
}

function CredentialDialog({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const save = useSetCredential(provider.id);
  const [key, setKey] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const clientError =
    key.trim().length < 8 ? 'Paste the API key (at least 8 characters).' : undefined;
  const errors = mergeFieldErrors(
    clientError ? { api_key: clientError } : {},
    save.error,
    submitted,
  );
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${provider.has_credential ? 'Rotate' : 'Set'} credential for ${provider.name}`}
      description="The key is stored in the vault and never shown again, here or anywhere else. Storing it resets the connection test."
      submitLabel="Store credential"
      size="sm"
      pending={save.isPending}
      error={save.error}
      fields={['api_key']}
      onSubmit={() => {
        setSubmitted(true);
        if (clientError) return;
        save.mutate(key.trim(), {
          onSuccess: (p) => {
            toast.success('Credential stored', {
              description: `Version ${p.credential_version ?? '?'}`,
            });
            onClose();
          },
        });
      }}
    >
      <Field label="API key" error={errors.api_key} required>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
        />
      </Field>
    </FormDialog>
  );
}
