export const PACK_TABS = [
  'overview',
  'controls',
  'rules',
  'settings',
  'files',
  'tests',
  'compare',
] as const;

export type PackTab = (typeof PACK_TABS)[number];
