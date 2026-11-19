import { useState } from 'react';
import type { Project } from '@/api/types';
import { Tab, TabPanel, Tabs, TabsList } from '@/ui';
import { GatesView } from './GatesView';
import { GATES_SECTION_LABELS, GATES_SECTIONS, type GatesSearch, type GatesSection } from './model';
import { ProofPacksView } from './ProofPacksView';
import { SigningKeyView } from './SigningKeyView';

export interface GatesTabProps {
  project: Project;
  /** The view from the URL. Without it the tab keeps its own state (tests, embedding). */
  search?: GatesSearch;
  /** Called with the whole next view; `replace` for section changes, push for selections. */
  onSearch?: (next: GatesSearch, replace: boolean) => void;
}

function clean(s: GatesSearch): GatesSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Gates and proof (E17): the lifecycle gates with their checklists and approvals, signed proof
 * packs, and the public signing key. Section and selected gate live in the URL.
 */
export function GatesTab({ project, search, onSearch }: GatesTabProps) {
  const [local, setLocal] = useState<GatesSearch>({});
  const view = search ?? local;
  const section: GatesSection = view.section ?? 'gates';
  const update = (patch: Partial<GatesSearch>, replace: boolean) => {
    const next = clean({ ...view, ...patch });
    if (onSearch) onSearch(next, replace);
    else setLocal(next);
  };
  return (
    <Tabs value={section} onValueChange={(v) => update({ section: v as GatesSection }, true)}>
      <TabsList aria-label="Gates and proof sections">
        {GATES_SECTIONS.map((sec) => (
          <Tab key={sec} value={sec}>
            {GATES_SECTION_LABELS[sec]}
          </Tab>
        ))}
      </TabsList>
      <TabPanel value="gates">
        {section === 'gates' ? (
          <GatesView
            project={project}
            selected={view.gate ?? null}
            onSelect={(key) => update({ gate: key ?? undefined }, key === null)}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="packs">
        {section === 'packs' ? <ProofPacksView project={project} /> : null}
      </TabPanel>
      <TabPanel value="signing-key">
        {section === 'signing-key' ? <SigningKeyView /> : null}
      </TabPanel>
    </Tabs>
  );
}
