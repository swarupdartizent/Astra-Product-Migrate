import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useConcept,
  useConceptBindings,
  useConceptConstraints,
  useConceptPrecedents,
} from '@/api/ontology';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KeyValueList,
  Mono,
  PageHeader,
  Skeleton,
  StatusPill,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import { CONCEPT_TABS, type ConceptTab } from './tabs';
import { OntologyVersion } from './OntologyVersion';

export interface ConceptPageProps {
  conceptId: string;
  packs: string[];
  tab: ConceptTab;
}

export function ConceptPage({ conceptId, packs, tab }: ConceptPageProps) {
  const concept = useConcept(conceptId, packs);
  const navigate = useNavigate();
  useDocumentTitle(concept.data ? concept.data.concept.label : conceptId);
  const search = packs.length ? { packs: packs.join(',') } : {};
  const breadcrumbs = [{ label: 'Ontology', to: '/ontology' as const }, { label: conceptId }];
  const link = (id: string) => (
    <Link key={id} to="/ontology/$conceptId" params={{ conceptId: id }} search={search}>
      <Mono className={s.small}>{id}</Mono>
    </Link>
  );

  if (concept.isPending) {
    return (
      <div aria-busy="true">
        <PageHeader breadcrumbs={breadcrumbs} title={<Skeleton width="16rem" height="1.75rem" />} />
        <Skeleton height="16rem" />
      </div>
    );
  }
  if (concept.isError) {
    return (
      <>
        <PageHeader breadcrumbs={breadcrumbs} title={conceptId} />
        <ApiErrorView
          error={concept.error}
          title="Could not load this concept"
          onRetry={() => void concept.refetch()}
        />
      </>
    );
  }
  const d = concept.data;
  const c = d.concept;
  return (
    <>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={c.label}
        meta={<OntologyVersion version={d.ontology_version} />}
        description={
          <>
            <Mono>{c.id}</Mono> · from <Mono>{c.pack}</Mono>
          </>
        }
      />
      <Tabs
        value={CONCEPT_TABS.includes(tab) ? tab : 'overview'}
        onValueChange={(v) =>
          void navigate({
            to: '/ontology/$conceptId',
            params: { conceptId },
            search: { ...search, tab: v as ConceptTab },
            replace: true,
          })
        }
      >
        <TabsList aria-label="Concept sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="constraints">Constraints</Tab>
          <Tab value="bindings">Bindings</Tab>
          <Tab value="precedents">Precedents</Tab>
        </TabsList>
        <TabPanel value="overview">
          <div className={s.stack}>
            <Card aria-labelledby="c-def">
              <CardHeader titleId="c-def" title="Definition" />
              <CardBody>
                <KeyValueList
                  items={[
                    { key: 'def', label: 'Definition', value: c.definition },
                    { key: 'syn', label: 'Synonyms', value: c.synonyms.join(', ') || null },
                    {
                      key: 'anc',
                      label: 'Ancestors',
                      value: d.ancestors.length ? (
                        <span className={s.badges}>{d.ancestors.map(link)}</span>
                      ) : (
                        'None (top level)'
                      ),
                    },
                    {
                      key: 'kids',
                      label: 'Children',
                      value: d.children.length ? (
                        <span className={s.badges}>{d.children.map(link)}</span>
                      ) : null,
                    },
                    { key: 'std', label: 'Standards', value: c.standards.join(', ') || null },
                  ]}
                />
              </CardBody>
            </Card>
            <Card aria-labelledby="c-attrs">
              <CardHeader titleId="c-attrs" title={`Attributes (${c.attributes.length})`} />
              <CardBody>
                {c.attributes.length === 0 ? (
                  <p className={s.muted}>No attributes.</p>
                ) : (
                  <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                    {c.attributes.map((a) => {
                      const list = d.code_lists.find((l) => l.list_id === a.code_list);
                      return (
                        <li key={a.name} className={s.cellStack}>
                          <span className={s.row}>
                            <Mono>{a.name}</Mono>
                            <Badge>{a.type}</Badge>
                            {a.code_list ? <Badge tone="accent">codes: {a.code_list}</Badge> : null}
                          </span>
                          <span className={`${s.muted} ${s.small}`}>{a.description}</span>
                          {list ? (
                            <details>
                              <summary className={s.small}>
                                {list.title} ({list.standard}), {list.code_values.length} values
                              </summary>
                              <ul style={{ paddingLeft: 'var(--space-5)' }} className={s.small}>
                                {list.code_values.map((v) => (
                                  <li key={v.code}>
                                    <Mono>{v.code}</Mono> {v.label}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardBody>
            </Card>
            <div className={s.grid2}>
              <Card aria-labelledby="c-rel">
                <CardHeader titleId="c-rel" title="Relations" />
                <CardBody>
                  {d.relations.length === 0 ? (
                    <p className={s.muted}>None.</p>
                  ) : (
                    <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                      {d.relations.map((r) => (
                        <li key={r.name} className={s.cellStack}>
                          <span className={s.row}>
                            <Mono>{r.name}</Mono> <Badge>{r.type.replace(/_/g, ' ')}</Badge>{' '}
                            {link(r.target)}{' '}
                            <span className={`${s.muted} ${s.xs}`}>{r.cardinality}</span>
                          </span>
                          {r.description ? (
                            <span className={`${s.muted} ${s.small}`}>{r.description}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
              <Card aria-labelledby="c-refby">
                <CardHeader titleId="c-refby" title="Referenced by" />
                <CardBody>
                  {d.referenced_by.length === 0 ? (
                    <p className={s.muted}>No other concept refers to this one.</p>
                  ) : (
                    <ul style={{ listStyle: 'none' }} className={s.stackSm}>
                      {d.referenced_by.map((r) => (
                        <li key={`${r.source}.${r.name}`} className={s.row}>
                          {link(r.source)} <Mono className={s.xs}>{r.name}</Mono>{' '}
                          <Badge>{r.type.replace(/_/g, ' ')}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </TabPanel>
        <TabPanel value="constraints">
          <ConstraintsTab conceptId={conceptId} packs={packs} />
        </TabPanel>
        <TabPanel value="bindings">
          <BindingsTab conceptId={conceptId} packs={packs} />
        </TabPanel>
        <TabPanel value="precedents">
          <PrecedentsTab conceptId={conceptId} packs={packs} />
        </TabPanel>
      </Tabs>
    </>
  );
}

function ConstraintsTab({ conceptId, packs }: { conceptId: string; packs: string[] }) {
  const q = useConceptConstraints(conceptId, packs);
  if (q.isPending) return <Skeleton height="8rem" />;
  if (q.isError)
    return (
      <ApiErrorView
        error={q.error}
        title="Could not load constraints"
        onRetry={() => void q.refetch()}
      />
    );
  const d = q.data;
  return (
    <Card aria-labelledby="c-cons">
      <CardHeader
        titleId="c-cons"
        title={`Rules and constraints (${d.constraints.length})`}
        description={
          d.inherited_from.length
            ? `Includes rules inherited from ${d.inherited_from.join(', ')}.`
            : undefined
        }
        actions={<OntologyVersion version={d.ontology_version} />}
      />
      <CardBody>
        {d.constraints.length === 0 ? (
          <EmptyState compact title="No rules apply" />
        ) : (
          <ul style={{ listStyle: 'none' }} className={s.stack}>
            {d.constraints.map((r) => (
              <li key={`${r.kind}:${r.id}`} className={s.cellStack}>
                <span className={s.row}>
                  <Mono>{r.id}</Mono>
                  <Badge tone={r.kind === 'target_constraint' ? 'accent' : 'neutral'}>
                    {r.kind === 'target_constraint' ? 'Target constraint' : 'Domain rule'}
                  </Badge>
                  <StatusPill tone={r.severity === 'blocking' ? 'danger' : 'warning'}>
                    {r.severity}
                  </StatusPill>
                  {r.executable ? (
                    <Badge tone="success">Executable</Badge>
                  ) : (
                    <Badge>Guidance only</Badge>
                  )}
                  <span className={`${s.muted} ${s.xs}`}>{r.pack}</span>
                </span>
                <span>{r.statement}</span>
                <span className={`${s.muted} ${s.xs}`}>
                  {r.sources.join('; ')}
                  {r.recorded_on ? ` · recorded ${r.recorded_on}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function BindingsTab({ conceptId, packs }: { conceptId: string; packs: string[] }) {
  const [adapter, setAdapter] = useState('');
  const q = useConceptBindings(conceptId, packs, adapter.trim());
  return (
    <Card aria-labelledby="c-bind">
      <CardHeader
        titleId="c-bind"
        title="Adapter bindings"
        description="Which source tables carry this concept, by adapter."
        actions={
          <div style={{ width: '14rem' }}>
            <Field label="Adapter" hideLabel>
              <Input
                size="sm"
                mono
                placeholder="Filter by adapter"
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
              />
            </Field>
          </div>
        }
      />
      <CardBody>
        {q.isPending ? (
          <Skeleton height="6rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load bindings"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : q.data.bindings.length === 0 ? (
          <EmptyState compact title="No adapter binds this concept" />
        ) : (
          <ul style={{ listStyle: 'none' }} className={s.stack}>
            {q.data.bindings.map((b) => (
              <li key={`${b.adapter_ref}:${b.entity}`} className={s.cellStack}>
                <span className={s.row}>
                  <Mono>{b.adapter_ref}</Mono> <strong>{b.entity}</strong>{' '}
                  <Mono className={s.small}>{b.table_name}</Mono>
                  {!b.validated ? <Badge tone="warning">Unvalidated</Badge> : null}
                </span>
                {b.attributes && Object.keys(b.attributes).length ? (
                  <span className={`${s.muted} ${s.small}`}>
                    {Object.entries(b.attributes)
                      .map(([a, col]) => `${a} ← ${col}`)
                      .join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {q.data ? (
          <p style={{ marginTop: 'var(--space-3)' }}>
            <OntologyVersion version={q.data.ontology_version} />
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function PrecedentsTab({ conceptId, packs }: { conceptId: string; packs: string[] }) {
  const q = useConceptPrecedents(conceptId, packs);
  return (
    <Card aria-labelledby="c-prec">
      <CardHeader
        titleId="c-prec"
        title="Precedents"
        description="Mapping decisions people recorded for this concept."
        actions={q.data ? <OntologyVersion version={q.data.ontology_version} /> : null}
      />
      <CardBody>
        {q.isPending ? (
          <Skeleton height="6rem" />
        ) : q.isError ? (
          <ApiErrorView
            error={q.error}
            title="Could not load precedents"
            compact
            onRetry={() => void q.refetch()}
          />
        ) : q.data.precedents.length === 0 ? (
          <EmptyState compact title="No precedents" body={q.data.note ?? undefined} />
        ) : (
          <ul style={{ listStyle: 'none' }} className={s.stack}>
            {q.data.precedents.map((p, i) => (
              <li key={i} className={s.cellStack}>
                <span className={s.row}>
                  <Mono className={s.small}>{p.legacy_element}</Mono> →{' '}
                  <Mono className={s.small}>{p.target_element}</Mono>
                  <Badge>{p.decision}</Badge>
                </span>
                <span className={s.small}>{p.rationale}</span>
                <span className={`${s.muted} ${s.xs}`}>
                  {p.adapter_ref} · {p.decided_by_name ?? 'unknown'} ·{' '}
                  <Timestamp value={p.recorded_at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
