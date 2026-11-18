import { useState } from 'react';
import { useUsers } from '@/api/access';
import { useScopeKeys } from '@/api/planning';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Button, Field, Input, Select } from '@/ui';
import s from '../shared.module.css';

const NOBODY = '__none__';

/** Previous / next paging with a live "1–50 of 230" status. */
export function Pager({
  offset,
  limit,
  total,
  onOffset,
}: {
  offset: number;
  limit: number;
  total: number;
  onOffset: (n: number) => void;
}) {
  return (
    <div className={s.toolbar} style={{ justifyContent: 'space-between' }}>
      <span className={`${s.muted} ${s.small}`} aria-live="polite">
        {total === 0
          ? 'No rows'
          : `${String(offset + 1)}–${String(Math.min(offset + limit, total))} of ${total.toLocaleString()}`}
      </span>
      <span className={s.row}>
        <Button
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          disabled={offset + limit >= total}
          onClick={() => onOffset(offset + limit)}
        >
          Next
        </Button>
      </span>
    </div>
  );
}

/**
 * Person picker over GET /users (the access screens' listing). That listing needs access:read;
 * without it the API's refusal is shown and only the current choice can be kept or cleared.
 */
export function PersonPicker({
  label,
  value,
  currentName,
  onChange,
  error,
}: {
  label: string;
  value: string;
  currentName: string | null;
  onChange: (id: string) => void;
  error?: string | undefined;
}) {
  const [q, setQ] = useState('');
  const users = useUsers(q);
  const options = [
    { value: NOBODY, label: 'Nobody' },
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
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      {users.isError ? (
        <ApiErrorView error={users.error} title="Could not list people" compact />
      ) : null}
      <Field label={label} error={error}>
        <Select
          options={options}
          value={value || NOBODY}
          onValueChange={(v) => onChange(v === NOBODY ? '' : v)}
        />
      </Field>
    </div>
  );
}

/**
 * Scope item picker over GET /plan/scope/keys: type to search by key or element name, then
 * choose from the first 50 matches.
 */
export function ScopeKeyPicker({
  projectId,
  label,
  value,
  onChange,
  error,
  help,
  required = false,
}: {
  projectId: string;
  label: string;
  value: string;
  onChange: (key: string) => void;
  error?: string | undefined;
  help?: string;
  required?: boolean;
}) {
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 250);
  const keys = useScopeKeys(projectId, dq);
  const rows = keys.data ?? [];
  const options = [
    ...(value && !rows.some((r) => r.key === value) ? [{ value, label: value }] : []),
    ...rows.map((r) => ({ value: r.key, label: `${r.element} (${r.stream}, ${r.key})` })),
  ];
  return (
    <div className={s.stackSm}>
      <Field
        label={`Find ${label.toLowerCase()}`}
        help="Search by element name or scope key. The first 50 matches are listed."
      >
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      {keys.isError ? (
        <ApiErrorView error={keys.error} title="Could not search the scope register" compact />
      ) : null}
      <Field label={label} error={error} help={help} required={required}>
        <Select
          options={options}
          value={value}
          onValueChange={onChange}
          placeholder={
            keys.isPending ? 'Loading…' : rows.length === 0 ? 'No matching items' : 'Choose an item'
          }
          disabled={options.length === 0}
        />
      </Field>
    </div>
  );
}
