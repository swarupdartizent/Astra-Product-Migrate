import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useAdapters } from '@/api/adapters';
import { useTemplates } from '@/api/blueprints';
import { usePacks } from '@/api/packs';
import {
  useAddPod,
  useAssignCustomer,
  useRemovePod,
  useRemoveWave,
  useSaveSetup,
  useSaveWave,
} from '@/api/programmes';
import type {
  Pod,
  ProgrammeCustomer,
  ProgrammeDetail,
  ProgrammePartner,
  ProgrammeWave,
} from '@/api/programmes-types';
import { FormDialog } from '@/app/FormDialog';
import { FormError } from '@/app/FormError';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CheckboxGroup,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  Select,
  Textarea,
  toast,
  type SelectOption,
} from '@/ui';
import s from '../shared.module.css';
import {
  bandInfo,
  fmt,
  podErrors,
  setupBody,
  setupDraft,
  setupErrors,
  splitSegments,
  waveErrors,
  waveWeeks,
  weightSum,
  WEIGHT_TOLERANCE,
  type SetupDraft,
} from './model';
import { AddPartnerDialog } from './ProgrammesPage';
import styles from './Programmes.module.css';

const NONE = '__none__';

/**
 * Programme set-up (E18.F1.S1): the shared playbook and Complexity Index settings, partners'
 * pods, programme waves and customer assignment. Only the programme owner changes them.
 */
export function SetupView({ programme }: { programme: ProgrammeDetail }) {
  const p = programme;
  return (
    <div className={s.stack}>
      {!p.can_manage ? (
        <Callout tone="info" title="Read-only">
          Only the programme owner changes the set-up, pods, waves and customer assignment.
        </Callout>
      ) : null}
      {p.can_manage ? <PlaybookForm programme={p} /> : <PlaybookReadOnly programme={p} />}
      <PartnersCard programme={p} />
      <WavesCard programme={p} />
      <CustomersCard programme={p} />
    </div>
  );
}

// ---------- Playbook and Complexity Index ----------

function withCurrent(options: SelectOption[], current: string | null): SelectOption[] {
  const out: SelectOption[] = [{ value: NONE, label: 'None' }, ...options];
  if (current && !options.some((o) => o.value === current)) {
    out.push({ value: current, label: `${current} (not listed)` });
  }
  return out;
}

function PlaybookReadOnly({ programme: p }: { programme: ProgrammeDetail }) {
  return (
    <>
      <Card aria-labelledby="setup-playbook-head">
        <CardHeader titleId="setup-playbook-head" title="Shared playbook" />
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'src',
                label: 'Source adapter',
                value: p.source_adapter ? <Mono>{p.source_adapter}</Mono> : null,
              },
              {
                key: 'tgt',
                label: 'Target adapter',
                value: p.target_adapter ? <Mono>{p.target_adapter}</Mono> : null,
              },
              { key: 'tpl', label: 'Blueprint template', value: p.blueprint_template },
              {
                key: 'packs',
                label: 'Packs',
                value: p.packs.length ? p.packs.map((x) => <Mono key={x}>{x} </Mono>) : null,
              },
              {
                key: 'seg',
                label: 'Segments',
                value: p.segments.length ? p.segments.join(', ') : null,
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card flush aria-labelledby="setup-mci-head">
        <CardHeader
          titleId="setup-mci-head"
          title="Complexity Index"
          description="Each measure is normalised between its low and high value and weighted."
        />
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Complexity Index settings"
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" className={styles.num}>
                  Weight
                </th>
                <th scope="col" className={styles.num}>
                  Low
                </th>
                <th scope="col" className={styles.num}>
                  High
                </th>
              </tr>
            </thead>
            <tbody>
              {p.mci.measures.map((m) => (
                <tr key={m.key}>
                  <th scope="row">{m.label}</th>
                  <td className={styles.num}>{fmt(p.mci.weights[m.key] ?? 0, 3)}</td>
                  <td className={styles.num}>{fmt(p.mci.ranges[m.key]?.[0] ?? 0, 3)}</td>
                  <td className={styles.num}>{fmt(p.mci.ranges[m.key]?.[1] ?? 0, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CardBody>
          <KeyValueList
            items={[
              {
                key: 'bands',
                label: 'Bands',
                value: `Simple below ${fmt(p.mci.bands.simple)}, medium below ${fmt(p.mci.bands.medium)}, complex from ${fmt(p.mci.bands.medium)}`,
              },
              {
                key: 'weeks',
                label: 'Weeks per band',
                value: (['simple', 'medium', 'complex'] as const)
                  .map((b) => `${bandInfo(b).label} ${fmt(p.band_effort_weeks[b] ?? 0)}`)
                  .join(' · '),
              },
            ]}
          />
        </CardBody>
      </Card>
    </>
  );
}

function NumCell({
  label,
  value,
  error,
  onChange,
  step = 'any',
  min,
}: {
  label: string;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
  step?: string;
  min?: number;
}) {
  const id = useId();
  return (
    <>
      <Input
        size="sm"
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={value}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? id : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <span id={id} className={`${s.xs} ${styles.sumBad}`}>
          {error}
        </span>
      ) : null}
    </>
  );
}

function PlaybookForm({ programme: p }: { programme: ProgrammeDetail }) {
  const save = useSaveSetup(p.id);
  const adapters = useAdapters();
  const templates = useTemplates();
  const packs = usePacks();
  const [draft, setDraft] = useState<SetupDraft>(() => setupDraft(p));
  const [submitted, setSubmitted] = useState(false);
  const measures = p.mci.measures;
  const inUse = [...new Set(p.customers.map((c) => c.segment).filter((x): x is string => !!x))];
  const clientErrors = setupErrors(draft, measures, inUse);
  const errors: FieldErrors = submitted ? clientErrors : {};
  const sum = weightSum(draft, measures);
  const sumOk = sum !== null && Math.abs(sum - 1) <= WEIGHT_TOLERANCE;
  const set = (patch: Partial<SetupDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (save.error) save.reset();
  };
  const setIn = (field: 'weights' | 'lows' | 'highs', key: string, v: string) =>
    set({ [field]: { ...draft[field], [key]: v } });

  const adapterOptions = (type: string) =>
    (adapters.data ?? [])
      .filter((a) => a.type === type)
      .map((a) => ({ value: a.ref, label: `${a.title} (${a.ref})` }));
  const packOptions = (packs.data ?? [])
    .filter((x) => !String(x.type).endsWith('_adapter'))
    .map((x): { value: string; label: string; description: string } => ({
      value: `${x.name}@${x.version}`,
      label: `${x.title} (${x.name}@${x.version})`,
      description: x.status,
    }));
  for (const ref of draft.packs) {
    if (!packOptions.some((o) => o.value === ref)) {
      packOptions.push({ value: ref, label: ref, description: 'not listed' });
    }
  }

  const submit = () => {
    setSubmitted(true);
    if (hasErrors(clientErrors)) return;
    save.mutate(setupBody(draft, measures), {
      onSuccess: () => {
        setSubmitted(false);
        toast.success('Programme set-up saved');
      },
    });
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={s.stack}
    >
      <Card aria-labelledby="setup-playbook-head">
        <CardHeader
          titleId="setup-playbook-head"
          title="Shared playbook"
          description="Every customer of the programme starts from these adapters, blueprint template and packs."
        />
        <CardBody>
          <div className={styles.formGrid}>
            <Field label="Source adapter">
              <Select
                options={withCurrent(adapterOptions('source_adapter'), p.source_adapter)}
                value={draft.source_adapter || NONE}
                onValueChange={(v) => set({ source_adapter: v === NONE ? '' : v })}
              />
            </Field>
            <Field label="Target adapter">
              <Select
                options={withCurrent(adapterOptions('target_adapter'), p.target_adapter)}
                value={draft.target_adapter || NONE}
                onValueChange={(v) => set({ target_adapter: v === NONE ? '' : v })}
              />
            </Field>
            <Field label="Blueprint template">
              <Select
                options={withCurrent(
                  (templates.data ?? []).map((t) => ({ value: t.name, label: t.title || t.name })),
                  p.blueprint_template,
                )}
                value={draft.blueprint_template || NONE}
                onValueChange={(v) => set({ blueprint_template: v === NONE ? '' : v })}
              />
            </Field>
          </div>
        </CardBody>
        <CardBody>
          <div className={styles.formGrid}>
            <CheckboxGroup
              legend="Packs the customers share"
              options={packOptions}
              value={draft.packs}
              onValueChange={(v) => set({ packs: v })}
              maxHeight="14rem"
              emptyText={packs.isPending ? 'Loading packs…' : 'No packs in the registry.'}
            />
            <Field
              label="Segments"
              help="One per line, for example a line of business or a region. Segments customers use cannot be removed."
              error={errors.segments}
            >
              <Textarea
                rows={5}
                value={draft.segments}
                onChange={(e) => set({ segments: e.target.value })}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card flush aria-labelledby="setup-mci-head">
        <CardHeader
          titleId="setup-mci-head"
          title="Complexity Index"
          description="Each measure is normalised between its low and high value, then weighted. The weights must add up to 1."
        />
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Complexity Index settings"
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Weight</th>
                <th scope="col">Low</th>
                <th scope="col">High</th>
              </tr>
            </thead>
            <tbody>
              {measures.map((m) => (
                <tr key={m.key}>
                  <th scope="row">{m.label}</th>
                  <td>
                    <NumCell
                      label={`Weight of ${m.label}`}
                      value={draft.weights[m.key] ?? ''}
                      error={errors[`weight.${m.key}`]}
                      onChange={(v) => setIn('weights', m.key, v)}
                      step="0.01"
                      min={0}
                    />
                  </td>
                  <td>
                    <NumCell
                      label={`Low of ${m.label}`}
                      value={draft.lows[m.key] ?? ''}
                      error={errors[`low.${m.key}`]}
                      onChange={(v) => setIn('lows', m.key, v)}
                    />
                  </td>
                  <td>
                    <NumCell
                      label={`High of ${m.label}`}
                      value={draft.highs[m.key] ?? ''}
                      error={errors[`high.${m.key}`]}
                      onChange={(v) => setIn('highs', m.key, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CardBody>
          <p
            role="status"
            aria-live="polite"
            className={`${s.small} ${sumOk ? styles.sumOk : styles.sumBad}`}
          >
            {sum === null
              ? 'Every weight needs a number.'
              : sumOk
                ? `The weights add up to ${sum.toFixed(3)}.`
                : `The weights add up to ${sum.toFixed(3)}; they must add up to 1 (${sum > 1 ? 'remove' : 'add'} ${Math.abs(1 - sum).toFixed(3)}).`}
          </p>
        </CardBody>
        <CardBody>
          <div className={styles.formGrid}>
            <Field
              label="Simple below"
              help="Scores under this limit are simple."
              error={errors.bandSimple}
            >
              <Input
                type="number"
                step="any"
                value={draft.bandSimple}
                onChange={(e) => set({ bandSimple: e.target.value })}
              />
            </Field>
            <Field
              label="Medium below"
              help="Scores from the simple limit up to this one are medium; above, complex."
              error={errors.bandMedium}
            >
              <Input
                type="number"
                step="any"
                value={draft.bandMedium}
                onChange={(e) => set({ bandMedium: e.target.value })}
              />
            </Field>
          </div>
        </CardBody>
        <CardBody>
          <fieldset className={styles.formGrid}>
            <legend className={s.small}>
              Weeks each band needs. A wave holds a customer only if it is this long.
            </legend>
            {(['simple', 'medium', 'complex'] as const).map((b) => (
              <Field key={b} label={`${bandInfo(b).label} (weeks)`} error={errors[`weeks.${b}`]}>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  max={104}
                  value={draft.weeks[b]}
                  onChange={(e) => set({ weeks: { ...draft.weeks, [b]: e.target.value } })}
                />
              </Field>
            ))}
          </fieldset>
        </CardBody>
        <CardFooter>
          <div className={s.stackSm}>
            {submitted && hasErrors(clientErrors) ? (
              <p role="alert" className={`${s.small} ${styles.sumBad}`}>
                {clientErrors.weights ?? 'Fix the highlighted fields before saving.'}
              </p>
            ) : null}
            <FormError error={save.error} />
            <span className={s.row}>
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save set-up
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setDraft(setupDraft(p));
                  setSubmitted(false);
                  save.reset();
                }}
              >
                Reset
              </Button>
            </span>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}

// ---------- Partners and pods ----------

function PartnersCard({ programme: p }: { programme: ProgrammeDetail }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card aria-labelledby="setup-partners-head">
      <CardHeader
        titleId="setup-partners-head"
        title="Partners and pods"
        description="A pod is a delivery team of a partner. Its capacity is how many customers it migrates at once in a wave."
        actions={
          p.can_manage ? (
            <Button
              size="sm"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => setAdding(true)}
            >
              Add partner
            </Button>
          ) : null
        }
      />
      <CardBody>
        {p.partners.length === 0 ? (
          <EmptyState compact title="No partners" body="Add a partner, then give it pods." />
        ) : (
          p.partners.map((partner) => (
            <PartnerPods key={partner.id} programme={p} partner={partner} />
          ))
        )}
      </CardBody>
      {adding ? (
        <AddPartnerDialog
          programme={{ id: p.id, name: p.name, description: p.description, partners: p.partners }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Card>
  );
}

function PartnerPods({
  programme: p,
  partner,
}: {
  programme: ProgrammeDetail;
  partner: ProgrammePartner;
}) {
  const add = useAddPod(p.id);
  const remove = useRemovePod(p.id);
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('2');
  const [submitted, setSubmitted] = useState(false);
  const [removing, setRemoving] = useState<Pod | null>(null);
  const clientErrors = podErrors(name, capacity);
  const errors = mergeFieldErrors(clientErrors, add.error, submitted);
  const headId = useId();
  return (
    <section className={styles.partner} aria-labelledby={headId}>
      <h3 id={headId} className={s.cellPrimary}>
        {partner.name}
      </h3>
      {partner.pods.length === 0 ? (
        <p className={`${s.small} ${s.muted}`}>
          No pods yet. The planner cannot place this partner’s customers until it has one.
        </p>
      ) : (
        <table className={styles.table}>
          <caption className="sr-only">Pods of {partner.name}</caption>
          <thead>
            <tr>
              <th scope="col">Pod</th>
              <th scope="col" className={styles.num}>
                Capacity
              </th>
              {p.can_manage ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {partner.pods.map((pod) => (
              <tr key={pod.id}>
                <th scope="row">{pod.name}</th>
                <td className={styles.num}>{pod.capacity}</td>
                {p.can_manage ? (
                  <td>
                    <span className={s.rowActions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<Trash2 aria-hidden="true" />}
                        aria-label={`Remove pod ${pod.name}`}
                        onClick={() => setRemoving(pod)}
                      >
                        Remove
                      </Button>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.can_manage ? (
        <form
          noValidate
          className={styles.inlineForm}
          aria-label={`Add a pod to ${partner.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (hasErrors(clientErrors)) return;
            add.mutate(
              { partnerId: partner.id, body: { name: name.trim(), capacity: Number(capacity) } },
              {
                onSuccess: () => {
                  toast.success(`Pod ${name.trim()} added to ${partner.name}`);
                  setName('');
                  setSubmitted(false);
                },
              },
            );
          }}
        >
          <Field label="Pod name" error={errors.name}>
            <Input
              size="sm"
              value={name}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                if (add.error) add.reset();
              }}
            />
          </Field>
          <Field label="Capacity" help="1–50 customers per wave" error={errors.capacity}>
            <Input
              size="sm"
              type="number"
              min={1}
              max={50}
              step={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            loading={add.isPending}
            leadingIcon={<Plus aria-hidden="true" />}
          >
            Add pod
          </Button>
        </form>
      ) : null}
      <FormError error={add.error} fields={['name', 'capacity']} />
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setRemoving(null);
          }}
          title={`Remove pod ${removing.name}?`}
          description="The pod is deleted. The latest portfolio plan keeps its places until the planner runs again."
          confirmLabel="Remove pod"
          tone="danger"
          onConfirm={async () => {
            await remove.mutateAsync(removing.id);
            toast.success(`Pod ${removing.name} removed`);
          }}
        />
      ) : null}
    </section>
  );
}

// ---------- Programme waves ----------

function WavesCard({ programme: p }: { programme: ProgrammeDetail }) {
  const remove = useRemoveWave(p.id);
  const [editing, setEditing] = useState<ProgrammeWave | 'new' | null>(null);
  const [removing, setRemoving] = useState<ProgrammeWave | null>(null);
  return (
    <Card flush aria-labelledby="setup-waves-head">
      <CardHeader
        titleId="setup-waves-head"
        title="Programme waves"
        description="The planner places each customer in one wave long enough for its band."
        actions={
          p.can_manage ? (
            <Button
              size="sm"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => setEditing('new')}
            >
              Add wave
            </Button>
          ) : null
        }
      />
      {p.waves.length === 0 ? (
        <EmptyState compact title="No waves" body="Add waves before running the planner." />
      ) : (
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Programme waves table"
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Name</th>
                <th scope="col">Start</th>
                <th scope="col">End</th>
                <th scope="col" className={styles.num}>
                  Weeks
                </th>
                {p.can_manage ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {p.waves.map((w) => (
                <tr key={w.key}>
                  <th scope="row">
                    <Mono>{w.key}</Mono>
                  </th>
                  <td>{w.name}</td>
                  <td>{w.start}</td>
                  <td>{w.end}</td>
                  <td className={styles.num}>{fmt(waveWeeks(w.start, w.end))}</td>
                  {p.can_manage ? (
                    <td>
                      <span className={s.rowActions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<Pencil aria-hidden="true" />}
                          aria-label={`Edit wave ${w.key}`}
                          onClick={() => setEditing(w)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          leadingIcon={<Trash2 aria-hidden="true" />}
                          aria-label={`Remove wave ${w.key}`}
                          onClick={() => setRemoving(w)}
                        >
                          Remove
                        </Button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <WaveDialog
          programme={p}
          wave={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setRemoving(null);
          }}
          title={`Remove wave ${removing.key}?`}
          description="The wave is deleted. The latest portfolio plan keeps its places until the planner runs again."
          confirmLabel="Remove wave"
          tone="danger"
          onConfirm={async () => {
            await remove.mutateAsync(removing.key);
            toast.success(`Wave ${removing.key} removed`);
          }}
        />
      ) : null}
    </Card>
  );
}

function WaveDialog({
  programme: p,
  wave,
  onClose,
}: {
  programme: ProgrammeDetail;
  wave: ProgrammeWave | null;
  onClose: () => void;
}) {
  const save = useSaveWave(p.id);
  const [key, setKey] = useState(wave?.key ?? '');
  const [name, setName] = useState(wave?.name ?? '');
  const [start, setStart] = useState(wave?.start ?? '');
  const [end, setEnd] = useState(wave?.end ?? '');
  const [submitted, setSubmitted] = useState(false);
  const clientErrors = waveErrors(key, name, start, end, wave ? null : p.waves.map((w) => w.key));
  const errors = mergeFieldErrors(clientErrors, save.error, submitted);
  const weeks = start && end && end >= start ? waveWeeks(start, end) : null;
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={wave ? `Edit wave ${wave.key}` : 'Add wave'}
      submitLabel={wave ? 'Save wave' : 'Add wave'}
      pending={save.isPending}
      error={save.error}
      fields={['key', 'name', 'start', 'end']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        save.mutate(
          { key, body: { name: name.trim(), start, end } },
          {
            onSuccess: () => {
              toast.success(wave ? `Wave ${key} saved` : `Wave ${key} added`);
              onClose();
            },
          },
        );
      }}
    >
      <Field
        label="Key"
        help={wave ? 'The key cannot change.' : 'Letters, digits, - or _, for example w1.'}
        error={errors.key}
        required
      >
        <Input
          mono
          value={key}
          readOnly={wave !== null}
          maxLength={40}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Field label="Name" error={errors.name} required>
        <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className={s.grid2}>
        <Field label="Start" error={errors.start} required>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End" error={errors.end} required>
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <p className={`${s.small} ${s.muted}`} aria-live="polite">
        {weeks !== null
          ? `${fmt(weeks)} weeks: holds ${
              (['simple', 'medium', 'complex'] as const)
                .filter((b) => weeks + 1e-9 >= (p.band_effort_weeks[b] ?? Infinity))
                .map((b) => bandInfo(b).label.toLowerCase())
                .join(', ') || 'no band'
            } customers.`
          : null}
      </p>
    </FormDialog>
  );
}

// ---------- Customer assignment ----------

function CustomersCard({ programme: p }: { programme: ProgrammeDetail }) {
  const [assigning, setAssigning] = useState<ProgrammeCustomer | null>(null);
  const partnerName = (id: string | null) =>
    id ? (p.partners.find((x) => x.id === id)?.name ?? 'Another partner') : null;
  return (
    <Card flush aria-labelledby="setup-customers-head">
      <CardHeader
        titleId="setup-customers-head"
        title="Customers"
        description="Each customer is delivered by one partner and belongs to one segment. A partner sees only its own customers."
      />
      {p.customers.length === 0 ? (
        <EmptyState
          compact
          title="No customers"
          body="Create tenants in this programme to assign them."
        />
      ) : (
        <div
          className={styles.tableWrap}
          // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Customer assignment"
        >
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Partner</th>
                <th scope="col">Segment</th>
                {p.can_manage ? (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {p.customers.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.name}</th>
                  <td>
                    {partnerName(c.partner_id) ?? <span className={s.muted}>No partner</span>}
                  </td>
                  <td>{c.segment ?? <span className={s.muted}>None</span>}</td>
                  {p.can_manage ? (
                    <td>
                      <span className={s.rowActions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Assign ${c.name}`}
                          onClick={() => setAssigning(c)}
                        >
                          Assign
                        </Button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {assigning ? (
        <AssignDialog programme={p} customer={assigning} onClose={() => setAssigning(null)} />
      ) : null}
    </Card>
  );
}

function AssignDialog({
  programme: p,
  customer,
  onClose,
}: {
  programme: ProgrammeDetail;
  customer: ProgrammeCustomer;
  onClose: () => void;
}) {
  const assign = useAssignCustomer(p.id);
  const [partner, setPartner] = useState(customer.partner_id ?? NONE);
  const [segment, setSegment] = useState(customer.segment ?? NONE);
  const errors = mergeFieldErrors<'partner_id' | 'segment'>({}, assign.error, true);
  const segments = splitSegments(p.segments.join('\n'));
  return (
    <FormDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Assign ${customer.name}`}
      description="Choose the partner that delivers this customer and its segment."
      submitLabel="Save assignment"
      size="sm"
      pending={assign.isPending}
      error={assign.error}
      fields={['partner_id', 'segment']}
      onSubmit={() =>
        assign.mutate(
          {
            tenantId: customer.id,
            body: {
              partner_id: partner === NONE ? null : partner,
              segment: segment === NONE ? null : segment,
            },
          },
          {
            onSuccess: () => {
              toast.success(`${customer.name} assigned`);
              onClose();
            },
          },
        )
      }
    >
      <Field
        label="Partner"
        help={p.partners.length === 0 ? 'Add a partner to this programme first.' : undefined}
        error={errors.partner_id}
      >
        <Select
          options={[
            { value: NONE, label: 'No partner' },
            ...p.partners.map((x) => ({ value: x.id, label: x.name })),
          ]}
          value={partner}
          onValueChange={setPartner}
        />
      </Field>
      <Field
        label="Segment"
        help={segments.length === 0 ? 'Add segments in the shared playbook first.' : undefined}
        error={errors.segment}
      >
        <Select
          options={[
            { value: NONE, label: 'No segment' },
            ...segments.map((x) => ({ value: x, label: x })),
          ]}
          value={segment}
          onValueChange={setSegment}
        />
      </Field>
    </FormDialog>
  );
}
