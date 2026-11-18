import { useState } from 'react';
import { useUsers } from '@/api/access';
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
