import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './client';
import type {
  ConceptBindings,
  ConceptBrowse,
  ConceptConstraints,
  ConceptDetail,
  ConceptFind,
  ConceptPrecedents,
  OntologyScope,
} from './types';

export const ontologyKeys = {
  all: ['ontology'] as const,
  scope: (packs: readonly string[]) => ['ontology', 'scope', [...packs]] as const,
  browse: (packs: readonly string[], ns: string) => ['ontology', 'browse', [...packs], ns] as const,
  find: (q: string, packs: readonly string[]) => ['ontology', 'find', q, [...packs]] as const,
  concept: (id: string, packs: readonly string[]) =>
    ['ontology', 'concept', id, [...packs]] as const,
  constraints: (id: string, packs: readonly string[]) =>
    ['ontology', 'constraints', id, [...packs]] as const,
  bindings: (id: string, packs: readonly string[], adapter: string) =>
    ['ontology', 'bindings', id, [...packs], adapter] as const,
  precedents: (id: string, packs: readonly string[]) =>
    ['ontology', 'precedents', id, [...packs]] as const,
};

/** Repeated `packs=` parameters; empty means "latest published domain packs". */
export function ontologyQuery(
  path: string,
  packs: readonly string[],
  extra: Record<string, string> = {},
) {
  const sp = new URLSearchParams();
  for (const p of packs) sp.append('packs', p);
  for (const [k, v] of Object.entries(extra)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

const enc = encodeURIComponent;

export function useOntologyScope(packs: readonly string[]) {
  return useQuery({
    queryKey: ontologyKeys.scope(packs),
    queryFn: ({ signal }) =>
      api.get<OntologyScope>(ontologyQuery('/ontology/scope', packs), { signal }),
  });
}

export function useConcepts(packs: readonly string[], namespace: string) {
  return useQuery({
    queryKey: ontologyKeys.browse(packs, namespace),
    queryFn: ({ signal }) =>
      api.get<ConceptBrowse>(ontologyQuery('/ontology/concepts', packs, { namespace }), { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useFindConcept(q: string, packs: readonly string[]) {
  return useQuery({
    queryKey: ontologyKeys.find(q, packs),
    queryFn: ({ signal }) =>
      api.get<ConceptFind>(ontologyQuery('/ontology/find', packs, { q, limit: '10' }), { signal }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useConcept(id: string, packs: readonly string[]) {
  return useQuery({
    queryKey: ontologyKeys.concept(id, packs),
    queryFn: ({ signal }) =>
      api.get<ConceptDetail>(ontologyQuery(`/ontology/concepts/${enc(id)}`, packs), { signal }),
  });
}

export function useConceptConstraints(id: string, packs: readonly string[]) {
  return useQuery({
    queryKey: ontologyKeys.constraints(id, packs),
    queryFn: ({ signal }) =>
      api.get<ConceptConstraints>(
        ontologyQuery(`/ontology/concepts/${enc(id)}/constraints`, packs),
        {
          signal,
        },
      ),
  });
}

export function useConceptBindings(id: string, packs: readonly string[], adapter: string) {
  return useQuery({
    queryKey: ontologyKeys.bindings(id, packs, adapter),
    queryFn: ({ signal }) =>
      api.get<ConceptBindings>(
        ontologyQuery(`/ontology/concepts/${enc(id)}/bindings`, packs, { adapter }),
        { signal },
      ),
  });
}

export function useConceptPrecedents(id: string, packs: readonly string[]) {
  return useQuery({
    queryKey: ontologyKeys.precedents(id, packs),
    queryFn: ({ signal }) =>
      api.get<ConceptPrecedents>(ontologyQuery(`/ontology/concepts/${enc(id)}/precedents`, packs), {
        signal,
      }),
  });
}
