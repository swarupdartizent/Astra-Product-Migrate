import { Link, useNavigate } from '@tanstack/react-router';
import { Network, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useConcepts, useFindConcept, useOntologyScope } from '@/api/ontology';
import { usePublishedPacks } from '@/api/packs';
import type { ConceptSummary } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CheckboxGroup,
  createDataTableColumns,
  DataTable,
  EmptyState,
  Field,
  Input,
  Mono,
  PageHeader,
  Select,
  Skeleton,
} from '@/ui';
import s from '../shared.module.css';
import { packRef } from '../packs/model';
import { OntologyVersion } from './OntologyVersion';
import { namespaceOf } from './tabs';

export function OntologyPage({ packs }: { packs: string[] }) {
  useDocumentTitle('Ontology');
  const navigate = useNavigate();
  const published = usePublishedPacks();
  const scope = useOntologyScope(packs);
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 300);
  const [ns, setNs] = useState('');
  const browse = useConcepts(packs, ns);
  const find = useFindConcept(dq, packs);
  const domain = (published.data ?? []).filter((p) => p.type === 'domain');
  const namespaces = useMemo(
    () => [...new Set((browse.data?.concepts ?? []).map((c) => namespaceOf(c.id)))].sort(),
    [browse.data],
  );
  const setPacks = (next: string[]) =>
    void navigate({
      to: '/ontology',
      search: next.length ? { packs: next.join(',') } : {},
      replace: true,
    });

  const columns = useMemo(() => {
    const col = createDataTableColumns<ConceptSummary>();
    return col.columns([
      col.accessor('label', {
        header: 'Concept',
        size: 260,
        cell: (info) => (
          <span className={s.cellStack}>
            <Link
              to="/ontology/$conceptId"
              params={{ conceptId: info.row.original.id }}
              search={packs.length ? { packs: packs.join(',') } : {}}
              className={s.cellLink}
              onClick={(e) => e.stopPropagation()}
            >
              {info.getValue()}
            </Link>
            <Mono className={`${s.muted} ${s.xs}`}>{info.row.original.id}</Mono>
          </span>
        ),
      }),
      col.accessor((c) => c.parent ?? '', {
        id: 'parent',
        header: 'Parent',
        size: 180,
        cell: (info) =>
          info.row.original.parent ? <Mono className={s.xs}>{info.row.original.parent}</Mono> : '—',
      }),
      col.accessor('definition', {
        header: 'Definition',
        size: 420,
        cell: (info) => (
          <span className={s.small} style={{ whiteSpace: 'normal' }}>
            {info.getValue()}
          </span>
        ),
      }),
      col.accessor('pack', { header: 'Pack', size: 160, meta: { mono: true } }),
    ]);
  }, [packs]);

  return (
    <>
      <PageHeader
        title="Ontology"
        description="The shared business concepts domain packs define: what each concept means, its attributes and relations, the rules that apply to it, and how adapters bind to it."
        meta={scope.data ? <OntologyVersion version={scope.data.ontology_version} /> : null}
      />
      <div className={s.stack}>
        <Card aria-labelledby="onto-scope">
          <CardHeader
            titleId="onto-scope"
            title="Answer from"
            description={
              scope.data
                ? scope.data.packs.map((p) => `${p.ref} (${p.concepts} concepts)`).join(', ') ||
                  'No domain packs'
                : undefined
            }
          />
          <CardBody>
            {scope.isError ? (
              <ApiErrorView error={scope.error} title="Could not resolve the packs" compact />
            ) : null}
            <CheckboxGroup
              legend="Domain pack versions"
              help="Leave empty to use the latest published version of every domain pack."
              options={domain.map((p) => ({
                value: packRef(p),
                label: p.title,
                description: packRef(p),
              }))}
              value={packs}
              onValueChange={setPacks}
              maxHeight="10rem"
              emptyText={published.isPending ? 'Loading…' : 'No published domain packs.'}
            />
          </CardBody>
        </Card>

        <Card flush aria-labelledby="onto-find">
          <CardHeader
            titleId="onto-find"
            title="Find a concept"
            description="Search by meaning, not just spelling."
          />
          <div className={s.toolbar}>
            <div style={{ width: 'min(100%, 28rem)' }}>
              <Field label="Word or phrase" hideLabel>
                <Input
                  type="search"
                  placeholder="For example: insured party"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  startAdornment={<Search />}
                />
              </Field>
            </div>
            {find.data ? <OntologyVersion version={find.data.ontology_version} /> : null}
          </div>
          <CardBody>
            {!dq ? (
              <p className={s.muted} style={{ padding: 'var(--space-3) var(--space-5)' }}>
                Type to search.
              </p>
            ) : find.isError ? (
              <ApiErrorView error={find.error} title="Search failed" compact />
            ) : find.isPending ? (
              <Skeleton height="4rem" />
            ) : find.data.results.length === 0 ? (
              <EmptyState compact title="No concepts found" />
            ) : (
              <ul
                style={{ listStyle: 'none', padding: 'var(--space-3) var(--space-5)' }}
                className={s.stackSm}
                aria-label="Search results"
              >
                {find.data.results.map((r) => (
                  <li key={r.id} className={s.cellStack}>
                    <span className={s.row}>
                      <Link
                        to="/ontology/$conceptId"
                        params={{ conceptId: r.id }}
                        search={packs.length ? { packs: packs.join(',') } : {}}
                      >
                        {r.label}
                      </Link>
                      <Mono className={s.xs}>{r.id}</Mono>
                      <Badge tone={r.match === 'exact' ? 'success' : 'neutral'}>
                        {r.match === 'exact' ? 'Exact' : 'Similar'}
                      </Badge>
                      <span className={`${s.muted} ${s.xs}`}>score {r.score.toFixed(2)}</span>
                    </span>
                    <span className={`${s.muted} ${s.small}`}>{r.definition}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card flush aria-labelledby="onto-browse">
          <CardHeader
            titleId="onto-browse"
            title="Browse"
            actions={
              <div style={{ width: '14rem' }}>
                <Field label="Namespace" hideLabel>
                  <Select
                    size="sm"
                    options={[
                      { value: '__all__', label: 'All namespaces' },
                      ...namespaces.map((n) => ({ value: n, label: n })),
                    ]}
                    value={ns || '__all__'}
                    onValueChange={(v) => setNs(v === '__all__' ? '' : v)}
                  />
                </Field>
              </div>
            }
          />
          <CardBody>
            {browse.isError ? (
              <ApiErrorView
                error={browse.error}
                title="Could not load concepts"
                compact
                onRetry={() => void browse.refetch()}
              />
            ) : (
              <DataTable
                label="Concepts"
                data={browse.data?.concepts}
                columns={columns}
                getRowId={(c) => c.id}
                loading={browse.isPending}
                maxHeight="36rem"
                onRowClick={(c) =>
                  void navigate({
                    to: '/ontology/$conceptId',
                    params: { conceptId: c.id },
                    search: packs.length ? { packs: packs.join(',') } : {},
                  })
                }
                empty={
                  <EmptyState
                    compact
                    icon={<Network />}
                    title="No concepts"
                    body="Publish a domain pack with an ontology."
                  />
                }
              />
            )}
          </CardBody>
          {browse.data ? (
            <p className={s.footerNote}>
              <OntologyVersion version={browse.data.ontology_version} />
            </p>
          ) : null}
        </Card>
      </div>
    </>
  );
}
