export const MODEL_TABS = ['providers', 'aliases', 'usage', 'calls'] as const;
export type ModelTab = (typeof MODEL_TABS)[number];
