import type {
  Composition,
  PackDetail,
  PackStatus,
  PackSummary,
  PackType,
  SettingValueType,
  Strictness,
} from '@/api/types';
import type { Tone } from '@/ui';

export const PACK_TYPES: readonly { value: PackType; label: string }[] = [
  { value: 'source_adapter', label: 'Source adapter' },
  { value: 'target_adapter', label: 'Target adapter' },
  { value: 'domain', label: 'Domain' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'agentification', label: 'Agentification' },
];

export function packTypeLabel(type: string): string {
  return PACK_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const PACK_STATUS: Record<PackStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  deprecated: { label: 'Deprecated', tone: 'neutral' },
};

export function testsLabel(passed: boolean | null): { label: string; tone: Tone } {
  if (passed === null) return { label: 'Not run', tone: 'neutral' };
  return passed ? { label: 'Passed', tone: 'success' } : { label: 'Failed', tone: 'danger' };
}

export function packRef(p: Pick<PackSummary, 'name' | 'version'>): string {
  return `${p.name}@${p.version}`;
}

/** Splits "name@1.2.0" into its parts; null when malformed. */
export function parseRef(ref: string): { name: string; version: string } | null {
  const at = ref.indexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

/** Numeric sort key for "major.minor.patch". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface PackGroup {
  name: string;
  latest: PackSummary;
  /** Older versions, newest first. */
  others: PackSummary[];
}

/** Groups versions by pack name, newest version first in each group. */
export function groupPacks(packs: readonly PackSummary[]): PackGroup[] {
  const byName = new Map<string, PackSummary[]>();
  for (const p of packs) {
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  return [...byName.entries()]
    .map(([name, list]) => {
      const [latest, ...others] = [...list].sort((a, b) => compareVersions(b.version, a.version));
      return latest ? [{ name, latest, others }] : [];
    })
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain-language strictness for a setting. */
export function strictnessWords(stricter: Strictness): string {
  switch (stricter) {
    case 'higher':
      return 'Higher is stricter';
    case 'lower':
      return 'Lower is stricter';
    case 'true':
      return '“Yes” is stricter';
    case 'false':
      return '“No” is stricter';
    default:
      return 'No order: any difference needs a decision';
  }
}

export function formatSettingValue(
  value: SettingValueType | null | undefined,
  unit?: string | null,
): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return unit ? `${String(value)} ${unit}` : String(value);
}

/** Placement areas (from GET /packs/control-types), in a readable order. */
export const PLACEMENT_LABELS: Record<string, string> = {
  tasks: 'Tasks',
  review_rules: 'Review rules',
  lifecycle_gate: 'Lifecycle gates',
  proof_pack: 'Proof pack',
  hosting: 'Hosting',
  decommission: 'Decommission',
};

export function placementLabel(area: string): string {
  return PLACEMENT_LABELS[area] ?? area.replace(/_/g, ' ');
}

// ---------- Upload bundle ----------

export interface BundleInput {
  /** Path relative to the chosen folder or file name, e.g. "my-pack/pack.yaml". */
  path: string;
  bytes: Uint8Array;
}

export interface Bundle {
  files: Record<string, string>;
  /** Folder prefix removed from every path, if any. */
  strippedPrefix: string | null;
}

export class BundleError extends Error {}

/** Base64 for arbitrary bytes, chunked to stay within call-stack limits. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Builds the POST /packs body. pack.yaml must end up at the root: when every file sits inside
 * one folder (a picked directory), that folder prefix is stripped. Hidden OS files are skipped.
 */
export function buildBundle(inputs: readonly BundleInput[]): Bundle {
  const files = inputs
    .map((f) => ({ ...f, path: normalise(f.path) }))
    .filter((f) => {
      const base = f.path.split('/').pop() ?? '';
      return base !== '.DS_Store' && base !== 'Thumbs.db' && base !== 'desktop.ini';
    });
  if (files.length === 0) throw new BundleError('Choose a pack folder or its files.');

  let prefix: string | null = null;
  if (!files.some((f) => f.path === 'pack.yaml')) {
    const firstSegments = new Set(
      files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : '')),
    );
    const only = [...firstSegments][0];
    if (firstSegments.size === 1 && only && files.some((f) => f.path === `${only}/pack.yaml`)) {
      prefix = `${only}/`;
    }
  }
  const out: Record<string, string> = {};
  for (const f of files) {
    const path = prefix ? f.path.slice(prefix.length) : f.path;
    out[path] = toBase64(f.bytes);
  }
  if (!('pack.yaml' in out)) {
    throw new BundleError(
      'The pack needs a pack.yaml at its root. Choose the pack folder itself, or include pack.yaml with the files.',
    );
  }
  return { files: out, strippedPrefix: prefix ? prefix.slice(0, -1) : null };
}

/** Reads browser File objects (folder picks carry webkitRelativePath). */
export async function readFiles(list: FileList | readonly File[]): Promise<BundleInput[]> {
  const files = Array.from(list);
  return Promise.all(
    files.map(async (file) => ({
      path: file.webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

// ---------- Release and comparison ----------

/** Why "Publish" is not available yet, or null when it is. */
export function publishBlocker(pack: PackDetail): string | null {
  if (pack.status !== 'draft') return `This version is already ${pack.status}.`;
  if (pack.tests_passed !== true) {
    return pack.tests_passed === null ? 'Run the tests first.' : 'The tests must pass first.';
  }
  if (pack.type === 'compliance' && !pack.reviewed_by_name) {
    return 'A compliance specialist’s review must be recorded first.';
  }
  return null;
}

/** Field-level changes between two versions of the same item. */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ field: k, before: before[k], after: after[k] }));
}

/** Controls grouped by where the planner places them. */
export function groupControlsByArea(composition: Composition) {
  const map = new Map<string, Composition['controls']>();
  for (const c of composition.controls) {
    const list = map.get(c.placement.area) ?? [];
    list.push(c);
    map.set(c.placement.area, list);
  }
  return [...map.entries()].sort((a, b) =>
    placementLabel(a[0]).localeCompare(placementLabel(b[0])),
  );
}
