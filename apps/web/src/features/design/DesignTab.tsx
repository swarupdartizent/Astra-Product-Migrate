import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useDesignOverview } from '@/api/design';
import { DESIGN_STREAMS } from '@/api/design-types';
import type { Project } from '@/api/types';
import { Tab, TabPanel, Tabs, TabsList } from '@/ui';
import { BuildView } from './BuildView';
import { DesignOverviewView } from './DesignOverview';
import { DESIGN_SECTIONS, SECTION_LABELS, type DesignSearch, type DesignSection } from './model';
import { StreamView } from './StreamView';

export interface DesignTabProps {
  project: Project;
  /** The view from the URL. Without it the tab keeps its own state (tests, embedding). */
  search?: DesignSearch;
  /** Called with the whole next view; `replace` for section changes, push for selections. */
  onSearch?: (next: DesignSearch, replace: boolean) => void;
}

function clean(s: DesignSearch): DesignSearch {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Design and build (E12): the overview of the latest design run and the target's design section,
 * one register view per stream, and build artifacts. Section, selected item and artifact live in
 * the URL so a link (for example a review item's evidence) opens the same view.
 */
export function DesignTab({ project, search, onSearch }: DesignTabProps) {
  const [local, setLocal] = useState<DesignSearch>({});
  const view = search ?? local;
  const section: DesignSection = view.section ?? 'overview';
  const update = (patch: Partial<DesignSearch>, replace: boolean) => {
    const next = clean({ ...view, ...patch });
    if (onSearch) onSearch(next, replace);
    else setLocal(next);
  };
  const goSection = (s: DesignSection) =>
    update({ section: s, key: undefined, artifact: undefined }, true);
  const overview = useDesignOverview(project.id);
  const counts = overview.data?.counts ?? {};

  return (
    <Tabs value={section} onValueChange={(v) => goSection(v as DesignSection)}>
      <TabsList aria-label="Design sections">
        {DESIGN_SECTIONS.map((sec) => {
          const c = (DESIGN_STREAMS as readonly string[]).includes(sec)
            ? counts[sec as (typeof DESIGN_STREAMS)[number]]
            : undefined;
          const open = c ? (c.proposed ?? 0) + (c.in_review ?? 0) : 0;
          return (
            <Tab
              key={sec}
              value={sec}
              {...(open > 0
                ? {
                    badge: (
                      <>
                        {open.toLocaleString()}
                        <span className="sr-only"> awaiting a decision</span>
                      </>
                    ),
                  }
                : {})}
            >
              {SECTION_LABELS[sec]}
            </Tab>
          );
        })}
      </TabsList>
      <TabPanel value="overview">
        <DesignOverviewView
          project={project}
          sectionLink={(s, children) => (
            <SectionLink project={project} section={s} onSection={goSection}>
              {children}
            </SectionLink>
          )}
        />
      </TabPanel>
      {DESIGN_STREAMS.map((stream) => (
        <TabPanel key={stream} value={stream}>
          {section === stream ? (
            <StreamView
              key={stream}
              project={project}
              stream={stream}
              selected={view.key ?? null}
              onSelect={(key) => update({ key: key ?? undefined }, key === null)}
            />
          ) : null}
        </TabPanel>
      ))}
      <TabPanel value="build">
        {section === 'build' ? (
          <BuildView
            project={project}
            selected={view.artifact ?? null}
            onSelect={(id) => update({ artifact: id ?? undefined }, id === null)}
          />
        ) : null}
      </TabPanel>
    </Tabs>
  );
}

/** A shareable link to a design section that switches in place inside the project page. */
export function SectionLink({
  project,
  section,
  onSection,
  children,
}: {
  project: Project;
  section: DesignSection;
  onSection: (s: DesignSection) => void;
  children: ReactNode;
}) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      search={{ tab: 'design', section }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onSection(section);
      }}
    >
      {children}
    </Link>
  );
}
