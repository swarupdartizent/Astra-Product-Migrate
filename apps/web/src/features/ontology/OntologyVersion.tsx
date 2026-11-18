import { Mono } from '@/ui';

/** Every ontology answer names the exact pack versions it came from. */
export function OntologyVersion({ version }: { version: string }) {
  return (
    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
      Ontology version <Mono>{version || 'none'}</Mono>
    </span>
  );
}
