import { Plus, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAddDependency, useDependencies, useRemoveDependency } from '@/api/planning';
import type { DepEdge, DepNode } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { mergeFieldErrors } from '@/lib/forms';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Mono,
  Select,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { dispositionInfo, humanize, minLength } from './model';
import plan from './Plan.module.css';

export function DependenciesView({ project, canManage }: { project: Project; canManage: boolean }) {
  const q = useDependencies(project.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DepEdge | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const nodes = useMemo(() => new Map((q.data?.nodes ?? []).map((n) => [n.key, n])), [q.data]);
  const name = (k: string) => nodes.get(k)?.element ?? k;
  const inCycle = useMemo(
    () => new Set((q.data?.errors ?? []).flatMap((e) => e.members)),
    [q.data],
  );
  const columns = useMemo(() => {
    const col = createDataTableColumns<DepEdge>();
    return col.columns([
      col.accessor((e) => nodes.get(e.src)?.element ?? e.src, {
        id: 'src',
        header: 'Element',
        size: 220,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor((e) => nodes.get(e.dst)?.element ?? e.dst, {
        id: 'dst',
        header: 'Depends on',
        size: 220,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor((e) => e.kinds.join(', '), { id: 'kinds', header: 'Why', size: 140 }),
      col.accessor('source', {
        header: 'Found by',
        size: 110,
        cell: (info) => (info.getValue() === 'person' ? 'A person' : 'Discovery'),
      }),
      col.display({
        id: 'state',
        header: 'State',
        size: 220,
        cell: (info) => {
          const e = info.row.original;
          if (e.removed) {
            return (
              <span className={s.xs} style={{ whiteSpace: 'normal' }}>
                Removed by {e.removed.by}: “{e.removed.reason}”
              </span>
            );
          }
          if (e.added) {
            return (
              <span className={s.xs} style={{ whiteSpace: 'normal' }}>
                Added by {e.added.by}: “{e.added.reason}”
              </span>
            );
          }
          return <Badge tone="success">Active</Badge>;
        },
      }),
      col.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        size: 60,
        enableSorting: false,
        cell: (info) =>
          canManage && !info.row.original.removed ? (
            <IconButton
              size="sm"
              label={`Remove dependency of ${nodes.get(info.row.original.src)?.element ?? ''} on ${nodes.get(info.row.original.dst)?.element ?? ''}`}
              icon={<Trash aria-hidden="true" />}
              onClick={() => setRemoving(info.row.original)}
            />
          ) : null,
      }),
    ]);
  }, [nodes, canManage]);

  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load dependencies"
        onRetry={() => void q.refetch()}
      />
    );
  }
  const d = q.data;
  const edges = showRemoved ? d.edges : d.edges.filter((e) => !e.removed);
  const byDepth = new Map<number, DepNode[]>();
  for (const n of d.nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  return (
    <div className={s.stack}>
      {d.errors.length > 0 ? (
        <Callout
          tone="danger"
          title={`${String(d.errors.length)} dependency cycle(s): the work cannot be ordered`}
        >
          <ul className={styles.plainList}>
            {d.errors.map((e) => (
              <li key={e.members.join('|')}>{e.detail}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card flush aria-labelledby="deps-table">
        <CardHeader
          titleId="deps-table"
          title={`Dependencies (${String(d.edges.filter((e) => !e.removed).length)} active)`}
          description="An element's work starts after the work of everything it depends on. Discovered dependencies that a person removes are kept as removed, with who and why, so they do not come back."
          actions={
            canManage ? (
              <Button
                leadingIcon={<Plus aria-hidden="true" />}
                onClick={() => setAdding(true)}
                disabled={d.nodes.length < 2}
              >
                Add dependency
              </Button>
            ) : null
          }
        />
        <div className={s.toolbar}>
          <Field label="Show removed dependencies" inline>
            <Switch checked={showRemoved} onCheckedChange={setShowRemoved} />
          </Field>
        </div>
        <DataTable
          label="Dependencies"
          data={edges}
          columns={columns}
          getRowId={(e) => e.key}
          maxHeight="28rem"
          empty={
            <EmptyState
              compact
              title="No dependencies"
              body={d.nodes.length ? undefined : 'Propose the scope first.'}
            />
          }
        />
      </Card>
      {d.nodes.length > 0 ? (
        <Card aria-labelledby="deps-order">
          <CardHeader
            titleId="deps-order"
            title="Order of work"
            description="Elements by dependency depth: depth 0 depends on nothing; each later column depends on earlier ones. Elements in a cycle are marked."
          />
          <CardBody>
            <div className={plan.depthColumns}>
              {depths.map((depth) => (
                <section
                  key={depth}
                  className={plan.depthColumn}
                  aria-label={`Depth ${String(depth)}`}
                >
                  <h4>
                    Depth {depth} ({byDepth.get(depth)?.length ?? 0})
                  </h4>
                  {(byDepth.get(depth) ?? []).slice(0, 60).map((n) => (
                    <div key={n.key} className={plan.depthNode} data-cycle={inCycle.has(n.key)}>
                      <Mono>{n.element}</Mono>
                      <br />
                      <span className={s.muted}>
                        {humanize(n.stream)} · {dispositionInfo(n.disposition).label}
                        {inCycle.has(n.key) ? ' · in a cycle' : ''}
                      </span>
                    </div>
                  ))}
                  {(byDepth.get(depth)?.length ?? 0) > 60 ? (
                    <span className={`${s.muted} ${s.xs}`}>
                      and {(byDepth.get(depth)?.length ?? 0) - 60} more
                    </span>
                  ) : null}
                </section>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}
      {adding ? (
        <AddDialog project={project} nodes={d.nodes} onClose={() => setAdding(false)} />
      ) : null}
      {removing ? (
        <RemoveDialog
          project={project}
          edge={removing}
          label={`${name(removing.src)} depends on ${name(removing.dst)}`}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

function AddDialog({
  project,
  nodes,
  onClose,
}: {
  project: Project;
  nodes: DepNode[];
  onClose: () => void;
}) {
  const add = useAddDependency(project.id);
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const client: Partial<Record<'src' | 'dst' | 'reason', string>> = {};
  if (!src) client.src = 'Choose the element whose work comes later.';
  if (!dst) client.dst = 'Choose the element it depends on.';
  else if (dst === src) client.dst = 'An element cannot depend on itself.';
  const r = minLength(reason, 10, 'Say why');
  if (r) client.reason = r;
  const errors = mergeFieldErrors(client, add.error, submitted);
  const options = nodes.map((n) => ({ value: n.key, label: `${n.element} (${humanize(n.kind)})` }));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add a dependency"
      submitLabel="Add dependency"
      pending={add.isPending}
      error={add.error}
      fields={['src', 'dst', 'reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(client).length) return;
        add.mutate(
          { src, dst, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success('Dependency added');
              onClose();
            },
          },
        );
      }}
    >
      <Field label="Element whose work comes later" error={errors.src} required>
        <Select
          options={options}
          value={src}
          onValueChange={setSrc}
          placeholder="Choose an element"
        />
      </Field>
      <Field label="Depends on" error={errors.dst} required>
        <Select
          options={options}
          value={dst}
          onValueChange={setDst}
          placeholder="Choose an element"
        />
      </Field>
      <Field label="Reason" help="At least 10 characters." error={errors.reason} required>
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

function RemoveDialog({
  project,
  edge,
  label,
  onClose,
}: {
  project: Project;
  edge: DepEdge;
  label: string;
  onClose: () => void;
}) {
  const remove = useRemoveDependency(project.id);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const err = minLength(reason, 10, 'Say why');
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Remove a dependency"
      description={
        edge.source === 'person'
          ? `${label}. A dependency a person added is deleted.`
          : `${label}. Discovery found it, so it is kept as removed with your reason.`
      }
      submitLabel="Remove dependency"
      tone="danger"
      pending={remove.isPending}
      error={remove.error}
      fields={['reason']}
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        remove.mutate(
          { key: edge.key, reason: reason.trim() },
          {
            onSuccess: () => {
              toast.success('Dependency removed');
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Reason"
        help="At least 10 characters."
        error={submitted ? err : undefined}
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
