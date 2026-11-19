import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useLoadRuns } from '@/api/loads';
import type { Project } from '@/api/types';
import { Tab, TabPanel, Tabs, TabsList } from '@/ui';
import { BreaksView } from './BreaksView';
import { CoexistenceView } from './CoexistenceView';
import { DocumentsView } from './DocumentsView';
import { ErrorQueueView } from './ErrorQueueView';
import { LOADS_SECTION_LABELS, LOADS_SECTIONS, type LoadsSearch, type LoadsSection } from './model';
import { ParityView } from './ParityView';
import { RunsView } from './RunsView';

export interface LoadsTabProps {
  project: Project;
  /** The view from the URL. Without it the tab keeps its own state (tests, embedding). */
  search?: LoadsSearch;
  /** Called with the whole next view; `replace` for section changes, push for selections. */
  onSearch?: (next: LoadsSearch, replace: boolean) => void;
}

function clean(s: LoadsSearch): LoadsSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''));
}

/** Opens a section of the Loads tab (optionally for a run). */
export type GoTo = (section: LoadsSection, run?: string | null) => void;

/**
 * Loads and validation (E13, E14, E15.F1.S2): numbered load runs with their reconciliation and
 * data quality, the error queue, document checks, reconciliation breaks, parity comparisons and
 * the coexistence reconciliation. Section, load run and parity run live in the URL so a link
 * opens the same view.
 */
export function LoadsTab({ project, search, onSearch }: LoadsTabProps) {
  const [local, setLocal] = useState<LoadsSearch>({});
  const view = search ?? local;
  const section: LoadsSection = view.section ?? 'runs';
  const update = (patch: Partial<LoadsSearch>, replace: boolean) => {
    const next = clean({ ...view, ...patch });
    if (onSearch) onSearch(next, replace);
    else setLocal(next);
  };
  const runs = useLoadRuns(project.id);
  const runList = runs.data ?? [];
  // Per-run sections default to the newest run without writing it to the URL.
  const runId = view.run ?? runList[0]?.id ?? null;
  const goTo: GoTo = (s, run) =>
    update({ section: s, run: run === undefined ? view.run : (run ?? undefined) }, false);
  const link = (s: LoadsSection, run: string | null, children: ReactNode) => (
    <LoadsLink
      project={project}
      search={{ section: s, ...(run ? { run } : {}) }}
      onGo={() => goTo(s, run)}
    >
      {children}
    </LoadsLink>
  );

  return (
    <Tabs value={section} onValueChange={(v) => update({ section: v as LoadsSection }, true)}>
      <TabsList aria-label="Loads and validation sections">
        {LOADS_SECTIONS.map((sec) => (
          <Tab key={sec} value={sec}>
            {LOADS_SECTION_LABELS[sec]}
          </Tab>
        ))}
      </TabsList>
      <TabPanel value="runs">
        {section === 'runs' ? (
          <RunsView
            project={project}
            runs={runs}
            selected={view.run ?? null}
            onSelect={(id) => update({ run: id ?? undefined }, id === null)}
            link={link}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="errors">
        {section === 'errors' ? (
          <ErrorQueueView
            key={runId ?? ''}
            project={project}
            runs={runList}
            runsPending={runs.isPending}
            runId={runId}
            onRun={(id) => update({ run: id }, false)}
            onReloaded={(id) => goTo('runs', id)}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="documents">
        {section === 'documents' ? (
          <DocumentsView
            key={runId ?? ''}
            project={project}
            runs={runList}
            runsPending={runs.isPending}
            runId={runId}
            onRun={(id) => update({ run: id }, false)}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="breaks">
        {section === 'breaks' ? (
          <BreaksView
            project={project}
            runs={runList}
            runId={view.run ?? null}
            onRun={(id) => update({ run: id ?? undefined }, true)}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="parity">
        {section === 'parity' ? (
          <ParityView
            project={project}
            selected={view.parity_run ?? null}
            onSelect={(id) => update({ parity_run: id ?? undefined }, id === null)}
          />
        ) : null}
      </TabPanel>
      <TabPanel value="coexistence">
        {section === 'coexistence' ? <CoexistenceView project={project} /> : null}
      </TabPanel>
    </Tabs>
  );
}

/** A shareable link to a Loads section that switches in place inside the project page. */
export function LoadsLink({
  project,
  search,
  onGo,
  children,
}: {
  project: Project;
  search: LoadsSearch;
  onGo: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      search={{ tab: 'loads', ...search }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onGo();
      }}
    >
      {children}
    </Link>
  );
}
