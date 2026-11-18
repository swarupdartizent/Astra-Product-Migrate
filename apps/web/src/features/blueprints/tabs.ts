export const PROJECT_TABS = [
  'editor',
  'versions',
  'compare',
  'decisions',
  'agents',
  'reviews',
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
