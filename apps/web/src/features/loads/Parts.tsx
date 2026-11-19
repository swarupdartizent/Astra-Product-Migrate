import { CircleExclamationPoint } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useUsers } from '@/api/access';
import { isApiError } from '@/api/errors';
import type { LoadRun } from '@/api/loads-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Field, Input, Select } from '@/ui';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import { isUuid, runLabel } from './model';

const NONE = '__none__';

/** Picks one of the project's load runs (newest first). */
export function RunPicker({
  runs,
  value,
  onChange,
  label = 'Load run',
}: {
  runs: LoadRun[];
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <Field label={label}>
      <Select
        size="sm"
        options={runs.map((r) => ({ value: r.id, label: runLabel(r) }))}
        value={value ?? ''}
        onValueChange={onChange}
        placeholder={runs.length ? 'Choose a run' : 'No runs yet'}
        disabled={runs.length === 0}
      />
    </Field>
  );
}

/**
 * Chooses an active person. Lists people when the caller may (GET /users needs access reading);
 * otherwise the person's user ID is entered, checked as a UUID, and the API checks the person.
 */
export function PersonField({
  label,
  value,
  currentName,
  onChange,
  error,
  help,
  disabled = false,
}: {
  label: string;
  value: string;
  currentName: string | null;
  onChange: (id: string) => void;
  error?: string | undefined;
  help?: ReactNode;
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const users = useUsers(q);
  const forbidden = isApiError(users.error) && users.error.status === 403;
  if (forbidden) {
    const bad = value.trim() !== '' && !isUuid(value);
    return (
      <Field
        label={`${label} (user ID)`}
        help={
          <>
            You cannot list people on this platform, so enter the person’s user ID. They can find it
            on their profile; an administrator sees it on the Access page.
            {currentName ? ` Currently: ${currentName}.` : ''}
          </>
        }
        error={
          error ?? (bad ? 'A user ID looks like 00000000-0000-0000-0000-000000000000.' : undefined)
        }
        disabled={disabled}
      >
        <Input
          mono
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          maxLength={36}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    );
  }
  const options = [
    { value: NONE, label: 'Nobody chosen' },
    ...(value && !users.data?.some((u) => u.id === value)
      ? [{ value, label: currentName ?? 'Current choice' }]
      : []),
    ...(users.data ?? [])
      .filter((u) => u.status === 'active')
      .map((u) => ({ value: u.id, label: `${u.display_name} (${u.email})` })),
  ];
  return (
    <div className={s.stackSm}>
      <Field label={`Find a person for ${label.toLowerCase()}`} help="Search by name or email.">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} disabled={disabled} />
      </Field>
      {users.isError ? (
        <ApiErrorView error={users.error} title="Could not list people" compact />
      ) : null}
      <Field label={label} error={error} help={help} disabled={disabled}>
        <Select
          options={options}
          value={value || NONE}
          onValueChange={(v) => onChange(v === NONE ? '' : v)}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}

/** A visible "differs" marker next to a highlighted amount (never colour alone). */
export function DiffMark({ children = 'Differs' }: { children?: ReactNode }) {
  return (
    <span className={styles.diffMark}>
      <CircleExclamationPoint aria-hidden="true" />
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'success' | undefined;
}) {
  return (
    <div className={styles.stat} data-tone={tone}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

/** Text that explains why an action is disabled, linked with aria-describedby. */
export function Why({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className={`${s.muted} ${s.small}`}>
      {children}
    </span>
  );
}
