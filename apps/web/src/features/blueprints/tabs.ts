export const PROJECT_TABS = [
  'editor',
  'versions',
  'compare',
  'decisions',
  'agents',
  'reviews',
  'baseline',
  'discovery',
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
