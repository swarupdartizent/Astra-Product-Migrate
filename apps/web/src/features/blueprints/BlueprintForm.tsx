import { Plus, Trash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePublishedPacks } from '@/api/packs';
import { useRoles, useSecrets } from '@/api/tenancy';
import type { BlueprintValidation, PackSummary, SettingValueType } from '@/api/types';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxGroup,
  Field,
  IconButton,
  Input,
  Mono,
  RadioCards,
  Select,
  StatusPill,
  Textarea,
  type Choice,
} from '@/ui';
import s from '../shared.module.css';
import { formatSettingValue, packRef, strictnessWords } from '../packs/model';
import {
  asRecordList,
  asString,
  asStringList,
  coerceOverrideValue,
  CUTOVER_STRATEGIES,
  DEFAULT_APPROVERS,
  fieldId,
  getIn,
  isRecord,
  MAX_TASK_HOURS,
  optionalInt,
  optionalText,
  overrideStatus,
  PACK_LISTS,
  PATTERNS,
  PLANNING_MODES,
  recordToRows,
  RISK_APPETITES,
  rowsToRecord,
  setIn,
  STREAMS,
  type Content,
  type KeyValueRow,
  type Path,
  withoutKey,
} from './model';
import styles from './Blueprint.module.css';

const NONE = '__none__';

export interface BlueprintFormProps {
  content: Content;
  onChange: (next: Content) => void;
  tenantId: string;
  validation: BlueprintValidation | undefined;
  readOnly: boolean;
}

/** Errors from the latest validation, by exact path, for inline display. */
function useIssueMap(validation: BlueprintValidation | undefined) {
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of validation?.issues ?? []) {
      if (!map.has(issue.path)) map.set(issue.path, issue.message);
    }
    return map;
  }, [validation]);
}

export function BlueprintForm({
  content,
  onChange,
  tenantId,
  validation,
  readOnly,
}: BlueprintFormProps) {
  const packs = usePublishedPacks();
  const roles = useRoles();
  const secrets = useSecrets(tenantId);
  const issues = useIssueMap(validation);
  const set = (path: Path, value: unknown) => onChange(setIn(content, path, value));
  const str = (path: Path) => asString(getIn(content, path));
  const err = (path: string) => issues.get(path);

  const packsOfType = (type: string): PackSummary[] =>
    (packs.data ?? []).filter((p) => p.type === type);

  return (
    <fieldset className={styles.form} disabled={readOnly}>
      <legend className="sr-only">Blueprint</legend>

      {/* ---------------- Basics ---------------- */}
      <Card aria-labelledby="bp-basics">
        <CardHeader titleId="bp-basics" title="Basics" />
        <CardBody className={s.stack}>
          <div className={s.grid2}>
            <Field
              label="Blueprint name"
              help="Lowercase letters, digits and hyphens."
              error={err('name')}
              controlId={fieldId('name')}
              required
            >
              <Input
                mono
                value={str(['name'])}
                onChange={(e) => set(['name'], e.target.value)}
                spellCheck={false}
              />
            </Field>
            <Field
              label="Cutover strategy"
              help="Optional. How the switch to the target happens."
              error={err('cutover_strategy')}
              controlId={fieldId('cutover_strategy')}
            >
              <Select
                options={[{ value: NONE, label: 'Not decided yet' }, ...CUTOVER_STRATEGIES]}
                value={str(['cutover_strategy']) || NONE}
                onValueChange={(v) => set(['cutover_strategy'], v === NONE ? undefined : v)}
                disabled={readOnly}
              />
            </Field>
          </div>
          <Field label="Description" error={err('description')} controlId={fieldId('description')}>
            <Textarea
              rows={2}
              value={str(['description'])}
              onChange={(e) => set(['description'], e.target.value)}
            />
          </Field>
          <RadioCards
            id={fieldId('pattern')}
            legend="Migration pattern"
            options={PATTERNS}
            value={str(['pattern']) as (typeof PATTERNS)[number]['value'] | ''}
            onValueChange={(v) => set(['pattern'], v)}
            error={err('pattern')}
            disabled={readOnly}
          />
        </CardBody>
      </Card>

      {/* ---------------- Source and target ---------------- */}
      <Card aria-labelledby="bp-endpoints">
        <CardHeader
          titleId="bp-endpoints"
          title="Source and target"
          description="Adapters are pinned to an exact published version. Connections refer to the tenant's connector secrets; credentials never go in a blueprint."
        />
        <CardBody className={s.grid2}>
          {(['source', 'target'] as const).map((side) => (
            <EndpointFields
              key={side}
              side={side}
              content={content}
              set={set}
              err={err}
              adapters={packsOfType(side === 'source' ? 'source_adapter' : 'target_adapter')}
              secrets={secrets.data?.map((x) => x.reference) ?? null}
              readOnly={readOnly}
            />
          ))}
        </CardBody>
      </Card>

      {/* ---------------- Packs ---------------- */}
      <Card aria-labelledby="bp-packs">
        <CardHeader
          titleId="bp-packs"
          title="Packs"
          description="Published packs only, one version of each. Compliance packs add controls; settings that disagree between packs become decisions."
        />
        <CardBody className={s.grid2}>
          {PACK_LISTS.map((list) => {
            const chosen = asStringList(getIn(content, [list.field]));
            const options: Choice[] = packsOfType(list.type).map((p) => ({
              value: packRef(p),
              label: p.title,
              description: packRef(p),
            }));
            for (const ref of chosen) {
              if (!options.some((o) => o.value === ref)) {
                options.push({ value: ref, label: ref, description: 'Not published' });
              }
            }
            const listError = [...issues.entries()].find(([p]) => p.startsWith(list.field))?.[1];
            return (
              <CheckboxGroup
                key={list.field}
                id={fieldId(list.field)}
                legend={list.label}
                options={options}
                value={chosen}
                onValueChange={(next) => set([list.field], next)}
                maxHeight="12rem"
                emptyText={packs.isPending ? 'Loading packs…' : 'No published packs of this type.'}
                error={listError}
                disabled={readOnly}
              />
            );
          })}
        </CardBody>
      </Card>

      {/* ---------------- Streams ---------------- */}
      <Card aria-labelledby="bp-streams">
        <CardHeader
          titleId="bp-streams"
          title="Streams"
          description="Optional settings per workstream, as key and value. Values may be text, numbers, true/false, or JSON."
        />
        <CardBody className={s.stackSm}>
          {STREAMS.map((stream) => (
            <StreamEditor
              key={stream}
              stream={stream}
              value={getIn(content, ['streams', stream])}
              onChange={(record) => {
                const current = isRecord(content.streams) ? content.streams : {};
                const streams =
                  Object.keys(record).length === 0
                    ? withoutKey(current, stream)
                    : { ...current, [stream]: record };
                set(['streams'], Object.keys(streams).length > 0 ? streams : undefined);
              }}
              error={err(`streams.${stream}`) ?? err('streams')}
              readOnly={readOnly}
            />
          ))}
        </CardBody>
      </Card>

      {/* ---------------- Constraints ---------------- */}
      <ConstraintsSection content={content} set={set} err={err} readOnly={readOnly} />

      {/* ---------------- Planning ---------------- */}
      <Card aria-labelledby="bp-planning">
        <CardHeader titleId="bp-planning" title="Planning" />
        <CardBody className={s.grid2}>
          <Field label="Mode" error={err('planning.mode')} controlId={fieldId('planning.mode')}>
            <Select
              options={PLANNING_MODES}
              value={str(['planning', 'mode']) || 'delivery'}
              onValueChange={(v) => set(['planning', 'mode'], v)}
              disabled={readOnly}
            />
          </Field>
          <Field
            label="Maximum task size (hours)"
            help={`No task may exceed ${MAX_TASK_HOURS} hours.`}
            error={err('planning.max_task_hours')}
            controlId={fieldId('planning.max_task_hours')}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_TASK_HOURS}
              value={asString(getIn(content, ['planning', 'max_task_hours']) ?? '')}
              placeholder={String(MAX_TASK_HOURS)}
              onChange={(e) => set(['planning', 'max_task_hours'], optionalInt(e.target.value))}
            />
          </Field>
          <Field
            label="Risk appetite"
            error={err('planning.risk_appetite')}
            controlId={fieldId('planning.risk_appetite')}
          >
            <Select
              options={RISK_APPETITES}
              value={str(['planning', 'risk_appetite']) || 'low'}
              onValueChange={(v) => set(['planning', 'risk_appetite'], v)}
              disabled={readOnly}
            />
          </Field>
        </CardBody>
      </Card>

      {/* ---------------- Approvals ---------------- */}
      <Card aria-labelledby="bp-approvals">
        <CardHeader
          titleId="bp-approvals"
          title="Approvals"
          description="Roles whose holders must approve. Every listed role must approve a blueprint version before planning can start."
        />
        <CardBody className={s.grid2}>
          {(['blueprint', 'plan', 'cutover'] as const).map((stage) => {
            const stored = getIn(content, ['approvals', stage]);
            const value =
              stored === undefined && stage !== 'cutover'
                ? [...DEFAULT_APPROVERS]
                : asStringList(stored);
            return (
              <CheckboxGroup
                key={stage}
                id={fieldId(`approvals.${stage}`)}
                legend={
                  stage === 'blueprint'
                    ? 'Blueprint approvers'
                    : stage === 'plan'
                      ? 'Plan approvers'
                      : 'Cutover approvers'
                }
                help={
                  stored === undefined && stage !== 'cutover'
                    ? 'Using the default approvers.'
                    : undefined
                }
                options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.label }))}
                value={value}
                onValueChange={(next) => set(['approvals', stage], next)}
                maxHeight="12rem"
                emptyText={roles.isPending ? 'Loading roles…' : 'Roles could not be loaded.'}
                error={err(`approvals.${stage}`)}
                disabled={readOnly}
              />
            );
          })}
        </CardBody>
      </Card>

      {/* ---------------- Overrides ---------------- */}
      <OverridesSection
        content={content}
        set={set}
        err={err}
        validation={validation}
        readOnly={readOnly}
      />

      {/* ---------------- Documents ---------------- */}
      <Card aria-labelledby="bp-documents">
        <CardHeader titleId="bp-documents" title="Documents" />
        <CardBody>
          <Field
            label="Retrieval sample size"
            help="How many documents are sampled to check retrieval (1–100,000; default 200)."
            error={err('documents.retrieval_sample_size')}
            controlId={fieldId('documents.retrieval_sample_size')}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={100000}
              placeholder="200"
              value={asString(getIn(content, ['documents', 'retrieval_sample_size']) ?? '')}
              onChange={(e) =>
                set(['documents', 'retrieval_sample_size'], optionalInt(e.target.value))
              }
              style={{ maxWidth: '12rem' }}
            />
          </Field>
        </CardBody>
      </Card>
    </fieldset>
  );
}

// ---------------------------------------------------------------- endpoints

interface SectionProps {
  content: Content;
  set: (path: Path, value: unknown) => void;
  err: (path: string) => string | undefined;
  readOnly: boolean;
}

function EndpointFields({
  side,
  content,
  set,
  err,
  adapters,
  secrets,
  readOnly,
}: SectionProps & {
  side: 'source' | 'target';
  adapters: PackSummary[];
  /** secret:// references in the tenant, or null when they cannot be listed. */
  secrets: string[] | null;
}) {
  const adapter = asString(getIn(content, [side, 'adapter']));
  const connection = asString(getIn(content, [side, 'connection']));
  const options = adapters.map((p) => ({ value: packRef(p), label: `${p.title} (${packRef(p)})` }));
  if (adapter && !options.some((o) => o.value === adapter)) {
    options.push({ value: adapter, label: `${adapter} (not published)` });
  }
  const connectionOptions = [
    { value: NONE, label: 'No connection yet' },
    ...(secrets ?? []).map((ref) => ({ value: ref, label: ref })),
  ];
  if (connection && !connectionOptions.some((o) => o.value === connection)) {
    connectionOptions.push({ value: connection, label: `${connection} (not found)` });
  }
  const title = side === 'source' ? 'Source' : 'Target';
  return (
    <section aria-label={title} className={s.stackSm}>
      <h3 className={s.cellPrimary}>{title}</h3>
      <Field
        label={`${title} adapter`}
        error={err(`${side}.adapter`) ?? err(side)}
        controlId={fieldId(`${side}.adapter`)}
        required
      >
        <Select
          options={options}
          value={adapter}
          onValueChange={(v) => set([side, 'adapter'], v)}
          placeholder={options.length === 0 ? 'No published adapters' : 'Choose an adapter'}
          disabled={readOnly || options.length === 0}
        />
      </Field>
      <Field
        label="Connection"
        help={
          secrets === null
            ? 'Type a reference like secret://name. Secrets could not be listed with your permissions.'
            : 'A connector secret in this tenant.'
        }
        error={err(`${side}.connection`)}
        controlId={fieldId(`${side}.connection`)}
      >
        {secrets === null ? (
          <Input
            mono
            placeholder="secret://name"
            value={connection}
            onChange={(e) => set([side, 'connection'], optionalText(e.target.value))}
            spellCheck={false}
          />
        ) : (
          <Select
            options={connectionOptions}
            value={connection || NONE}
            onValueChange={(v) => set([side, 'connection'], v === NONE ? undefined : v)}
            disabled={readOnly}
          />
        )}
      </Field>
      <Field
        label="Load method"
        help="Optional, as the adapter names it."
        error={err(`${side}.load_method`)}
        controlId={fieldId(`${side}.load_method`)}
      >
        <Input
          value={asString(getIn(content, [side, 'load_method']))}
          onChange={(e) => set([side, 'load_method'], optionalText(e.target.value))}
        />
      </Field>
    </section>
  );
}

// ---------------------------------------------------------------- streams

function StreamEditor({
  stream,
  value,
  onChange,
  error,
  readOnly,
}: {
  stream: string;
  value: unknown;
  onChange: (record: Record<string, unknown>) => void;
  error: string | undefined;
  readOnly: boolean;
}) {
  // Rows are local so a half-typed entry (empty key) is not lost; the parent form remounts
  // this editor when the blueprint is replaced (YAML switch, version load).
  const [rows, setRows] = useState<KeyValueRow[]>(() => recordToRows(value));
  const update = (next: KeyValueRow[]) => {
    setRows(next);
    onChange(rowsToRecord(next));
  };
  const label = stream.charAt(0).toUpperCase() + stream.slice(1);
  return (
    <details className={styles.stream} open={rows.length > 0} id={fieldId(`streams.${stream}`)}>
      <summary className={styles.streamSummary}>
        {label}
        <span className={`${s.muted} ${s.small}`}>
          {rows.length === 0
            ? 'No settings'
            : `${rows.length} setting${rows.length === 1 ? '' : 's'}`}
        </span>
      </summary>
      <div className={styles.streamBody}>
        {rows.map((row, i) => (
          <div key={i} className={styles.kvRow}>
            <Field label="Key" hideLabel>
              <Input
                size="sm"
                mono
                placeholder="key"
                aria-label={`${label} setting ${i + 1} key`}
                value={row.key}
                onChange={(e) =>
                  update(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                }
              />
            </Field>
            <Field label="Value" hideLabel>
              <Input
                size="sm"
                placeholder="value"
                aria-label={`${label} setting ${i + 1} value`}
                value={row.value}
                onChange={(e) =>
                  update(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                }
              />
            </Field>
            {!readOnly ? (
              <IconButton
                size="sm"
                label={`Remove ${label} setting ${row.key || i + 1}`}
                icon={<Trash aria-hidden="true" />}
                onClick={() => update(rows.filter((_, j) => j !== i))}
              />
            ) : null}
          </div>
        ))}
        {!readOnly ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => update([...rows, { key: '', value: '' }])}
            >
              Add {stream} setting
            </Button>
          </div>
        ) : null}
        {error ? <p className={styles.inlineError}>{error}</p> : null}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- constraints

function ConstraintsSection({ content, set, err, readOnly }: SectionProps) {
  const freeze = asRecordList(getIn(content, ['constraints', 'freeze_periods']));
  const str = (path: Path) => asString(getIn(content, path));
  return (
    <Card aria-labelledby="bp-constraints">
      <CardHeader titleId="bp-constraints" title="Constraints" />
      <CardBody className={s.stack}>
        <div className={s.grid2}>
          <Field
            label="Cutover window"
            help="For example “weekend, max 36h”."
            error={err('constraints.cutover_window')}
            controlId={fieldId('constraints.cutover_window')}
          >
            <Input
              value={str(['constraints', 'cutover_window'])}
              onChange={(e) => set(['constraints', 'cutover_window'], optionalText(e.target.value))}
            />
          </Field>
          <Field
            label="Waves"
            help="How to group waves, for example “by-region”."
            error={err('constraints.waves')}
            controlId={fieldId('constraints.waves')}
          >
            <Input
              value={str(['constraints', 'waves'])}
              onChange={(e) => set(['constraints', 'waves'], optionalText(e.target.value))}
            />
          </Field>
          <Field
            label="Target completion"
            error={err('constraints.target_completion')}
            controlId={fieldId('constraints.target_completion')}
          >
            <Input
              type="date"
              value={str(['constraints', 'target_completion'])}
              onChange={(e) =>
                set(['constraints', 'target_completion'], optionalText(e.target.value))
              }
            />
          </Field>
          <Field
            label="Budget (person-days)"
            error={err('constraints.budget_person_days')}
            controlId={fieldId('constraints.budget_person_days')}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              value={asString(getIn(content, ['constraints', 'budget_person_days']) ?? '')}
              onChange={(e) =>
                set(['constraints', 'budget_person_days'], optionalInt(e.target.value))
              }
            />
          </Field>
        </div>
        <fieldset
          className={styles.repeater}
          id={fieldId('constraints.freeze_periods')}
          tabIndex={-1}
        >
          <legend className={styles.repeaterLegend}>Freeze periods</legend>
          {freeze.length === 0 ? (
            <p className={`${s.muted} ${s.small}`}>No freeze periods.</p>
          ) : null}
          {freeze.map((period, i) => {
            const base = `constraints.freeze_periods[${i}]`;
            const setP = (key: string, value: unknown) =>
              set(['constraints', 'freeze_periods', i], { ...period, [key]: value });
            return (
              <div key={i} className={styles.freezeRow}>
                <Field
                  label="Start"
                  error={err(`${base}.start`) ?? err(base)}
                  controlId={fieldId(`${base}.start`)}
                >
                  <Input
                    type="date"
                    size="sm"
                    value={asString(period.start)}
                    onChange={(e) => setP('start', e.target.value)}
                  />
                </Field>
                <Field label="End" error={err(`${base}.end`)} controlId={fieldId(`${base}.end`)}>
                  <Input
                    type="date"
                    size="sm"
                    value={asString(period.end)}
                    onChange={(e) => setP('end', e.target.value)}
                  />
                </Field>
                <Field label="Reason" controlId={fieldId(`${base}.reason`)}>
                  <Input
                    size="sm"
                    value={asString(period.reason)}
                    onChange={(e) => setP('reason', e.target.value)}
                  />
                </Field>
                {!readOnly ? (
                  <IconButton
                    size="sm"
                    label={`Remove freeze period ${i + 1}`}
                    icon={<Trash aria-hidden="true" />}
                    onClick={() => {
                      const next = freeze.filter((_, j) => j !== i);
                      set(['constraints', 'freeze_periods'], next.length ? next : undefined);
                    }}
                  />
                ) : null}
              </div>
            );
          })}
          {!readOnly ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<Plus aria-hidden="true" />}
                onClick={() =>
                  set(
                    ['constraints', 'freeze_periods'],
                    [...freeze, { start: '', end: '', reason: '' }],
                  )
                }
              >
                Add freeze period
              </Button>
            </div>
          ) : null}
        </fieldset>
        <Field
          label="Notes"
          error={err('constraints.notes')}
          controlId={fieldId('constraints.notes')}
        >
          <Textarea
            rows={2}
            value={str(['constraints', 'notes'])}
            onChange={(e) => set(['constraints', 'notes'], optionalText(e.target.value))}
          />
        </Field>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- overrides

function OverridesSection({
  content,
  set,
  err,
  validation,
  readOnly,
}: SectionProps & { validation: BlueprintValidation | undefined }) {
  const overrides = asRecordList(getIn(content, ['overrides']));
  const settings = validation?.composition?.settings ?? [];
  const keys = settings.map((x) => x.key);
  return (
    <Card aria-labelledby="bp-overrides">
      <CardHeader
        titleId="bp-overrides"
        title="Overrides"
        description="Customer-specific values for settings the packs define. Tightening is free; loosening needs a named approver and a reason (it appears under Decisions once saved)."
      />
      <CardBody className={s.stackSm}>
        {overrides.length === 0 ? <p className={`${s.muted} ${s.small}`}>No overrides.</p> : null}
        {overrides.map((o, i) => {
          const base = `overrides[${i}]`;
          const key = asString(o.setting);
          const def = settings.find((x) => x.key === key);
          const sample: SettingValueType | undefined = def?.values[0]?.value;
          const status = overrideStatus(o, i, validation);
          const options = keys.map((k) => ({ value: k, label: k }));
          if (key && !keys.includes(key))
            options.push({ value: key, label: `${key} (not in these packs)` });
          const setO = (field: string, value: unknown) =>
            set(['overrides', i], { ...o, [field]: value });
          return (
            <div key={i} className={styles.override} id={fieldId(base)} tabIndex={-1}>
              <div className={styles.overrideHead}>
                <StatusPill tone={status.tone}>{status.label}</StatusPill>
                {def ? (
                  <span className={`${s.muted} ${s.small}`}>
                    Packs:{' '}
                    {def.values
                      .map((v) => `${formatSettingValue(v.value, def.unit)} (${v.pack})`)
                      .join(', ')}{' '}
                    · {strictnessWords(def.stricter)}
                  </span>
                ) : null}
                {!readOnly ? (
                  <IconButton
                    size="sm"
                    label={`Remove override ${key || i + 1}`}
                    icon={<Trash aria-hidden="true" />}
                    onClick={() => {
                      const next = overrides.filter((_, j) => j !== i);
                      set(['overrides'], next.length ? next : undefined);
                    }}
                  />
                ) : null}
              </div>
              <div className={s.grid2}>
                <Field
                  label="Setting"
                  error={err(`${base}.setting`)}
                  controlId={fieldId(`${base}.setting`)}
                  required
                >
                  <Select
                    options={options}
                    value={key}
                    onValueChange={(v) => setO('setting', v)}
                    placeholder={
                      keys.length === 0
                        ? 'Select packs that define settings first'
                        : 'Choose a setting'
                    }
                    disabled={readOnly || options.length === 0}
                  />
                </Field>
                <Field
                  label={def?.unit ? `Value (${def.unit})` : 'Value'}
                  error={err(`${base}.value`)}
                  controlId={fieldId(`${base}.value`)}
                  required
                >
                  {typeof sample === 'boolean' ? (
                    <Select
                      options={[
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' },
                      ]}
                      value={o.value === true ? 'true' : o.value === false ? 'false' : ''}
                      onValueChange={(v) => setO('value', coerceOverrideValue(v, sample))}
                      disabled={readOnly}
                    />
                  ) : (
                    <Input
                      type={typeof sample === 'number' ? 'number' : 'text'}
                      value={asString(o.value)}
                      onChange={(e) => setO('value', coerceOverrideValue(e.target.value, sample))}
                    />
                  )}
                </Field>
              </div>
              <Field
                label="Reason"
                help="At least 10 characters: why this customer needs a different value."
                error={err(`${base}.reason`)}
                controlId={fieldId(`${base}.reason`)}
                required
              >
                <Textarea
                  rows={2}
                  value={asString(o.reason)}
                  onChange={(e) => setO('reason', e.target.value)}
                />
              </Field>
              {status.effective !== undefined && status.effective !== null ? (
                <p className={`${s.muted} ${s.xs}`}>
                  Compared with <Mono>{formatSettingValue(status.effective, def?.unit)}</Mono>.
                </p>
              ) : null}
            </div>
          );
        })}
        {!readOnly ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() =>
                set(['overrides'], [...overrides, { setting: '', value: '', reason: '' }])
              }
            >
              Add override
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
