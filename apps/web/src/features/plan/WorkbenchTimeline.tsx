import { Pin } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import type {
  PlanWorkbench,
  WorkbenchEdit,
  WorkbenchItem,
  WorkbenchWave,
} from '@/api/planning-types';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Mono, Select } from '@/ui';
import s from '../shared.module.css';
import { formatRange, humanize, loadRatio } from './model';
import plan from './Plan.module.css';
import { PlanResult } from './WavesView';
import { datePct, pendingWave, type PendingEdit } from './workbench-model';

const NO_PIN = '__solver__';
const UNPLACED = '__unplaced__';
const LANE_LIMIT = 40;
const DRAG_TYPE = 'application/x-astra-scope-key';

/**
 * Waves as lanes with dates, the items placed in each, and load against capacity per role.
 * Every item has a "Pin to wave" menu, so moving never needs dragging (WCAG 2.5.7); dragging
 * a chip onto a lane is offered on top for pointer users.
 */
export function WorkbenchTimeline({
  wb,
  pending,
  name,
  onEdit,
}: {
  wb: PlanWorkbench;
  pending: PendingEdit[];
  name: (k: string) => string;
  onEdit: (e: WorkbenchEdit) => void;
}) {
  const byKey = new Map(wb.items.map((i) => [i.key, i]));
  // Where each item shows: its pending wave if a move is pending, else where the solver put it.
  const lanes = new Map<string, WorkbenchItem[]>();
  for (const it of wb.items) {
    const pw = pendingWave(pending, it.key);
    const lane = pw ?? it.wave ?? (wb.unplaced.includes(it.key) ? UNPLACED : null);
    if (lane === null) continue;
    lanes.set(lane, [...(lanes.get(lane) ?? []), it]);
  }
  const starts = wb.waves.map((w) => Date.parse(w.start ?? '')).filter(Number.isFinite);
  const ends = wb.waves.map((w) => Date.parse(w.end ?? '')).filter(Number.isFinite);
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const dropProps = (lane: string) =>
    wb.can_edit
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            setDropTarget(lane);
          },
          onDragLeave: () => setDropTarget((t) => (t === lane ? null : t)),
          onDrop: (e: DragEvent) => {
            const key = e.dataTransfer.getData(DRAG_TYPE);
            setDropTarget(null);
            if (!key || !byKey.has(key)) return;
            e.preventDefault();
            onEdit({ op: 'move', scope_key: key, wave: lane === UNPLACED ? null : lane });
          },
        }
      : {};

  return (
    <div className={s.stack}>
      {wb.waves.length === 0 ? (
        <EmptyState
          compact
          title="No waves yet"
          body="Add waves on the Waves section, then solve them to place the scope items."
        />
      ) : (
        <section aria-labelledby="wb-lanes" className={s.stackSm}>
          <h3 id="wb-lanes" className="sr-only">
            Waves
          </h3>
          {wb.can_edit ? (
            <p className={`${s.muted} ${s.small}`}>
              Use an item’s <strong>Pin to wave</strong> menu to move it; you can also drag it onto
              a wave. Moves are pins: the solver keeps a pinned item in its wave.
            </p>
          ) : null}
          <div className={plan.lanes}>
            {wb.waves.map((w) => (
              <Lane
                key={w.key}
                wave={w}
                items={lanes.get(w.key) ?? []}
                wb={wb}
                pending={pending}
                min={min}
                max={max}
                drop={dropTarget === w.key}
                dropProps={dropProps(w.key)}
                onEdit={onEdit}
              />
            ))}
            {(lanes.get(UNPLACED) ?? []).length > 0 ? (
              <Lane
                wave={null}
                items={lanes.get(UNPLACED) ?? []}
                wb={wb}
                pending={pending}
                min={min}
                max={max}
                drop={dropTarget === UNPLACED}
                dropProps={dropProps(UNPLACED)}
                onEdit={onEdit}
              />
            ) : null}
          </div>
        </section>
      )}
      {wb.unestimated.length > 0 ? (
        <Card aria-labelledby="wb-unest">
          <CardHeader
            titleId="wb-unest"
            title={`No estimated work (${String(wb.unestimated.length)})`}
            description="These scope items have no estimated tasks, so the solver does not place them. Generate tasks, or add an estimation rule that covers them."
          />
          <CardBody>
            <ul className={plan.chipRow}>
              {wb.unestimated.slice(0, 100).map((k) => (
                <li key={k}>
                  <Mono chip className={s.xs}>
                    {name(k)}
                  </Mono>
                </li>
              ))}
            </ul>
            {wb.unestimated.length > 100 ? (
              <p className={`${s.muted} ${s.xs}`}>and {wb.unestimated.length - 100} more</p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      {wb.plan ? <PlanResult plan={wb.plan} roles={wb.roles} /> : null}
    </div>
  );
}

function Lane({
  wave,
  items,
  wb,
  pending,
  min,
  max,
  drop,
  dropProps,
  onEdit,
}: {
  wave: WorkbenchWave | null;
  items: WorkbenchItem[];
  wb: PlanWorkbench;
  pending: PendingEdit[];
  min: number;
  max: number;
  drop: boolean;
  dropProps: Record<string, unknown>;
  onEdit: (e: WorkbenchEdit) => void;
}) {
  const [all, setAll] = useState(false);
  const title = wave ? (wave.name ?? wave.key) : 'Not placed by the solver';
  const headId = `lane-${wave?.key ?? 'unplaced'}`;
  const start = wave ? datePct(wave.start, min, max) : null;
  const end = wave ? datePct(wave.end, min, max) : null;
  const cut = wave ? datePct(wave.cutover, min, max) : null;
  const roles = wave
    ? wb.roles.filter((r) => (wave.capacity[r] ?? 0) > 0 || (wave.load[r]?.hours ?? 0) > 0)
    : [];
  const shown = all ? items : items.slice(0, LANE_LIMIT);
  return (
    <section
      className={plan.lane}
      aria-labelledby={headId}
      data-drop={drop || undefined}
      data-kind={wave ? 'wave' : 'unplaced'}
      {...dropProps}
    >
      <div className={plan.laneHead}>
        <h4 id={headId} className={plan.laneTitle}>
          {title} {wave ? <Mono className={s.xs}>{wave.key}</Mono> : null}
        </h4>
        {wave ? (
          <>
            <span className={s.small}>
              {wave.start ?? '?'} to {wave.end ?? '?'}
              {wave.cutover ? ` · cutover ${wave.cutover}` : ' · no cutover date'}
            </span>
            {start !== null && end !== null ? (
              <span className={plan.axis} aria-hidden="true">
                <span
                  className={plan.axisSpan}
                  style={{
                    left: `${String(start)}%`,
                    width: `${String(Math.max(end - start, 1))}%`,
                  }}
                />
                {cut !== null ? (
                  <span className={plan.axisCutover} style={{ left: `${String(cut)}%` }} />
                ) : null}
              </span>
            ) : null}
            {roles.length ? (
              <ul className={s.stackSm} style={{ listStyle: 'none', gap: 'var(--space-1)' }}>
                {roles.map((r) => {
                  const hours = wave.load[r]?.hours ?? 0;
                  const cap = wave.capacity[r] ?? 0;
                  const lr = loadRatio(hours, cap);
                  return (
                    <li key={r} className={plan.loadCell} data-over={lr.over}>
                      <span className={s.xs}>
                        {humanize(r)}: {hours.toLocaleString()} of {cap.toLocaleString()} h
                        {lr.over ? ' (over capacity)' : ''}
                      </span>
                      {lr.pct !== null ? (
                        <span className={plan.bar} aria-hidden="true">
                          <span
                            className={plan.barFill}
                            style={{ width: `${String(Math.min(100, lr.pct))}%` }}
                          />
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className={`${s.muted} ${s.xs}`}>No capacity or load.</span>
            )}
          </>
        ) : (
          <span className={`${s.muted} ${s.xs}`}>
            Estimated work the solver has not placed in any wave. Pin an item to place it, or add
            capacity.
          </span>
        )}
        <span className={`${s.muted} ${s.xs}`}>{items.length} item(s)</span>
      </div>
      {items.length === 0 ? (
        <p className={`${s.muted} ${s.small}`}>Nothing placed in this wave.</p>
      ) : (
        <div className={s.stackSm}>
          <ul className={plan.laneItems} aria-label={`Items in ${title}`}>
            {shown.map((it) => (
              <ItemChip key={it.key} item={it} wb={wb} pending={pending} onEdit={onEdit} />
            ))}
          </ul>
          {items.length > LANE_LIMIT ? (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show all ${String(items.length)} items`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ItemChip({
  item: it,
  wb,
  pending,
  onEdit,
}: {
  item: WorkbenchItem;
  wb: PlanWorkbench;
  pending: PendingEdit[];
  onEdit: (e: WorkbenchEdit) => void;
}) {
  const pw = pendingWave(pending, it.key);
  const isPending = pw !== undefined;
  const pin = isPending ? pw : it.pinned_wave;
  return (
    <li>
      {/* Dragging is only a pointer shortcut: every chip has a "Pin to wave" menu that does the
          same with the keyboard or assistive technology (WCAG 2.5.7). */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={plan.chip}
        data-pending={isPending || undefined}
        draggable={wb.can_edit || undefined}
        onDragStart={
          wb.can_edit
            ? (e) => {
                e.dataTransfer.setData(DRAG_TYPE, it.key);
                e.dataTransfer.effectAllowed = 'move';
              }
            : undefined
        }
      >
        <span className={s.row}>
          <Mono className={plan.chipName}>{it.element}</Mono>
          {it.pinned_wave && !isPending ? (
            <Badge icon={<Pin aria-hidden="true" />}>Pinned</Badge>
          ) : null}
          {isPending ? (
            <Badge tone="accent">Pending: {pw === null ? 'unpin' : `pin to ${pw}`}</Badge>
          ) : null}
          {it.overridden_tasks ? (
            <Badge tone="info">{it.overridden_tasks} task(s) changed</Badge>
          ) : null}
        </span>
        <span className={s.muted}>
          {humanize(it.stream)} · {it.tasks} task(s) · {formatRange(it)}
        </span>
        {it.depends_on.length ? (
          <span className={s.muted}>Waits for {it.depends_on.length} item(s)</span>
        ) : null}
        {wb.can_edit ? (
          <Select
            size="sm"
            aria-label={`Pin ${it.element} to wave`}
            options={[
              { value: NO_PIN, label: 'No pin: the solver places it' },
              ...wb.waves.map((w) => ({ value: w.key, label: `Pin to ${w.name ?? w.key}` })),
            ]}
            value={pin ?? NO_PIN}
            onValueChange={(v) => {
              const wave = v === NO_PIN ? null : v;
              if (wave === (it.pinned_wave ?? null) && !isPending) return;
              onEdit({ op: 'move', scope_key: it.key, wave });
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
