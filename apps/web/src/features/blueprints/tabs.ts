export const PROJECT_TABS = ['editor', 'versions', 'compare', 'decisions'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
