import { Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { useAddTrap, useSetTrapActive, useTraps } from '@/api/adapters';
import { isApiError } from '@/api/errors';
import type { AdapterTrap } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { usePermissions } from '@/app/permissions';
import { reasonError } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Mono,
  PlainText,
  Skeleton,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import { parseDefinition, SEVERITY_TONE, TRAP_TEMPLATE, trapFieldLabel } from './model';

export function TrapsPanel({ name, version }: { name: string; version: string }) {
  const traps = useTraps(name, version);
  const { can } = usePermissions();
  const curate = can('trap:curate');
  const [adding, setAdding] = useState(false);
  const [toggling, setToggling] = useState<AdapterTrap | null>(null);

  return (
    <div className={s.stack}>
      <div className={s.row} style={{ justifyContent: 'space-between' }}>
        <p className={`${s.muted} ${s.small}`} style={{ maxWidth: '48rem' }}>
          Known problems the harvest looks for. Pack traps ship with the adapter; curated traps are
          added by curators and apply to every version without a new pack. Every query must be
          read-only.
        </p>
        {curate ? (
          <Button
            variant="primary"
            leadingIcon={<Plus aria-hidden="true" />}
            onClick={() => setAdding(true)}
          >
            Add curated trap
          </Button>
        ) : null}
      </div>
      {traps.isPending ? (
        <Skeleton height="10rem" />
      ) : traps.isError ? (
        <ApiErrorView
          error={traps.error}
          title="Could not load traps"
          onRetry={() => void traps.refetch()}
        />
      ) : traps.data.length === 0 ? (
        <EmptyState title="No traps" />
      ) : (
        traps.data.map((t) => (
          <Card key={`${t.origin}:${t.id}`} aria-labelledby={`trap-${t.id}`}>
            <CardHeader
              titleId={`trap-${t.id}`}
              title={t.title}
              description={
                <span className={s.row}>
                  <Mono>{t.id}</Mono>
                  <Badge tone={SEVERITY_TONE[t.severity] ?? 'neutral'}>{t.severity}</Badge>
                  <Badge>{t.stream}</Badge>
                  <Badge tone={t.origin === 'curated' ? 'accent' : 'neutral'}>
                    {t.origin === 'curated' ? 'Curated' : 'From the pack'}
                  </Badge>
                  <StatusPill tone={t.active ? 'success' : 'neutral'}>
                    {t.active ? 'Active' : 'Disabled'}
                  </StatusPill>
                </span>
              }
              actions={
                curate && t.origin === 'curated' ? (
                  <Button
                    size="sm"
                    leadingIcon={<Power aria-hidden="true" />}
                    onClick={() => setToggling(t)}
                  >
                    {t.active ? 'Disable' : 'Enable'}
                  </Button>
                ) : null
              }
            />
            <CardBody className={s.stackSm}>
              <p>{t.description}</p>
              <p className={s.small}>
                <strong>Advice:</strong> {t.advice}
              </p>
              <p className={`${s.muted} ${s.small}`}>
                Detects by{' '}
                {t.detect.kind === 'query' ? 'a read-only query' : 'objects in the inventory'}
                {t.detect.object_type ? ` of type ${t.detect.object_type}` : ''}
                {t.detect.name_pattern ? `, names matching ${t.detect.name_pattern}` : ''}
                {t.detect.definition_pattern
                  ? `, code matching ${t.detect.definition_pattern}`
                  : ''}
                .
              </p>
              {t.detect.queries && Object.keys(t.detect.queries).length > 0
                ? Object.entries(t.detect.queries).map(([engine, q]) => (
                    <div key={engine}>
                      <span className={`${s.muted} ${s.xs}`}>{engine} query</span>
                      <PlainText label={`${engine} query for ${t.id}`}>{q}</PlainText>
                    </div>
                  ))
                : null}
              {t.origin === 'curated' ? (
                <p className={`${s.muted} ${s.xs}`}>
                  Added by {t.added_by ?? 'unknown'}
                  {t.reason ? ` · “${t.reason}”` : ''}
                </p>
              ) : null}
            </CardBody>
          </Card>
        ))
      )}
      {adding ? <AddTrapDialog name={name} onClose={() => setAdding(false)} /> : null}
      {toggling ? (
        <ToggleTrapDialog name={name} trap={toggling} onClose={() => setToggling(null)} />
      ) : null}
    </div>
  );
}

function AddTrapDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const add = useAddTrap(name);
  const [text, setText] = useState(TRAP_TEMPLATE);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseDefinition(text);
  const rErr = reasonError(reason);
  const serverErrors = isApiError(add.error) ? add.error.fieldErrorList : [];
  const trapErrors = serverErrors.filter((e) => e.field.startsWith('trap'));
  const reasonServer = serverErrors.find((e) => e.field === 'reason')?.message;

  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Add a curated trap to ${name}`}
      description="Write the trap as YAML or JSON. It applies to every version of this adapter. Queries are checked: anything that writes is refused."
      submitLabel="Add trap"
      size="lg"
      pending={add.isPending}
      error={trapErrors.length > 0 ? null : add.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if ('error' in parsed || rErr) return;
        add.mutate(
          { trap: parsed.value, reason: reason.trim() },
          {
            onSuccess: (t) => {
              toast.success(`Trap ${t.id} added`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Trap definition (YAML or JSON)"
        error={submitted && 'error' in parsed ? parsed.error : undefined}
        required
      >
        <Textarea
          mono
          rows={18}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (add.error) add.reset();
          }}
          spellCheck={false}
          wrap="off"
        />
      </Field>
      {trapErrors.length > 0 ? (
        <Callout tone="danger" title="The trap does not match the contract" live>
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {trapErrors.map((e, i) => (
              <li key={i}>
                <Mono className={s.small}>{trapFieldLabel(e.field)}</Mono>: {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={(submitted ? rErr : undefined) ?? reasonServer}
        required
      >
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}

function ToggleTrapDialog({
  name,
  trap,
  onClose,
}: {
  name: string;
  trap: AdapterTrap;
  onClose: () => void;
}) {
  const set = useSetTrapActive(name);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const rErr = reasonError(reason);
  const next = !trap.active;
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`${next ? 'Enable' : 'Disable'} trap ${trap.id}`}
      description={
        next
          ? 'Harvests will look for this trap again.'
          : 'Harvests stop looking for this trap. Past findings stay.'
      }
      submitLabel={next ? 'Enable trap' : 'Disable trap'}
      size="sm"
      pending={set.isPending}
      error={set.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (rErr) return;
        set.mutate(
          { trapId: trap.id, active: next, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success(`Trap ${trap.id} ${next ? 'enabled' : 'disabled'}`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help="At least 10 characters. Recorded in the audit log."
        error={submitted ? rErr : undefined}
        required
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </Field>
    </FormDialog>
  );
}
