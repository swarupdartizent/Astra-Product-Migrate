import { isDesignSection, type DesignSection } from '../design/model';
import { isGatesSection, type GatesSection } from '../gates/model';
import { isLoadsSection, type LoadsSection } from '../loads/model';
import { PLAN_SECTIONS, type PlanSection } from '../plan/model';
import { parseReviewSearch, type ReviewSearch } from '../review/model';

export const PROJECT_TABS = [
  'editor',
  'versions',
  'compare',
  'decisions',
  'agents',
  'reviews',
  'baseline',
  'discovery',
  'delta',
  'conversion',
  'checklist',
  'plan',
  'design',
  'loads',
  'gates',
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

/**
 * The project page's URL state. Besides the tab: the blueprint version, the plan or design
 * section, the review workbench's view (selected item and filters), the run, object or agent run
 * that an evidence link opens on the conversion, delta or agents tab, the design item or build
 * artifact selected on the design tab, the load or parity run selected on the loads tab, and the
 * gate selected on the gates and proof tab.
 */
export interface ProjectSearch extends ReviewSearch {
  tab?: ProjectTab;
  version?: number;
  section?: PlanSection | DesignSection | LoadsSection | GatesSection;
  /** Design tab: the selected register item's key (within `section`). */
  key?: string;
  run?: string;
  object?: string;
  agent_run?: string;
  /** Design tab, build section: the selected build artifact. */
  artifact?: string;
  /** Loads tab, parity section: the selected parity run. */
  parity_run?: string;
  /** Gates and proof tab, gates section: the selected gate's key. */
  gate?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= 400 ? v : undefined;
}

export function parseProjectSearch(raw: Record<string, unknown>): ProjectSearch {
  const out: ProjectSearch = {};
  if (PROJECT_TABS.includes(raw.tab as ProjectTab)) out.tab = raw.tab as ProjectTab;
  const v = Number(raw.version);
  if (Number.isInteger(v) && v > 0) out.version = v;
  if (out.tab === 'plan' && PLAN_SECTIONS.includes(raw.section as PlanSection)) {
    out.section = raw.section as PlanSection;
  }
  if (out.tab === 'design' && isDesignSection(raw.section)) out.section = raw.section;
  if (out.tab === 'design') {
    const key = str(raw.key);
    if (key) out.key = key;
    const artifact = str(raw.artifact);
    if (artifact) out.artifact = artifact;
  }
  if (out.tab === 'loads' && isLoadsSection(raw.section)) out.section = raw.section;
  if (out.tab === 'loads') {
    const parity = str(raw.parity_run);
    if (parity) out.parity_run = parity;
  }
  if (out.tab === 'gates' && isGatesSection(raw.section)) out.section = raw.section;
  if (out.tab === 'gates') {
    const gate = str(raw.gate);
    if (gate) out.gate = gate;
  }
  if (out.tab === 'reviews') Object.assign(out, parseReviewSearch(raw));
  if (out.tab === 'conversion' || out.tab === 'delta' || out.tab === 'loads') {
    const run = str(raw.run);
    if (run) out.run = run;
  }
  if (out.tab === 'conversion') {
    const object = str(raw.object);
    if (object) out.object = object;
  }
  if (out.tab === 'agents') {
    const run = str(raw.agent_run);
    if (run) out.agent_run = run;
  }
  return out;
}
