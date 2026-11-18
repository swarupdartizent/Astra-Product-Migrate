import { useState } from 'react';
import { useSetCodeKey } from '@/api/design';
import type {
  DesignItemDetail,
  MappingSource,
  MappingTarget,
  PageSection,
  SourceColumnInfo,
} from '@/api/design-types';
import type { Project } from '@/api/types';
import { FormError } from '@/app/FormError';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  KeyValueList,
  Mono,
  PlainText,
  StatusPill,
  Timestamp,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Design.module.css';
import { FormBody } from './FormBody';
import { IntegrationBody } from './IntegrationBody';
import { METHOD_LABELS, pretty, str, strList } from './model';
import { ConfidenceMeter, Pair } from './Parts';
import { SecurityBody } from './SecurityBody';

/** The stream-specific part of an item's detail. */
export function StreamBody({
  project,
  item,
  threshold,
  onUnsaved,
}: {
  project: Project;
  item: DesignItemDetail;
  threshold: number | null;
  onUnsaved: (why: string | null) => void;
}) {
  switch (item.stream) {
    case 'mapping':
      return <MappingBody item={item} threshold={threshold} />;
    case 'configuration':
      return <ConfigurationBody item={item} />;
    case 'form':
      return <FormBody project={project} item={item} />;
    case 'code':
      return <CodeBody project={project} item={item} />;
    case 'integration':
      return <IntegrationBody project={project} item={item} onUnsaved={onUnsaved} />;
    case 'report':
      return <ReportBody item={item} />;
    case 'page':
      return <PageBody item={item} />;
    case 'security':
      return <SecurityBody project={project} item={item} onUnsaved={onUnsaved} />;
    default:
      return null;
  }
}

// ---------- Mappings ----------

function MappingBody({
  item: it,
  threshold,
}: {
  item: DesignItemDetail;
  threshold: number | null;
}) {
  const src = it.source as unknown as MappingSource;
  const tgt = it.target as unknown as MappingTarget | null;
  const proposed = it.proposed_target as unknown as MappingTarget | null;
  const changedFrom =
    tgt && proposed && (tgt.table !== proposed.table || tgt.column !== proposed.column)
      ? proposed
      : null;
  const precedents = it.precedents ?? [];
  return (
    <>
      <Pair
        source={
          <>
            <Mono>
              {src.table}.{src.column}
            </Mono>
            <KeyValueList
              items={[
                { key: 't', label: 'Type', value: <Mono className={s.xs}>{src.type}</Mono> },
                {
                  key: 'l',
                  label: 'Maximum length',
                  value:
                    src.max_length === null
                      ? null
                      : src.max_length < 0
                        ? 'max'
                        : String(src.max_length),
                },
                { key: 'n', label: 'Nullable', value: src.nullable ? 'Yes' : 'No' },
              ]}
            />
          </>
        }
        target={
          tgt ? (
            <>
              <Mono>
                {tgt.table}.{tgt.column}
              </Mono>
              <KeyValueList
                items={[
                  {
                    key: 't',
                    label: 'Type',
                    value: tgt.type ? <Mono className={s.xs}>{tgt.type}</Mono> : null,
                  },
                  {
                    key: 'n',
                    label: 'Required',
                    value: tgt.nullable === false ? 'Yes (NOT NULL)' : 'No',
                  },
                ]}
              />
              {changedFrom ? (
                <span className={`${s.muted} ${s.xs}`}>
                  Changed from the proposal{' '}
                  <Mono>
                    {changedFrom.table}.{changedFrom.column}
                  </Mono>
                </span>
              ) : null}
            </>
          ) : (
            <span className={s.muted}>
              {it.status === 'approved' ? 'Not migrated (no target).' : 'No target proposed.'}
            </span>
          )
        }
      />
      <section className={styles.section} aria-labelledby={`conf-${it.key}`}>
        <h3 id={`conf-${it.key}`} className={styles.sectionTitle}>
          Confidence
        </h3>
        <ConfidenceMeter
          value={it.confidence}
          threshold={threshold}
          label={`${src.table}.${src.column}`}
        />
        <p className={`${s.muted} ${s.xs}`}>
          0.55 × name similarity + 0.25 × type compatibility + 0.20 × table match, +0.15 when an
          earlier decision in this tenant chose the same target, −0.15 when one chose another, −0.10
          when the runner-up is within 0.05. Each part is listed in the evidence.
        </p>
      </section>
      <section className={styles.section} aria-labelledby={`prec-${it.key}`}>
        <h3 id={`prec-${it.key}`} className={styles.sectionTitle}>
          Precedents ({precedents.length})
        </h3>
        {precedents.length === 0 ? (
          <p className={`${s.muted} ${s.small}`}>
            No earlier decision in this tenant on a column with this name.
          </p>
        ) : (
          <ul className={styles.plainList}>
            {precedents.map((p, i) => (
              <li key={`${p.project_id}:${String(i)}`} className={s.small}>
                {p.target ? (
                  <Mono className={s.xs}>
                    {p.target.table}.{p.target.column}
                  </Mono>
                ) : (
                  'Not migrated'
                )}{' '}
                <span className={s.muted}>
                  in another project{p.decided_by ? `, decided by ${p.decided_by}` : ''}
                  {p.decided_at ? (
                    <>
                      {' '}
                      <Timestamp value={p.decided_at} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------- Configuration ----------

function ConfigurationBody({ item: it }: { item: DesignItemDetail }) {
  const src = it.source;
  const tgt = it.target ?? {};
  const retire = tgt.retire === true;
  const deps = strList(src.depends_on);
  const tdeps = strList(tgt.depends_on);
  return (
    <>
      {retire ? (
        <Callout tone="warning" title="The target retires this configuration">
          Proposed replacement: <strong>{str(tgt.replacement)}</strong>
        </Callout>
      ) : null}
      <Pair
        retire={retire}
        source={
          <>
            <KeyValueList
              items={[
                { key: 'k', label: 'Kind', value: <Mono>{str(src.kind)}</Mono> },
                { key: 'key', label: 'Key', value: <Mono className={s.xs}>{str(src.key)}</Mono> },
                { key: 'n', label: 'Name', value: str(src.name) },
                { key: 's', label: 'Scope', value: str(src.scope) },
                { key: 'd', label: 'Depends on', value: deps.length ? deps.join(', ') : 'Nothing' },
              ]}
            />
            <PlainText
              label={`Source definition of ${it.key}`}
              empty={<p className={s.muted}>No definition.</p>}
            >
              {pretty(src.definition)}
            </PlainText>
          </>
        }
        target={
          retire ? (
            <p>
              <strong>Retired.</strong> Replacement: {str(tgt.replacement)}
            </p>
          ) : it.target ? (
            <>
              <KeyValueList
                items={[
                  { key: 'a', label: 'Area', value: str(tgt.label) ?? str(tgt.area) },
                  {
                    key: 'm',
                    label: 'Method',
                    value: METHOD_LABELS[str(tgt.method) ?? ''] ?? str(tgt.method),
                  },
                  {
                    key: 'k',
                    label: 'Target key',
                    value: <Mono className={s.xs}>{str(tgt.key)}</Mono>,
                  },
                  {
                    key: 'd',
                    label: 'Depends on',
                    value: tdeps.length ? tdeps.join(', ') : 'Nothing',
                  },
                ]}
              />
              {str(tgt.design) ? (
                <p className={s.small}>Reviewer’s design: {str(tgt.design)}</p>
              ) : null}
              <PlainText
                label={`Target definition of ${it.key}`}
                empty={<p className={s.muted}>No definition.</p>}
              >
                {pretty(tgt.definition)}
              </PlainText>
            </>
          ) : (
            <p className={s.muted}>No target: the stream is blocked.</p>
          )
        }
      />
      {!retire && it.target ? (
        <p className={`${s.muted} ${s.xs}`}>
          Applying configuration to the target happens with loads (I10).
        </p>
      ) : null}
    </>
  );
}

// ---------- Customer code ----------

function CodeBody({ project, item: it }: { project: Project; item: DesignItemDetail }) {
  const src = it.source;
  const tgt = it.target ?? {};
  const type = str(src.type) ?? '';
  const conversion = str(src.conversion);
  const udt = type === 'user_defined_table';
  return (
    <>
      <Pair
        source={
          <KeyValueList
            items={[
              { key: 'n', label: 'Name', value: <Mono>{str(src.name)}</Mono> },
              { key: 't', label: 'Type', value: type.replace(/_/g, ' ') },
              {
                key: 'c',
                label: 'Conversion',
                value: udt ? (
                  'Not converted (a table)'
                ) : conversion ? (
                  <StatusPill tone={conversion === 'compiled' ? 'success' : 'warning'}>
                    {conversion.replace(/_/g, ' ')}
                  </StatusPill>
                ) : (
                  'No conversion recorded'
                ),
              },
            ]}
          />
        }
        target={
          it.target ? (
            <KeyValueList
              items={[
                { key: 'q', label: 'Target name', value: <Mono>{str(tgt.qualified)}</Mono> },
                {
                  key: 's',
                  label: 'Schema',
                  value: <Mono className={s.xs}>{str(tgt.schema)}</Mono>,
                },
                { key: 'n', label: 'Name', value: <Mono className={s.xs}>{str(tgt.name)}</Mono> },
              ]}
            />
          ) : (
            <p className={s.muted}>No target name: the naming rules are missing.</p>
          )
        }
        targetLabel="Target (naming rules)"
      />
      {udt ? <KeyPicker project={project} item={it} /> : null}
    </>
  );
}

function KeyPicker({ project, item: it }: { project: Project; item: DesignItemDetail }) {
  const columns = (Array.isArray(it.source.columns) ? it.source.columns : []) as SourceColumnInfo[];
  const saved = it.key_columns ?? [];
  const [chosen, setChosen] = useState<string[]>(saved);
  const save = useSetCodeKey(project.id);
  const decided = it.status === 'approved' || it.status === 'rejected';
  const why = !it.can_decide
    ? (it.cannot_decide_reason ?? 'You cannot change this item.')
    : decided
      ? `The table is ${it.status}; its key cannot change.`
      : null;
  const dirty = chosen.join('|') !== saved.join('|');
  const ordered = [...columns].sort((a, b) => a.ordinal - b.ordinal);
  return (
    <section className={styles.section} aria-labelledby={`key-${it.key}`}>
      <h3 id={`key-${it.key}`} className={styles.sectionTitle}>
        Key columns
      </h3>
      <p className={`${s.muted} ${s.small}`}>
        The source does not report keys, so declare the columns that identify a row. The rebuilt
        table gets this primary key, and deltas match rows by it.
      </p>
      {saved.length > 0 ? (
        <p className={s.small}>
          Declared key: <Mono>{saved.join(', ')}</Mono>
        </p>
      ) : (
        <Callout tone="warning">
          No key is declared yet. The table cannot be approved without one.
        </Callout>
      )}
      {columns.length === 0 ? (
        <p className={s.muted}>The source reported no columns for this table.</p>
      ) : (
        <fieldset className={styles.section} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Choose the key columns</legend>
          {ordered.map((c) => (
            <Field
              key={c.name}
              inline
              label={
                <span>
                  <Mono className={s.small}>{c.name}</Mono>{' '}
                  <span className={`${s.muted} ${s.xs}`}>
                    {c.type}
                    {c.nullable ? ', nullable' : ''}
                  </span>
                </span>
              }
            >
              <Checkbox
                checked={chosen.includes(c.name)}
                disabled={!!why}
                onCheckedChange={(v) =>
                  setChosen((prev) =>
                    v === true
                      ? ordered.map((x) => x.name).filter((n) => n === c.name || prev.includes(n))
                      : prev.filter((n) => n !== c.name),
                  )
                }
              />
            </Field>
          ))}
        </fieldset>
      )}
      <div className={s.row}>
        <Button
          variant="primary"
          disabled={!!why || chosen.length === 0 || !dirty}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { key: it.key, columns: chosen },
              { onSuccess: () => toast.success('Key saved') },
            )
          }
        >
          Save key
        </Button>
        {why ? <span className={`${s.muted} ${s.small}`}>{why}</span> : null}
        {!why && chosen.length === 0 ? (
          <span className={`${s.muted} ${s.small}`}>Choose at least one column.</span>
        ) : null}
        {chosen.some((c) => columns.find((x) => x.name === c)?.nullable) ? (
          <Badge tone="warning">A chosen column allows nulls</Badge>
        ) : null}
      </div>
      <FormError error={save.error} />
    </section>
  );
}

// ---------- Reports ----------

function ReportBody({ item: it }: { item: DesignItemDetail }) {
  const src = it.source;
  const tgt = it.target ?? {};
  return (
    <>
      <Pair
        source={
          <KeyValueList
            items={[{ key: 'v', label: 'View', value: <Mono>{str(src.name)}</Mono> }]}
          />
        }
        target={
          it.target ? (
            <KeyValueList
              items={[
                { key: 'p', label: 'Procedure', value: <Mono>{str(tgt.qualified)}</Mono> },
                { key: 'm', label: 'Mechanism', value: str(tgt.label) ?? str(tgt.mechanism) },
              ]}
            />
          ) : (
            <p className={s.muted}>No target: the stream is blocked.</p>
          )
        }
        targetLabel="Target (read-only procedure)"
      />
      <Callout tone="info" title="Report parity">
        Build compiles and runs the procedure. Report parity, comparing its results with the source
        view’s, runs with validation (I10).
      </Callout>
      <section className={styles.section} aria-labelledby={`def-${it.key}`}>
        <h3 id={`def-${it.key}`} className={styles.sectionTitle}>
          Source view definition
        </h3>
        <PlainText
          label={`Definition of ${str(src.name) ?? it.key}`}
          lineNumbers
          empty={<p className={s.muted}>The adapter returned no definition for this view.</p>}
        >
          {it.definition ?? null}
        </PlainText>
      </section>
    </>
  );
}

// ---------- Pages ----------

function PageBody({ item: it }: { item: DesignItemDetail }) {
  const tgt = it.target ?? {};
  const sections = (Array.isArray(tgt.sections) ? tgt.sections : []) as PageSection[];
  const basis = it.evidence?.[0] ?? null;
  return (
    <>
      <KeyValueList
        items={[
          { key: 'e', label: 'Source entity', value: str(it.source.entity) },
          {
            key: 't',
            label: 'Source table',
            value: <Mono className={s.xs}>{str(it.source.table)}</Mono>,
          },
          { key: 'b', label: 'Page builder', value: str(tgt.builder) },
        ]}
      />
      {basis ? (
        <Callout tone="info" title="How the draft was made">
          {basis}
        </Callout>
      ) : null}
      <section className={styles.section} aria-labelledby={`draft-${it.key}`}>
        <h3 id={`draft-${it.key}`} className={styles.sectionTitle}>
          Draft preview
        </h3>
        <div className={styles.draft}>
          <p className={styles.draftTitle}>{str(tgt.title) ?? 'Untitled page'}</p>
          {sections.map((sec) => (
            <section
              key={sec.label}
              className={styles.draftSection}
              aria-label={`${sec.label} section`}
            >
              <h4 className={styles.subTitle}>{sec.label}</h4>
              {sec.fields && sec.fields.length > 0 ? (
                <ul className={styles.draftFields} style={{ listStyle: 'none' }}>
                  {sec.fields.map((f) => (
                    <li key={f.target} className={styles.draftField}>
                      <span className={styles.draftLabel}>
                        {f.label}
                        {f.required ? (
                          <>
                            <span className={styles.required} aria-hidden="true">
                              *
                            </span>
                            <span className="sr-only"> (required)</span>
                          </>
                        ) : null}
                      </span>
                      <span className={styles.draftBox} aria-hidden="true" />
                      <span className={`${s.muted} ${s.xs}`}>
                        <Mono>{f.target}</Mono>
                        {f.type ? ` · ${f.type}` : ''} · from <Mono>{f.source}</Mono>
                      </span>
                      {!f.decided ? <Badge tone="warning">Mapping not approved yet</Badge> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {sec.fields?.length === 0 ? (
                <p className={`${s.muted} ${s.small}`}>No fields.</p>
              ) : null}
              {sec.links && sec.links.length > 0 ? (
                <ul className={styles.bullets}>
                  {sec.links.map((l) => (
                    <li key={l.label}>
                      {l.label}
                      {l.entity ? <span className={s.muted}> → {l.entity}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
          <p className={`${s.muted} ${s.xs}`}>
            <span aria-hidden="true">*</span> Required: the target column does not allow nulls.
          </p>
        </div>
      </section>
    </>
  );
}
