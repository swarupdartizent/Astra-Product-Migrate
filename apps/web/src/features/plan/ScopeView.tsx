import { ListChecks, Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useDecideScope, useGenerateScope, useScope } from '@/api/planning';
import { DISPOSITIONS, type Disposition, type ScopeItem } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { DISPOSITION_INFO, dispositionInfo, humanize, minLength } from './model';
import { Pager } from './PlanShared';
import plan from './Plan.module.css';

const ALL = '__all__';
const PROPOSAL = '__proposal__';
const PAGE = 50;
const STREAMS = [
  'data',
  'configuration',
  'customizations',
  'integrations',
  'reports',
  'users_security',
  'process',
  'agentification',
  'platform',
];

export function ScopeView({ project, canManage }: { project: Project; canManage: boolean }) {
  const [stream, setStream] = useState('');
  const [disposition, setDisposition] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState(false);
  const page = useScope(project.id, {
    ...(stream ? { stream } : {}),
    ...(disposition ? { disposition } : {}),
    ...(status ? { status } : {}),
    ...(dq ? { q: dq } : {}),
    offset,
    limit: PAGE,
  });
  const generate = useGenerateScope(project.id);
  const items = page.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((i) => selected.has(i.key));
  const someOnPage = items.some((i) => selected.has(i.key));
  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const filter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <div className={s.stack}>
      <Card aria-labelledby="scope-head">
        <CardHeader
          titleId="scope-head"
          title="Scope register"
          description="Every element discovery found, with a proposed disposition and the evidence for it. Proposals are never decisions: a person approves or changes each one, with a reason."
          actions={
            canManage ? (
              <Button
                leadingIcon={<Sparkles aria-hidden="true" />}
                loading={generate.isPending}
                onClick={() =>
                  generate.mutate(undefined, {
                    onSuccess: (r) =>
                      toast.success(
                        `${String(r.items)} scope item(s) proposed; decisions already made are kept`,
                      ),
                  })
                }
              >
                Propose from discovery
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          <Callout tone="info">
            Agentify is never proposed automatically: it needs an agentification assessment, so only
            a person can choose it.
          </Callout>
          <FormError error={generate.error} />
          {generate.data?.dropped && generate.data.dropped.length > 0 ? (
            <Callout tone="warning" title="Items no longer in discovery">
              {generate.data.dropped.length} item(s) were removed because the newest discovery no
              longer has them.
            </Callout>
          ) : null}
          {page.data ? (
            <ul className={plan.chipRow} aria-label="Effective dispositions">
              {DISPOSITIONS.map((d) => (
                <li key={d}>
                  <Badge tone={DISPOSITION_INFO[d].tone}>
                    {DISPOSITION_INFO[d].label}: {(page.data.counts[d] ?? 0).toLocaleString()}
                  </Badge>
                </li>
              ))}
              <li>
                <Badge tone={page.data.pending ? 'warning' : 'success'}>
                  Awaiting decision: {page.data.pending.toLocaleString()}
                </Badge>
              </li>
            </ul>
          ) : null}
        </CardBody>
      </Card>

      <Card flush aria-labelledby="scope-items">
        <CardHeader titleId="scope-items" title="Items" />
        <div className={s.filters} style={{ padding: 'var(--space-3) var(--space-5)' }}>
          <Field label="Stream">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All streams' },
                ...STREAMS.map((x) => ({ value: x, label: humanize(x) })),
              ]}
              value={stream || ALL}
              onValueChange={(v) => filter(() => setStream(v === ALL ? '' : v))}
            />
          </Field>
          <Field label="Disposition">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All' },
                ...DISPOSITIONS.map((d) => ({ value: d, label: DISPOSITION_INFO[d].label })),
              ]}
              value={disposition || ALL}
              onValueChange={(v) => filter(() => setDisposition(v === ALL ? '' : v))}
            />
          </Field>
          <Field label="Status">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All' },
                { value: 'proposed', label: 'Awaiting decision' },
                { value: 'approved', label: 'Approved' },
              ]}
              value={status || ALL}
              onValueChange={(v) => filter(() => setStatus(v === ALL ? '' : v))}
            />
          </Field>
          <Field label="Element contains">
            <Input
              size="sm"
              type="search"
              startAdornment={<Search />}
              value={q}
              onChange={(e) => filter(() => setQ(e.target.value))}
            />
          </Field>
        </div>
        {canManage ? (
          <div className={s.toolbar}>
            <Field label="Select every item on this page" inline>
              <Checkbox
                checked={allOnPage ? true : someOnPage ? 'indeterminate' : false}
                onCheckedChange={(v) => {
                  for (const i of items) toggle(i.key, v === true);
                }}
              />
            </Field>
            <span className={`${s.muted} ${s.small}`} aria-live="polite">
              {selected.size.toLocaleString()} selected
            </span>
            <Button
              variant="primary"
              leadingIcon={<ListChecks aria-hidden="true" />}
              disabled={selected.size === 0}
              onClick={() => setDeciding(true)}
            >
              Decide selected
            </Button>
            {selected.size > 0 ? (
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            ) : null}
          </div>
        ) : null}
        <CardBody>
          {page.isError ? (
            <ApiErrorView
              error={page.error}
              title="Could not load the scope register"
              compact
              onRetry={() => void page.refetch()}
            />
          ) : page.isPending ? (
            <Skeleton height="12rem" />
          ) : items.length === 0 ? (
            <EmptyState
              compact
              title="No scope items"
              body={
                page.data.total === 0 && !stream && !disposition && !status && !dq
                  ? 'Propose the scope from discovery first.'
                  : 'No item matches the filters.'
              }
            />
          ) : (
            <ul
              className={styles.gapList}
              style={{ padding: '0 var(--space-5) var(--space-3)' }}
              aria-label="Scope items"
            >
              {items.map((i) => (
                <ScopeRow
                  key={i.key}
                  item={i}
                  selectable={canManage}
                  selected={selected.has(i.key)}
                  onSelect={(on) => toggle(i.key, on)}
                />
              ))}
            </ul>
          )}
        </CardBody>
        {page.data ? (
          <Pager offset={offset} limit={PAGE} total={page.data.total} onOffset={setOffset} />
        ) : null}
      </Card>
      {deciding ? (
        <DecideDialog
          project={project}
          keys={[...selected]}
          onClose={(done) => {
            setDeciding(false);
            if (done) setSelected(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

function ScopeRow({
  item: i,
  selectable,
  selected,
  onSelect,
}: {
  item: ScopeItem;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
}) {
  const eff = dispositionInfo(i.effective);
  const prop = dispositionInfo(i.proposed);
  return (
    <li className={styles.gap}>
      <span className={s.row} style={{ width: '100%' }}>
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(v === true)}
            aria-label={`Select ${i.element}`}
          />
        ) : null}
        <Mono className={s.small}>{i.element}</Mono>
        <Badge>{humanize(i.kind)}</Badge>
        <span className={`${s.muted} ${s.xs}`}>
          {humanize(i.stream)} · {i.segment}
        </span>
        <span style={{ marginLeft: 'auto' }} className={s.row}>
          <Badge tone={eff.tone}>{eff.label}</Badge>
          <StatusPill tone={i.status === 'approved' ? 'success' : 'warning'}>
            {i.status === 'approved' ? 'Approved' : 'Awaiting decision'}
          </StatusPill>
        </span>
      </span>
      {i.status === 'approved' && i.decision ? (
        <span className={`${s.muted} ${s.xs}`}>
          {i.decision.changed ? `Changed from the proposal (${prop.label}) ` : 'Proposal approved '}
          by {i.decision.by}: “{i.decision.reason}”
        </span>
      ) : (
        <span className={`${s.muted} ${s.xs}`}>Proposed: {prop.label}</span>
      )}
      <ul className={plan.evidence} aria-label={`Evidence for ${i.element}`}>
        {i.evidence.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </li>
  );
}

function DecideDialog({
  project,
  keys,
  onClose,
}: {
  project: Project;
  keys: string[];
  onClose: (done: boolean) => void;
}) {
  const decide = useDecideScope(project.id);
  const [disposition, setDisposition] = useState<string>(PROPOSAL);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = minLength(reason, 10, 'Say why');
  const chosen = disposition === PROPOSAL ? null : (disposition as Disposition);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose(false);
      }}
      title={`Decide ${String(keys.length)} scope item(s)`}
      description="Approving keeps each item's own proposal. Choosing a disposition sets it for every selected item. The decision and your reason are recorded."
      submitLabel={chosen ? `Set to ${DISPOSITION_INFO[chosen].label}` : 'Approve proposals'}
      pending={decide.isPending}
      error={decide.error}
      fields={['reason', 'disposition']}
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        decide.mutate(
          { keys, disposition: chosen, reason: reason.trim() },
          {
            onSuccess: (r) => {
              toast.success(`${String(r.decided)} decision(s) recorded`);
              onClose(true);
            },
          },
        );
      }}
    >
      <Field
        label="Decision"
        help={
          chosen ? DISPOSITION_INFO[chosen].meaning : 'Each item keeps its proposed disposition.'
        }
      >
        <Select
          options={[
            { value: PROPOSAL, label: 'Approve each proposal' },
            ...DISPOSITIONS.map((d) => ({
              value: d,
              label: `Set to ${DISPOSITION_INFO[d].label}`,
            })),
          ]}
          value={disposition}
          onValueChange={setDisposition}
        />
      </Field>
      <Field
        label="Reason"
        help="At least 10 characters."
        error={submitted ? err : undefined}
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
