export const CONCEPT_TABS = ['overview', 'constraints', 'bindings', 'precedents'] as const;
export type ConceptTab = (typeof CONCEPT_TABS)[number];

/** "a@1.0.0,b@2.0.0" in the URL ↔ a list of pack refs. */
export function parsePacksParam(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').filter(Boolean) : [];
}

/** "a.b" -> "a": the namespace part of a concept id. */
export function namespaceOf(conceptId: string): string {
  const i = conceptId.indexOf('.');
  return i > 0 ? conceptId.slice(0, i) : conceptId;
}
