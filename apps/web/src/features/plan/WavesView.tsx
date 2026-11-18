import { CalendarRange, Pencil, Pin, Plus, Trash, Wand } from 'lucide-react';
import { useState } from 'react';
import { useDeleteWave, usePin, useSaveWave, useSolveWaves, useWaves } from '@/api/planning';
import type { Wave, WavePlan } from '@/api/planning-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from '../discovery/Discovery.module.css';
import { humanize, loadRatio, validateWave, type WaveForm } from './model';
import plan from './Plan.module.css';
import { ScopeKeyPicker } from './PlanShared';

const NONE = '__none__';

export function WavesView({ project, canManage }: { project: Project; canManage: boolean }) {
  const q = useWaves(project.id);
  const solve = useSolveWaves(project.id);
  const del = useDeleteWave(project.id);
  const [editing, setEditing] = useState<Wave | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Wave | null>(null);
  const [pinning, setPinning] = useState(false);
  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView error={q.error} title="Could not load waves" onRetry={() => void q.refetch()} />
    );
  }
  const v = q.data;
  const pins = Object.entries(v.pins);
  return (
    <div className={s.stack}>
      <Card aria-labelledby="waves-head">
        <CardHeader
          titleId="waves-head"
          title={`Waves (${String(v.waves.length)})`}
          description="Each wave has dates, an optional cutover date and capacity in hours per role. The solver places every scope item in a wave, respecting dependencies and pins."
          actions={
            canManage ? (
              <span className={s.row}>
                <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditing('new')}>
                  Add wave
                </Button>
                <Button
                  variant="primary"
                  leadingIcon={<Wand aria-hidden="true" />}
                  loading={solve.isPending}
                  onClick={() =>
                    solve.mutate(undefined, {
                      onSuccess: (r) =>
                        r.fits
                          ? toast.success('Every item fits the waves')
                          : toast.warning('The plan does not fit; see the options'),
                    })
                  }
                >
                  Solve waves
                </Button>
              </span>
            ) : null
          }
        />
        <CardBody className={s.stackSm}>
          <FormError error={solve.error} />
          {v.waves.length === 0 ? (
            <EmptyState compact icon={<CalendarRange />} title="No waves yet" />
          ) : (
            <ul className={styles.gapList}>
              {v.waves.map((w) => (
                <li key={w.key} className={styles.gap}>
                  <span className={s.row} style={{ width: '100%' }}>
                    <strong>{w.name}</strong>
                    <Mono className={s.xs}>{w.key}</Mono>
                    <span className={s.small}>
                      {w.start} to {w.end}
                      {w.cutover ? ` · cutover ${w.cutover}` : ''}
                    </span>
                    {canManage ? (
                      <span style={{ marginLeft: 'auto' }} className={s.row}>
                        <IconButton
                          size="sm"
                          label={`Edit wave ${w.name}`}
                          icon={<Pencil aria-hidden="true" />}
                          onClick={() => setEditing(w)}
                        />
                        <IconButton
                          size="sm"
                          label={`Delete wave ${w.name}`}
                          icon={<Trash aria-hidden="true" />}
                          onClick={() => setDeleting(w)}
                        />
                      </span>
                    ) : null}
                  </span>
                  <span className={`${s.muted} ${s.xs}`}>
                    Capacity:{' '}
                    {Object.entries(w.capacity).length
                      ? Object.entries(w.capacity)
                          .map(([r, h]) => `${humanize(r)} ${String(h)} h`)
                          .join(' · ')
                      : 'none set'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
        <CardFooter>
          <span className={`${s.muted} ${s.small}`}>
            {pins.length} item(s) pinned to a wave
            {pins.length
              ? `: ${pins
                  .map(([k, p]) => `${k} → ${p.wave}`)
                  .slice(0, 5)
                  .join(', ')}`
              : '.'}
          </span>
          {canManage ? (
            <Button
              size="sm"
              leadingIcon={<Pin aria-hidden="true" />}
              onClick={() => setPinning(true)}
              disabled={v.waves.length === 0}
            >
              Pin an item
            </Button>
          ) : null}
        </CardFooter>
      </Card>
      {v.plan ? <PlanResult plan={v.plan} roles={v.roles} /> : null}
      {editing ? (
        <WaveDialog
          project={project}
          wave={editing === 'new' ? null : editing}
          roles={v.roles}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {pinning ? (
        <PinDialog project={project} waves={v.waves} onClose={() => setPinning(false)} />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        tone="danger"
        title={`Delete wave ${deleting?.name ?? ''}?`}
        description="Items placed in it are placed again the next time the waves are solved."
        confirmLabel="Delete wave"
        onConfirm={async () => {
          if (!deleting) return;
          await del.mutateAsync(deleting.key);
          toast.success('Wave deleted');
        }}
      />
    </div>
  );
}

export function PlanResult({ plan: p, roles }: { plan: WavePlan; roles: string[] }) {
  const waves = Object.keys(p.load);
  const usedRoles = roles.filter((r) => waves.some((w) => p.load[w]?.[r]));
  return (
    <Card aria-labelledby="waves-plan">
      <CardHeader
        titleId="waves-plan"
        title={p.fits ? 'The plan fits' : 'The plan does not fit'}
        description={
          <>
            {p.items !== undefined ? `${String(p.items)} item(s) placed. ` : ''}No work is dropped:
            when the plan does not fit, every broken constraint is listed with the options that
            would make it fit.
            {p.solved_at ? (
              <>
                {' '}
                Solved <Timestamp value={p.solved_at} />.
              </>
            ) : null}
          </>
        }
        actions={
          <StatusPill tone={p.fits ? 'success' : 'danger'}>
            {p.fits ? 'Fits' : `${String(p.broken.length)} broken`}
          </StatusPill>
        }
      />
      <CardBody className={s.stack}>
        {p.broken.length > 0 ? (
          <Callout tone="danger" title="Broken constraints">
            <ul className={styles.plainList}>
              {p.broken.map((b, i) => (
                <li key={`${b.constraint}:${String(i)}`}>
                  <strong>{humanize(b.constraint)}</strong>
                  {b.wave ? ` (wave ${b.wave}${b.role ? `, ${humanize(b.role)}` : ''})` : ''}:{' '}
                  {b.detail}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {p.options.length > 0 ? (
          <section aria-label="Options">
            <h3 className={styles.sectionTitle}>Options that would make it fit</h3>
            <ul className={styles.plainList}>
              {p.options.map((o, i) => (
                <li key={`${o.option}:${String(i)}`} className={s.small}>
                  <strong>{humanize(o.option)}</strong>: {o.detail}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {p.vendor_dependencies && p.vendor_dependencies.length > 0 ? (
          <Callout tone="warning" title="Waiting on vendor product changes">
            <ul className={styles.plainList}>
              {p.vendor_dependencies.map((v) => (
                <li key={v.gap_id}>
                  {v.title}
                  {v.vendor_ref ? ` (${v.vendor_ref})` : ''}
                  {v.blocks_waves.length ? `: blocks ${v.blocks_waves.join(', ')}` : ''}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {waves.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className={plan.loadGrid} aria-label="Load against capacity by wave and role">
              <thead>
                <tr>
                  <th scope="col">Wave</th>
                  {usedRoles.map((r) => (
                    <th key={r} scope="col">
                      {humanize(r)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {waves.map((w) => (
                  <tr key={w}>
                    <th scope="row">{w}</th>
                    {usedRoles.map((r) => {
                      const cell = p.load[w]?.[r];
                      if (!cell) return <td key={r}>—</td>;
                      const lr = loadRatio(cell.hours, cell.capacity);
                      return (
                        <td key={r}>
                          <span className={plan.loadCell} data-over={lr.over}>
                            <span>
                              {cell.hours.toLocaleString()} of {cell.capacity.toLocaleString()} h
                              {lr.over ? ' (over)' : ''}
                            </span>
                            {lr.pct !== null ? (
                              <span className={plan.bar} aria-hidden="true">
                                <span
                                  className={plan.barFill}
                                  style={{ width: `${String(Math.min(100, lr.pct))}%` }}
                                />
                              </span>
                            ) : null}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function WaveDialog({
  project,
  wave,
  roles,
  onClose,
}: {
  project: Project;
  wave: Wave | null;
  roles: string[];
  onClose: () => void;
}) {
  const save = useSaveWave(project.id);
  const [f, setF] = useState<WaveForm>({
    key: wave?.key ?? '',
    name: wave?.name ?? '',
    start: wave?.start ?? '',
    end: wave?.end ?? '',
    cutover: wave?.cutover ?? '',
    capacity: Object.fromEntries(
      roles.map((r) => [r, wave?.capacity[r] !== undefined ? String(wave.capacity[r]) : '']),
    ),
  });
  const [submitted, setSubmitted] = useState(false);
  const v = validateWave(f);
  const errors = mergeFieldErrors(v.errors, save.error, submitted);
  const set = (k: keyof WaveForm, val: string) => setF((p) => ({ ...p, [k]: val }));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={wave ? `Edit wave ${wave.name}` : 'Add a wave'}
      submitLabel="Save wave"
      size="lg"
      pending={save.isPending}
      error={save.error}
      fields={['key', 'name', 'start', 'end', 'cutover', 'capacity']}
      onSubmit={() => {
        setSubmitted(true);
        if (!v.body) return;
        save.mutate(
          { key: f.key, body: v.body },
          {
            onSuccess: () => {
              toast.success('Wave saved');
              onClose();
            },
          },
        );
      }}
    >
      <div className={s.grid2}>
        <Field label="Key" help="Letters, digits, - or _." error={errors.key} required>
          <Input
            mono
            value={f.key}
            onChange={(e) => set('key', e.target.value)}
            readOnly={wave !== null}
          />
        </Field>
        <Field label="Name" error={errors.name} required>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Start" error={errors.start} required>
          <Input type="date" value={f.start} onChange={(e) => set('start', e.target.value)} />
        </Field>
        <Field label="End" error={errors.end} required>
          <Input type="date" value={f.end} onChange={(e) => set('end', e.target.value)} />
        </Field>
        <Field label="Cutover date" error={errors.cutover}>
          <Input type="date" value={f.cutover} onChange={(e) => set('cutover', e.target.value)} />
        </Field>
      </div>
      <fieldset className={s.stackSm}>
        <legend className={styles.sectionTitle}>Capacity (hours in the wave)</legend>
        {errors.capacity ? <Callout tone="danger">{errors.capacity}</Callout> : null}
        <div className={s.grid2}>
          {roles.map((r) => (
            <Field key={r} label={humanize(r)}>
              <Input
                type="number"
                min={0}
                inputMode="decimal"
                value={f.capacity[r] ?? ''}
                onChange={(e) =>
                  setF((p) => ({ ...p, capacity: { ...p.capacity, [r]: e.target.value } }))
                }
              />
            </Field>
          ))}
        </div>
      </fieldset>
    </FormDialog>
  );
}

function PinDialog({
  project,
  waves,
  onClose,
}: {
  project: Project;
  waves: Wave[];
  onClose: () => void;
}) {
  const pin = usePin(project.id);
  const [key, setKey] = useState('');
  const [wave, setWave] = useState(NONE);
  const [submitted, setSubmitted] = useState(false);
  const pinErrors: FieldErrors<'scope_key' | 'wave'> = key.trim()
    ? {}
    : { scope_key: 'Choose the scope item.' };
  const errors = mergeFieldErrors(pinErrors, pin.error, submitted);
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Pin a scope item to a wave"
      description="The solver keeps a pinned item in its wave, and reports it when its dependencies make that impossible."
      submitLabel={wave === NONE ? 'Remove pin' : 'Pin item'}
      pending={pin.isPending}
      error={pin.error}
      fields={['scope_key', 'wave']}
      onSubmit={() => {
        setSubmitted(true);
        if (!key.trim()) return;
        pin.mutate(
          { scope_key: key.trim(), wave: wave === NONE ? null : wave },
          {
            onSuccess: () => {
              toast.success(wave === NONE ? 'Pin removed' : 'Item pinned');
              onClose();
            },
          },
        );
      }}
    >
      <ScopeKeyPicker
        projectId={project.id}
        label="Scope item"
        value={key}
        onChange={setKey}
        error={errors.scope_key}
        required
      />
      <Field label="Wave" error={errors.wave}>
        <Select
          options={[
            { value: NONE, label: 'No pin' },
            ...waves.map((w) => ({ value: w.key, label: w.name })),
          ]}
          value={wave}
          onValueChange={setWave}
        />
      </Field>
    </FormDialog>
  );
}
