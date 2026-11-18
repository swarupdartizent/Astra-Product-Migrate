import { Plus, Trash, Undo } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { PlanWorkbench, WorkbenchEdge, WorkbenchEdit } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Mono,
  Textarea,
} from '@/ui';
import s from '../shared.module.css';
import { humanize, minLength } from './model';
import plan from './Plan.module.css';
import { ScopeKeyPicker } from './PlanShared';
import { layoutGraph, NODE_H, NODE_W, shorten, type PendingEdit } from './workbench-model';

const GRAPH_LIMIT = 150;

interface EdgeRow {
  key: string;
  src: string;
  dst: string;
  source: string | null;
  kinds: string[];
  /** A pending addition, a pending removal, or neither. */
  pending: 'add' | 'remove' | null;
  pendingId?: number;
}

/**
 * The dependency graph by depth (items and active edges, cycles highlighted) with the same
 * information as tables, so it is usable without seeing the picture. Add and remove go to the
 * pending list with a reason.
 */
export function WorkbenchGraph({
  project,
  wb,
  pending,
  name,
  onEdit,
  onUndo,
}: {
  project: Project;
  wb: PlanWorkbench;
  pending: PendingEdit[];
  name: (k: string) => string;
  onEdit: (e: WorkbenchEdit) => void;
  /** Drops a pending edit. */
  onUndo: (pendingId: number) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EdgeRow | null>(null);
  const inCycle = useMemo(() => new Set(wb.cycles.flat()), [wb.cycles]);

  const rows: EdgeRow[] = useMemo(() => {
    const removed = new Map(
      pending.flatMap((p) =>
        p.edit.op === 'remove_dependency' ? [[p.edit.key, p.id] as const] : [],
      ),
    );
    const active = wb.edges
      .filter((e: WorkbenchEdge) => !e.removed)
      .map<EdgeRow>((e) => ({
        key: e.key,
        src: e.src,
        dst: e.dst,
        source: e.source,
        kinds: e.kinds,
        pending: removed.has(e.key) ? 'remove' : null,
        ...(removed.has(e.key) ? { pendingId: removed.get(e.key) } : {}),
      }));
    const known = new Set(active.map((e) => e.key));
    const added = pending.flatMap<EdgeRow>((p) =>
      p.edit.op === 'add_dependency' && !known.has(`${p.edit.src}->${p.edit.dst}`)
        ? [
            {
              key: `${p.edit.src}->${p.edit.dst}`,
              src: p.edit.src,
              dst: p.edit.dst,
              source: 'person',
              kinds: ['person'],
              pending: 'add',
              pendingId: p.id,
            },
          ]
        : [],
    );
    return [...active, ...added];
  }, [wb.edges, pending]);

  const layout = useMemo(() => layoutGraph(wb.items, inCycle, GRAPH_LIMIT), [wb.items, inCycle]);
  const pos = new Map(layout.nodes.map((n) => [n.key, n]));
  const depths = new Set(wb.items.map((i) => i.depth)).size;
  const neededBy = new Map<string, string[]>();
  for (const e of rows) {
    if (e.pending !== 'remove') neededBy.set(e.dst, [...(neededBy.get(e.dst) ?? []), e.src]);
  }
  const markerId = `${titleId}-arrow`;

  return (
    <div className={s.stack}>
      {wb.cycles.length > 0 ? (
        <Callout
          tone="danger"
          title={`${String(wb.cycles.length)} dependency cycle(s): the work cannot be ordered`}
        >
          <ul className={s.small}>
            {wb.cycles.map((c) => (
              <li key={c.join('|')}>{c.map(name).join(' → ')} → back to the first</li>
            ))}
          </ul>
          Remove one dependency in each cycle.
        </Callout>
      ) : null}
      <Card aria-labelledby="wb-graph">
        <CardHeader
          titleId="wb-graph"
          title="Dependency graph"
          description="Elements by depth: depth 0 depends on nothing, and each arrow points from the work that must come first to the work that waits for it. Elements and dependencies in a cycle are red."
          actions={
            wb.can_edit ? (
              <Button
                leadingIcon={<Plus aria-hidden="true" />}
                onClick={() => setAdding(true)}
                disabled={wb.items.length < 2}
              >
                Add dependency
              </Button>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          {wb.items.length === 0 ? (
            <EmptyState compact title="No scope items" body="Propose the scope first." />
          ) : (
            <>
              <div className={plan.graphWrap}>
                <svg
                  role="img"
                  aria-labelledby={`${titleId} ${descId}`}
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
                >
                  <title id={titleId}>Dependency graph</title>
                  <desc id={descId}>
                    {`${String(wb.items.length)} elements in ${String(depths)} depth level(s), ${String(rows.length)} dependencies, ${String(wb.cycles.length)} cycle(s). The tables below list the same elements and dependencies.`}
                  </desc>
                  <defs>
                    <marker
                      id={markerId}
                      viewBox="0 0 10 10"
                      refX="10"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" className={plan.arrow} />
                    </marker>
                  </defs>
                  {rows.map((e) => {
                    const a = pos.get(e.dst);
                    const b = pos.get(e.src);
                    if (!a || !b) return null;
                    const x1 = a.x + NODE_W;
                    const y1 = a.y + NODE_H / 2;
                    const x2 = b.x;
                    const y2 = b.y + NODE_H / 2;
                    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
                    return (
                      <path
                        key={e.key}
                        className={plan.graphEdge}
                        data-cycle={inCycle.has(e.src) && inCycle.has(e.dst) ? 'true' : undefined}
                        data-pending={e.pending ?? undefined}
                        d={`M ${String(x1)} ${String(y1)} C ${String(x1 + dx)} ${String(y1)}, ${String(x2 - dx)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                        markerEnd={`url(#${markerId})`}
                      />
                    );
                  })}
                  {layout.nodes.map((n) => (
                    <g
                      key={n.key}
                      className={plan.graphNode}
                      data-cycle={n.cycle ? 'true' : undefined}
                      transform={`translate(${String(n.x)} ${String(n.y)})`}
                    >
                      <title>{`${n.label} (depth ${String(n.depth)})${n.cycle ? ', in a cycle' : ''}`}</title>
                      <rect width={NODE_W} height={NODE_H} rx={4} />
                      <text x={8} y={16}>
                        {shorten(n.label)}
                      </text>
                      <text x={8} y={31} className={plan.graphMeta}>
                        {`depth ${String(n.depth)}${n.cycle ? ' · in a cycle' : ''}`}
                      </text>
                    </g>
                  ))}
                </svg>
              </div>
              {layout.truncated > 0 ? (
                <p className={`${s.muted} ${s.xs}`}>
                  The picture shows the first {GRAPH_LIMIT} elements by depth; {layout.truncated}{' '}
                  more are in the tables below.
                </p>
              ) : null}
              <p className={`${s.muted} ${s.xs}`}>
                Dashed accent lines are pending additions; faint dotted lines are pending removals.
              </p>
            </>
          )}
        </CardBody>
      </Card>

      <Card flush aria-labelledby="wb-edges">
        <CardHeader
          titleId="wb-edges"
          title={`Dependencies (${String(rows.length)})`}
          description="The graph’s dependencies as a table."
        />
        {rows.length === 0 ? (
          <EmptyState compact title="No dependencies" />
        ) : (
          <div style={{ overflowX: 'auto', maxHeight: '28rem' }}>
            <table className={plan.taskTable}>
              <caption className="sr-only">Dependencies</caption>
              <thead>
                <tr>
                  <th scope="col">Element</th>
                  <th scope="col">Depends on</th>
                  <th scope="col">Found by</th>
                  <th scope="col">State</th>
                  {wb.can_edit ? (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const label = `${name(e.src)} depends on ${name(e.dst)}`;
                  const cyc = inCycle.has(e.src) && inCycle.has(e.dst);
                  return (
                    <tr key={e.key}>
                      <td>
                        <Mono className={s.small}>{name(e.src)}</Mono>
                      </td>
                      <td>
                        <Mono className={s.small}>{name(e.dst)}</Mono>
                      </td>
                      <td>
                        {e.source === 'person' ? 'A person' : 'Discovery'}
                        {e.kinds.length ? (
                          <span className={`${s.muted} ${s.xs}`}> ({e.kinds.join(', ')})</span>
                        ) : null}
                      </td>
                      <td>
                        <span className={s.badges}>
                          {e.pending === 'add' ? (
                            <Badge tone="accent">Pending addition</Badge>
                          ) : null}
                          {e.pending === 'remove' ? (
                            <Badge tone="warning">Pending removal</Badge>
                          ) : null}
                          {!e.pending ? <Badge tone="success">Active</Badge> : null}
                          {cyc ? <Badge tone="danger">In a cycle</Badge> : null}
                        </span>
                      </td>
                      {wb.can_edit ? (
                        <td>
                          {e.pending && e.pendingId !== undefined ? (
                            <IconButton
                              size="sm"
                              label={`Undo pending ${e.pending === 'add' ? 'addition' : 'removal'}: ${label}`}
                              icon={<Undo aria-hidden="true" />}
                              onClick={() => onUndo(e.pendingId ?? 0)}
                            />
                          ) : (
                            <IconButton
                              size="sm"
                              label={`Remove dependency: ${label}`}
                              icon={<Trash aria-hidden="true" />}
                              onClick={() => setRemoving(e)}
                            />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card flush aria-labelledby="wb-elements">
        <CardHeader
          titleId="wb-elements"
          title={`Elements by depth (${String(wb.items.length)})`}
          description="The graph’s elements as a table: what each waits for and what waits for it."
        />
        {wb.items.length === 0 ? null : (
          <div style={{ overflowX: 'auto', maxHeight: '28rem' }}>
            <table className={plan.taskTable}>
              <caption className="sr-only">Elements by depth</caption>
              <thead>
                <tr>
                  <th scope="col">Element</th>
                  <th scope="col">Depth</th>
                  <th scope="col">Stream</th>
                  <th scope="col">Waits for</th>
                  <th scope="col">Needed by</th>
                </tr>
              </thead>
              <tbody>
                {[...wb.items]
                  .sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key))
                  .map((it) => (
                    <tr key={it.key}>
                      <th scope="row" style={{ fontWeight: 'inherit' }}>
                        <Mono className={s.small}>{it.element}</Mono>
                        {inCycle.has(it.key) ? (
                          <>
                            {' '}
                            <Badge tone="danger">In a cycle</Badge>
                          </>
                        ) : null}
                      </th>
                      <td>{it.depth}</td>
                      <td>{humanize(it.stream)}</td>
                      <td className={s.xs}>{it.depends_on.map(name).join(', ') || '—'}</td>
                      <td className={s.xs}>
                        {(neededBy.get(it.key) ?? []).map(name).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {adding ? (
        <AddDependencyDialog
          project={project}
          onClose={() => setAdding(false)}
          onAdd={(e) => {
            onEdit(e);
            setAdding(false);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveDependencyDialog
          label={`${name(removing.src)} depends on ${name(removing.dst)}`}
          discovered={removing.source !== 'person'}
          onClose={() => setRemoving(null)}
          onRemove={(reason) => {
            onEdit({ op: 'remove_dependency', key: removing.key, reason });
            setRemoving(null);
          }}
        />
      ) : null}
    </div>
  );
}

function AddDependencyDialog({
  project,
  onClose,
  onAdd,
}: {
  project: Project;
  onClose: () => void;
  onAdd: (e: Extract<WorkbenchEdit, { op: 'add_dependency' }>) => void;
}) {
  const [src, setSrc] = useState('');
  const [dst, setDst] = useState('');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const errors: Partial<Record<'src' | 'dst' | 'reason', string>> = {};
  if (!src) errors.src = 'Choose the element whose work comes later.';
  if (!dst) errors.dst = 'Choose the element it depends on.';
  else if (dst === src) errors.dst = 'An element cannot depend on itself.';
  const r = minLength(reason, 10, 'Say why');
  if (r) errors.reason = r;
  const shown = submitted ? errors : {};
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add a dependency"
      description="Added to the pending changes; nothing is saved until you apply."
      submitLabel="Add to pending changes"
      pending={false}
      onSubmit={() => {
        setSubmitted(true);
        if (Object.keys(errors).length) return;
        onAdd({ op: 'add_dependency', src, dst, reason: reason.trim() });
      }}
    >
      <ScopeKeyPicker
        projectId={project.id}
        label="Element whose work comes later"
        value={src}
        onChange={setSrc}
        error={shown.src}
        required
      />
      <ScopeKeyPicker
        projectId={project.id}
        label="Depends on"
        value={dst}
        onChange={setDst}
        error={shown.dst}
        required
      />
      <Field label="Reason" help="At least 10 characters." error={shown.reason} required>
        <Textarea
          rows={2}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

function RemoveDependencyDialog({
  label,
  discovered,
  onClose,
  onRemove,
}: {
  label: string;
  discovered: boolean;
  onClose: () => void;
  onRemove: (reason: string) => void;
}) {
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
      description={`${label}. ${
        discovered
          ? 'Discovery found it, so it is kept as removed with your reason.'
          : 'A person added it, so it is deleted.'
      } Added to the pending changes; nothing is saved until you apply.`}
      submitLabel="Add to pending changes"
      pending={false}
      tone="danger"
      onSubmit={() => {
        setSubmitted(true);
        if (err) return;
        onRemove(reason.trim());
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
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
