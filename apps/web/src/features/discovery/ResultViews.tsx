import { useMemo, useState, type ReactNode } from 'react';
import { useDiscoveryResult } from '@/api/discovery';
import type {
  BrokenReference,
  ColumnProfile,
  ConfigItem,
  DiscoveredInterface,
  DocumentRow,
  ElementUsage,
  TableProfile,
} from '@/api/discovery-types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Badge,
  Callout,
  Card,
  CardBody,
  CardHeader,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PlainText,
  SegmentedControl,
  Sheet,
  Skeleton,
  StatusPill,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import {
  formatBytes,
  groupDocuments,
  humanize,
  INTERFACE_KIND,
  INTERFACE_SOURCE,
  nullRate,
  percent,
  scopeDifferences,
  scoreTone,
  WEIGHT_MEANING,
} from './model';
import styles from './Discovery.module.css';

const wrap = { whiteSpace: 'normal' } as const;

function Loading({
  q,
  what,
}: {
  q: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  what: string;
}): ReactNode {
  if (q.isPending) return <Skeleton height="12rem" />;
  if (q.isError) {
    return (
      <ApiErrorView
        error={q.error}
        title={`Could not load ${what}`}
        onRetry={() => void q.refetch()}
      />
    );
  }
  return null;
}

function List({ items, label }: { items: readonly string[]; label: string }) {
  if (items.length === 0) return <span className={s.muted}>None</span>;
  return (
    <ul className={styles.plainList} aria-label={label}>
      {items.map((i) => (
        <li key={i}>
          <Mono className={s.xs}>{i}</Mono>
        </li>
      ))}
    </ul>
  );
}

// ---------- Profile ----------

export function ProfileResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'profile');
  const [open, setOpen] = useState<TableProfile | null>(null);
  const columns = useMemo(() => {
    const col = createDataTableColumns<TableProfile>();
    return col.columns([
      col.accessor('table', {
        header: 'Table',
        size: 240,
        cell: (info) => (
          <span className={s.cellStack}>
            <Mono className={s.small}>{info.getValue()}</Mono>
            {info.row.original.error ? (
              <span className={`${s.xs}`} style={{ color: 'var(--color-danger-text)', ...wrap }}>
                {info.row.original.error}
              </span>
            ) : null}
          </span>
        ),
      }),
      col.accessor('score', {
        header: 'Score',
        size: 100,
        cell: (info) =>
          info.row.original.error ? (
            <StatusPill tone="danger">Not profiled</StatusPill>
          ) : (
            <StatusPill tone={scoreTone(info.getValue())}>{info.getValue().toFixed(1)}</StatusPill>
          ),
      }),
      col.accessor('rows', {
        header: 'Rows',
        size: 100,
        meta: { align: 'end' },
        cell: (info) => info.getValue().toLocaleString(),
      }),
      col.accessor((t) => t.components.completeness ?? null, {
        id: 'completeness',
        header: 'Completeness',
        size: 120,
        cell: (info) => percent(info.getValue()),
      }),
      col.accessor((t) => t.components.validity ?? null, {
        id: 'validity',
        header: 'Validity',
        size: 100,
        cell: (info) => percent(info.getValue()),
      }),
      col.accessor((t) => t.components.integrity ?? null, {
        id: 'integrity',
        header: 'Integrity',
        size: 100,
        cell: (info) => percent(info.getValue()),
      }),
      col.accessor((t) => t.broken.reduce((n, b) => n + b.broken_rows, 0), {
        id: 'broken',
        header: 'Broken references',
        size: 140,
        cell: (info) => (info.getValue() > 0 ? info.getValue().toLocaleString() : '—'),
      }),
    ]);
  }, []);
  if (!q.data) return <Loading q={q} what="the data profile" />;
  const p = q.data;
  return (
    <div className={s.stack}>
      <Card aria-labelledby="prof-score">
        <CardHeader
          titleId="prof-score"
          title={`Estate data quality: ${p.estate_score.toFixed(1)} / 100`}
          description="The row-weighted average of each table's score. Tables that could not be profiled are left out and listed with their error."
        />
        <CardBody>
          <KeyValueList
            items={Object.entries(p.weights).map(([k, w]) => ({
              key: k,
              label: `${humanize(k)} (${percent(w, 0)})`,
              value: WEIGHT_MEANING[k] ?? '',
            }))}
          />
        </CardBody>
      </Card>
      <Card flush aria-labelledby="prof-tables">
        <CardHeader
          titleId="prof-tables"
          title={`Tables (${p.tables.length})`}
          description="Select a table for its columns, value shapes and broken references."
        />
        <DataTable
          label="Profiled tables"
          data={p.tables}
          columns={columns}
          getRowId={(t) => t.table}
          onRowClick={setOpen}
          maxHeight="36rem"
          initialSorting={[{ id: 'score', desc: false }]}
          empty={<EmptyState compact title="No tables were profiled" />}
        />
      </Card>
      {open ? <TableSheet table={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function TableSheet({ table, onClose }: { table: TableProfile; onClose: () => void }) {
  const cols = useMemo(() => {
    const col = createDataTableColumns<ColumnProfile>();
    return col.columns([
      col.accessor('column', {
        header: 'Column',
        size: 160,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor('data_type', { header: 'Type', size: 110, meta: { mono: true } }),
      col.accessor('nulls', {
        header: 'Nulls',
        size: 80,
        meta: { align: 'end' },
        cell: (info) => info.getValue().toLocaleString(),
      }),
      col.accessor((c) => nullRate(c), {
        id: 'null_rate',
        header: 'Null rate',
        size: 90,
        cell: (info) => percent(info.getValue()),
      }),
      col.accessor('distinct', {
        header: 'Distinct',
        size: 90,
        meta: { align: 'end' },
        cell: (info) => info.getValue()?.toLocaleString() ?? '—',
      }),
      col.display({
        id: 'patterns',
        header: 'Value shapes',
        size: 220,
        cell: (info) =>
          info.row.original.patterns.length === 0 ? (
            '—'
          ) : (
            <span className={s.cellStack}>
              {info.row.original.patterns.map((pt) => (
                <span key={pt.shape} className={s.xs}>
                  <Mono>{pt.shape}</Mono> {percent(pt.share)}
                </span>
              ))}
            </span>
          ),
      }),
    ]);
  }, []);
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={table.table}
      description={`${table.rows.toLocaleString()} rows · score ${table.error ? 'not profiled' : table.score.toFixed(1)}`}
      size="lg"
    >
      <div className={s.stack}>
        {table.error ? (
          <Callout tone="danger" title="This table could not be profiled">
            {table.error}
          </Callout>
        ) : null}
        <p className={`${s.muted} ${s.small}`}>
          Value shapes replace every digit with 9 and every letter with A (for example 99-9999999),
          so they describe values without holding any.
        </p>
        <DataTable
          label={`Columns of ${table.table}`}
          data={table.columns}
          columns={cols}
          getRowId={(c) => c.column}
          empty={<EmptyState compact title="No columns profiled" />}
        />
        <section aria-label="Broken references">
          <h3 className={styles.sectionTitle}>Broken references</h3>
          {table.broken.length === 0 ? (
            <p className={s.muted}>None found.</p>
          ) : (
            <ul className={styles.plainList}>
              {table.broken.map((b: BrokenReference) => (
                <li key={b.relation} className={s.cellStack}>
                  <span className={s.row}>
                    <Mono className={s.small}>{b.relation}</Mono>
                    <Badge tone={b.enforced ? 'neutral' : 'accent'}>
                      {b.enforced ? 'Enforced' : 'Soft (declared by the adapter)'}
                    </Badge>
                    <strong>{b.broken_rows.toLocaleString()} broken rows</strong>
                  </span>
                  <span className={s.xs}>
                    <Mono>
                      {b.from_table}.{b.from_column}
                    </Mono>{' '}
                    →{' '}
                    <Mono>
                      {b.to_table}.{b.to_column}
                    </Mono>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}

// ---------- Usage ----------

export function UsageResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'usage');
  const [filter, setFilter] = useState('');
  const columns = useMemo(() => {
    const col = createDataTableColumns<ElementUsage>();
    return col.columns([
      col.accessor('element', {
        header: 'Element',
        size: 240,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor('kind', { header: 'Kind', size: 110 }),
      col.accessor('reads', { header: 'Reads', size: 80, meta: { align: 'end' } }),
      col.accessor('writes', { header: 'Writes', size: 80, meta: { align: 'end' } }),
      col.accessor('executions', { header: 'Executions', size: 100, meta: { align: 'end' } }),
      col.accessor('last_used', {
        header: 'Last used',
        size: 130,
        cell: (info) => {
          const v = info.getValue();
          return v ? <Timestamp value={v} /> : '—';
        },
      }),
      col.accessor((u) => u.via.join(', '), {
        id: 'via',
        header: 'Used through',
        size: 220,
        cell: (info) =>
          info.row.original.via.length ? (
            <span className={s.xs} style={wrap}>
              {info.row.original.via.join(', ')}
            </span>
          ) : (
            '—'
          ),
      }),
    ]);
  }, []);
  if (!q.data) return <Loading q={q} what="usage" />;
  const u = q.data;
  const f = filter.trim().toLowerCase();
  const elements = f ? u.elements.filter((e) => e.element.toLowerCase().includes(f)) : u.elements;
  return (
    <div className={s.stack}>
      <Card aria-labelledby="use-window">
        <CardHeader titleId="use-window" title="Usage window" />
        <CardBody className={s.stackSm}>
          {u.note ? (
            <Callout tone="warning" title="Provisional">
              {u.note}
            </Callout>
          ) : null}
          <KeyValueList
            items={[
              {
                key: 'from',
                label: 'From',
                value: u.window_start ? <Timestamp value={u.window_start} /> : null,
              },
              {
                key: 'to',
                label: 'To',
                value: u.window_end ? <Timestamp value={u.window_end} /> : null,
              },
              {
                key: 'days',
                label: 'Days with activity evidence',
                value: u.evidence_days.toLocaleString(),
              },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="use-unused" id="unused">
        <CardHeader
          titleId="use-unused"
          title={`Flagged for retirement review (${u.unused.length})`}
          description="No direct or indirect use was seen in the window. Nothing is retired: a person decides in the review queue whether to retire or migrate them."
        />
        <CardBody>
          {u.unused.length === 0 ? (
            <p className={s.muted}>Every element was used in the window.</p>
          ) : (
            <PlainText label="Elements flagged for retirement review">
              {u.unused.join('\n')}
            </PlainText>
          )}
        </CardBody>
      </Card>
      <Card flush aria-labelledby="use-elements">
        <CardHeader
          titleId="use-elements"
          title={`Elements (${u.elements.length})`}
          description="“Used through” lists the elements that use this one indirectly, for example a procedure that reads a table."
        />
        <div className={s.toolbar}>
          <div style={{ width: 'min(100%, 22rem)' }}>
            <Field label="Filter elements" hideLabel>
              <Input
                type="search"
                placeholder="Filter by name"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <DataTable
          label="Element usage"
          data={elements}
          columns={columns}
          getRowId={(e) => `${e.kind}:${e.element}`}
          maxHeight="36rem"
          empty={<EmptyState compact title="No elements match" />}
        />
      </Card>
    </div>
  );
}

// ---------- Rules ----------

export function RulesResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'rules');
  const [kind, setKind] = useState('all');
  if (!q.data) return <Loading q={q} what="business rules" />;
  const kinds = [...new Set(q.data.map((r) => r.kind))].sort();
  const rules = kind === 'all' ? q.data : q.data.filter((r) => r.kind === kind);
  return (
    <div className={s.stack}>
      <Callout tone="info">
        Rules are read from code (procedures, triggers, functions and automation). Screens are
        linked only when the adapter provides screen metadata.
      </Callout>
      {kinds.length > 1 ? (
        <SegmentedControl
          label="Rule kind"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: 'all', label: `All (${q.data.length})` },
            ...kinds.map((k) => ({
              value: k,
              label: `${humanize(k)} (${q.data.filter((r) => r.kind === k).length})`,
            })),
          ]}
        />
      ) : null}
      {rules.length === 0 ? (
        <EmptyState title="No rules found in code" />
      ) : (
        rules.map((r) => (
          <Card key={r.id} aria-labelledby={`rule-${r.id}`}>
            <CardHeader
              titleId={`rule-${r.id}`}
              title={r.statement}
              description={
                <span className={s.row}>
                  <Badge>{humanize(r.kind)}</Badge>
                  <span>confidence {percent(r.confidence, 0)}</span>
                  <span>
                    in {r.object_type} <Mono>{r.object}</Mono>, lines {r.line_from}–{r.line_to}
                  </span>
                </span>
              }
            />
            <CardBody className={s.stackSm}>
              <PlainText label={`Code excerpt for rule ${r.id}`}>{r.excerpt}</PlainText>
              <div className={s.grid2}>
                <div>
                  <h3 className={styles.sectionTitle}>Fields read</h3>
                  <List items={r.reads} label={`Fields read by rule ${r.id}`} />
                </div>
                <div>
                  <h3 className={styles.sectionTitle}>Fields set</h3>
                  <List items={r.sets} label={`Fields set by rule ${r.id}`} />
                </div>
              </div>
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

// ---------- Interfaces ----------

export function InterfacesResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'interfaces');
  const [open, setOpen] = useState<DiscoveredInterface | null>(null);
  const columns = useMemo(() => {
    const col = createDataTableColumns<DiscoveredInterface>();
    return col.columns([
      col.accessor('name', {
        header: 'Interface',
        size: 220,
        cell: (info) => (
          <span className={s.cellStack}>
            <span className={s.cellPrimary}>{info.getValue()}</span>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.key}</Mono>
          </span>
        ),
      }),
      col.accessor('kind', {
        header: 'Kind',
        size: 130,
        cell: (info) => (
          <Badge>{INTERFACE_KIND[info.getValue()] ?? humanize(info.getValue())}</Badge>
        ),
      }),
      col.accessor('source', {
        header: 'Found in',
        size: 120,
        cell: (info) => INTERFACE_SOURCE[info.getValue()] ?? humanize(info.getValue()),
      }),
      col.accessor('events', { header: 'Events', size: 90, meta: { align: 'end' } }),
      col.accessor('per_day', {
        header: 'Per day',
        size: 90,
        meta: { align: 'end' },
        cell: (info) => info.getValue().toFixed(1),
      }),
      col.accessor('last_seen', {
        header: 'Last seen',
        size: 130,
        cell: (info) => {
          const v = info.getValue();
          return v ? <Timestamp value={v} /> : '—';
        },
      }),
    ]);
  }, []);
  if (!q.data) return <Loading q={q} what="interfaces" />;
  return (
    <Card flush aria-labelledby="ifaces">
      <CardHeader
        titleId="ifaces"
        title={`Interfaces (${q.data.length})`}
        description="Programs, report tools, linked servers and external programs that use the source, found in activity, code or configuration. Select one for its evidence."
      />
      <DataTable
        label="Interfaces"
        data={q.data}
        columns={columns}
        getRowId={(i) => i.key}
        onRowClick={setOpen}
        maxHeight="36rem"
        empty={<EmptyState compact title="No interfaces found" />}
      />
      {open ? (
        <Sheet
          open
          onOpenChange={(v) => {
            if (!v) setOpen(null);
          }}
          title={open.name}
          description={`${INTERFACE_KIND[open.kind] ?? open.kind} · found in ${INTERFACE_SOURCE[open.source] ?? open.source}`}
          size="lg"
        >
          <div className={s.stack}>
            <KeyValueList
              items={[
                { key: 'key', label: 'Key', value: <Mono>{open.key}</Mono> },
                { key: 'program', label: 'Program', value: open.program },
                { key: 'hosts', label: 'Hosts', value: open.hosts.join(', ') || null },
                { key: 'logins', label: 'Logins', value: open.logins.join(', ') || null },
                {
                  key: 'events',
                  label: 'Events',
                  value: `${open.events.toLocaleString()} (${open.per_day.toFixed(1)} per day)`,
                },
                {
                  key: 'first',
                  label: 'First seen',
                  value: open.first_seen ? <Timestamp value={open.first_seen} /> : null,
                },
                {
                  key: 'last',
                  label: 'Last seen',
                  value: open.last_seen ? <Timestamp value={open.last_seen} /> : null,
                },
              ]}
            />
            <div className={s.grid2}>
              <div>
                <h3 className={styles.sectionTitle}>Reads</h3>
                <List items={open.reads} label="Objects read" />
              </div>
              <div>
                <h3 className={styles.sectionTitle}>Writes</h3>
                <List items={open.writes} label="Objects written" />
              </div>
              <div>
                <h3 className={styles.sectionTitle}>Executes</h3>
                <List items={open.executes} label="Objects executed" />
              </div>
            </div>
            <section aria-label="Evidence">
              <h3 className={styles.sectionTitle}>Evidence</h3>
              {open.evidence.length ? (
                <PlainText label="Evidence">{open.evidence.join('\n')}</PlainText>
              ) : (
                <p className={s.muted}>None recorded.</p>
              )}
            </section>
          </div>
        </Sheet>
      ) : null}
    </Card>
  );
}

// ---------- Configuration ----------

export function ConfigurationResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'configuration');
  const [openItem, setOpenItem] = useState<ConfigItem | null>(null);
  const columns = useMemo(() => {
    const col = createDataTableColumns<ConfigItem>();
    return col.columns([
      col.accessor('name', {
        header: 'Item',
        size: 220,
        cell: (info) => <Mono className={s.small}>{info.getValue()}</Mono>,
      }),
      col.accessor('kind', {
        header: 'Kind',
        size: 130,
        cell: (info) => humanize(info.getValue()),
      }),
      col.accessor((c) => c.scope ?? '', {
        id: 'scope',
        header: 'Scope',
        size: 120,
        cell: (info) => info.row.original.scope ?? 'Everywhere',
      }),
      col.accessor((c) => c.depends_on.join(', '), {
        id: 'depends',
        header: 'Depends on',
        size: 200,
        cell: (info) =>
          info.row.original.depends_on.length ? (
            <span className={s.xs} style={wrap}>
              {info.row.original.depends_on.join(', ')}
            </span>
          ) : (
            '—'
          ),
      }),
      col.accessor((c) => c.digest ?? '', {
        id: 'digest',
        header: 'Digest',
        size: 140,
        cell: (info) => (info.getValue() ? <Mono className={s.xs}>{info.getValue()}</Mono> : '—'),
      }),
    ]);
  }, []);
  if (!q.data) return <Loading q={q} what="configuration" />;
  const c = q.data;
  const diffs = scopeDifferences(c);
  return (
    <div className={s.stack}>
      {c.problems.length > 0 ? (
        <Callout tone="warning" title="Configuration was read partly">
          <ul className={styles.plainList}>
            {c.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card aria-labelledby="cfg-diff">
        <CardHeader
          titleId="cfg-diff"
          title="Differences between scopes"
          description={
            c.diff.scopes.length
              ? `Compared across ${String(c.diff.scopes.length)} scopes (${c.diff.scopes.join(', ')}). ${String(c.diff.same_everywhere)} item(s) are the same everywhere.`
              : 'No item is defined per scope, so there is nothing to compare.'
          }
        />
        <CardBody className={s.stack}>
          {c.diff.scopes.length > 0 && diffs.length === 0 ? (
            <p className={s.muted}>Every scoped item is defined the same way in every scope.</p>
          ) : null}
          {diffs.map((d) => (
            <section
              key={`${d.kind}:${d.name}`}
              aria-label={`${humanize(d.kind)} ${d.name}`}
              className={s.stackSm}
            >
              <h3 className={s.row}>
                <Mono>{d.name}</Mono>
                <Badge>{humanize(d.kind)}</Badge>
                {d.cells.some((x) => x.definition === null) ? (
                  <Badge tone="danger">
                    Missing in{' '}
                    {d.cells
                      .filter((x) => x.definition === null)
                      .map((x) => x.scope)
                      .join(', ')}
                  </Badge>
                ) : null}
                {d.variants > 1 ? (
                  <Badge tone="warning">{d.variants} different definitions</Badge>
                ) : null}
              </h3>
              <div className={styles.compare}>
                {d.cells.map((cell) => (
                  <div
                    key={cell.scope}
                    className={styles.compareCell}
                    data-variant={cell.variant ?? undefined}
                    data-missing={cell.definition === null}
                  >
                    <span className={s.row}>
                      <strong>{cell.scope}</strong>
                      {cell.definition === null ? (
                        <StatusPill tone="danger">Missing</StatusPill>
                      ) : d.variants > 1 ? (
                        <StatusPill tone={cell.variant === 1 ? 'success' : 'warning'}>
                          {cell.variant === 1 ? 'Most common' : `Variant ${String(cell.variant)}`}
                        </StatusPill>
                      ) : (
                        <StatusPill tone="success">Same</StatusPill>
                      )}
                    </span>
                    {cell.definition !== null ? (
                      <PlainText label={`${d.name} in ${cell.scope}`}>{cell.definition}</PlainText>
                    ) : (
                      <span className={`${s.muted} ${s.small}`}>Not defined in this scope.</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </CardBody>
      </Card>
      <Card flush aria-labelledby="cfg-items">
        <CardHeader
          titleId="cfg-items"
          title={`Configuration items (${c.items.length})`}
          description="Select an item for its definition."
        />
        <DataTable
          label="Configuration items"
          data={c.items}
          columns={columns}
          getRowId={(i) => `${i.kind}:${i.key}:${i.scope ?? ''}`}
          onRowClick={setOpenItem}
          maxHeight="32rem"
          empty={<EmptyState compact title="No configuration items" />}
        />
      </Card>
      {openItem ? (
        <Sheet
          open
          onOpenChange={(v) => {
            if (!v) setOpenItem(null);
          }}
          title={openItem.name}
          description={`${humanize(openItem.kind)}${openItem.scope ? ` · ${openItem.scope}` : ''}`}
          size="lg"
        >
          <PlainText label={`Definition of ${openItem.name}`}>{openItem.definition}</PlainText>
        </Sheet>
      ) : null}
    </div>
  );
}

// ---------- Documents ----------

export function DocumentsResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'documents');
  if (q.isPending || q.isError) return <Loading q={q} what="document sizing" />;
  const d = q.data;
  if (!d) {
    return <EmptyState title="No document store" body="The adapter declares no document store." />;
  }
  const groups = groupDocuments(d.rows);
  return (
    <Card aria-labelledby="docs">
      <CardHeader
        titleId="docs"
        title={`Documents: ${d.total_count.toLocaleString()} (${formatBytes(d.total_bytes)})`}
        description="Embedded documents by type and age, with the entity each is linked to."
      />
      <CardBody>
        {groups.length === 0 ? (
          <p className={s.muted}>The document store is empty.</p>
        ) : (
          <table className={styles.docTable} aria-label="Document sizing by type and age">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Age</th>
                <th scope="col">Linked to</th>
                <th scope="col" className={styles.num}>
                  Documents
                </th>
                <th scope="col" className={styles.num}>
                  Size
                </th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.type}>
                <tr className={styles.groupRow}>
                  <th scope="rowgroup" colSpan={3}>
                    <Mono>{g.type}</Mono>
                  </th>
                  <td className={styles.num}>{g.count.toLocaleString()}</td>
                  <td className={styles.num}>{formatBytes(g.bytes)}</td>
                </tr>
                {g.ages.flatMap((a) =>
                  a.entities.map((e: DocumentRow, i) => (
                    <tr key={`${a.age}:${e.link_entity}`}>
                      <td />
                      <td>{i === 0 ? a.age : ''}</td>
                      <td>{e.link_entity}</td>
                      <td className={styles.num}>{e.count.toLocaleString()}</td>
                      <td className={styles.num} title={`${e.bytes.toLocaleString()} bytes`}>
                        {formatBytes(e.bytes)}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            ))}
          </table>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- Dictionary ----------

export function DictionaryResult({ runId }: { runId: string }) {
  const q = useDiscoveryResult(runId, 'dictionary');
  if (!q.data) return <Loading q={q} what="the data dictionary" />;
  const d = q.data;
  return (
    <div className={s.stack}>
      {d.problems.length > 0 ? (
        <Callout tone="warning" title="Problems reading the dictionary">
          <ul className={styles.plainList}>
            {d.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Card aria-labelledby="dict-sum">
        <CardHeader titleId="dict-sum" title="Data dictionary" />
        <CardBody>
          <KeyValueList
            items={[
              { key: 'cols', label: 'Columns', value: d.columns.toLocaleString() },
              { key: 'rel', label: 'Relations', value: d.relations.length.toLocaleString() },
              { key: 'cl', label: 'Code lists', value: d.code_lists.length.toLocaleString() },
            ]}
          />
        </CardBody>
      </Card>
      <Card aria-labelledby="dict-rel">
        <CardHeader
          titleId="dict-rel"
          title={`Relations (${d.relations.length})`}
          description="Enforced relations are foreign keys in the database; soft relations are declared by the adapter."
        />
        <CardBody>
          {d.relations.length === 0 ? (
            <p className={s.muted}>None.</p>
          ) : (
            <ul className={styles.plainList}>
              {d.relations.map((r) => (
                <li key={r.name} className={s.row}>
                  <Mono className={s.xs}>
                    {r.from_table}.{r.from_column}
                  </Mono>
                  →
                  <Mono className={s.xs}>
                    {r.to_table}.{r.to_column}
                  </Mono>
                  <Badge tone={r.enforced ? 'neutral' : 'accent'}>
                    {r.enforced ? 'Enforced' : 'Soft'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card aria-labelledby="dict-cl">
        <CardHeader titleId="dict-cl" title={`Code lists (${d.code_lists.length})`} />
        <CardBody className={s.stackSm}>
          {d.code_lists.length === 0 ? (
            <p className={s.muted}>None.</p>
          ) : (
            d.code_lists.map((cl) => (
              <details key={cl.name}>
                <summary>
                  <Mono>{cl.name}</Mono> in <Mono>{cl.table}</Mono>, {cl.values.length} values
                </summary>
                <PlainText label={`Values of ${cl.name}`}>
                  {cl.values.map((v) => Object.values(v).join('  ')).join('\n')}
                </PlainText>
              </details>
            ))
          )}
        </CardBody>
      </Card>
      <p className={`${s.muted} ${s.small}`}>
        Browse tables and columns in the knowledge graph tab.
      </p>
    </div>
  );
}
