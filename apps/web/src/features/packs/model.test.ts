import { describe, expect, it } from 'vitest';
import type { PackDetail, PackSummary } from '@/api/types';
import {
  buildBundle,
  BundleError,
  compareVersions,
  groupPacks,
  parseRef,
  publishBlocker,
  strictnessWords,
  toBase64,
} from './model';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('upload bundle', () => {
  it('strips the picked folder so pack.yaml sits at the root', () => {
    const bundle = buildBundle([
      { path: 'records-pack/pack.yaml', bytes: bytes('name: records') },
      { path: 'records-pack/docs/readme.md', bytes: bytes('# Readme') },
      { path: 'records-pack/.DS_Store', bytes: bytes('x') },
    ]);
    expect(bundle.strippedPrefix).toBe('records-pack');
    expect(Object.keys(bundle.files).sort()).toEqual(['docs/readme.md', 'pack.yaml']);
    expect(atob(bundle.files['pack.yaml']!)).toBe('name: records');
  });

  it('keeps paths when files are picked directly, and normalises separators', () => {
    const bundle = buildBundle([
      { path: 'pack.yaml', bytes: bytes('a') },
      { path: 'tests\\case.yaml', bytes: bytes('b') },
    ]);
    expect(bundle.strippedPrefix).toBeNull();
    expect(Object.keys(bundle.files).sort()).toEqual(['pack.yaml', 'tests/case.yaml']);
  });

  it('refuses bundles without pack.yaml at the root', () => {
    expect(() => buildBundle([{ path: 'a/b/pack.yaml', bytes: bytes('x') }])).toThrow(BundleError);
    expect(() => buildBundle([])).toThrow(/Choose/);
  });

  it('base64-encodes binary content exactly', () => {
    const data = new Uint8Array([0, 255, 128, 10]);
    expect(toBase64(data)).toBe('AP+ACg==');
    expect(toBase64(bytes('hi'))).toBe(btoa('hi'));
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(100_000);
  });
});

function summary(name: string, version: string): PackSummary {
  return {
    id: `${name}-${version}`,
    name,
    version,
    type: 'domain',
    title: name,
    status: 'published',
    tests_passed: true,
    reviewed_by_name: null,
    published_at: null,
    created_at: '2026-11-17T10:00:00Z',
  };
}

describe('library grouping', () => {
  it('groups by name with the newest version first (numeric, not text, order)', () => {
    const groups = groupPacks([
      summary('b', '1.2.0'),
      summary('a', '1.0.0'),
      summary('b', '1.10.0'),
      summary('b', '1.9.1'),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['a', 'b']);
    expect(groups[1]?.latest.version).toBe('1.10.0');
    expect(groups[1]?.others.map((p) => p.version)).toEqual(['1.9.1', '1.2.0']);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('parses refs', () => {
    expect(parseRef('records@1.2.0')).toEqual({ name: 'records', version: '1.2.0' });
    expect(parseRef('records')).toBeNull();
  });
});

describe('release rules', () => {
  const pack = (over: Partial<PackDetail>) =>
    ({
      ...summary('c', '1.0.0'),
      type: 'compliance',
      status: 'draft',
      tests_passed: null,
      ...over,
    }) as PackDetail;

  it('explains why publishing is not possible yet', () => {
    expect(publishBlocker(pack({}))).toMatch(/Run the tests/);
    expect(publishBlocker(pack({ tests_passed: false }))).toMatch(/must pass/);
    expect(publishBlocker(pack({ tests_passed: true }))).toMatch(/review/);
    expect(publishBlocker(pack({ tests_passed: true, reviewed_by_name: 'A Reviewer' }))).toBeNull();
    expect(publishBlocker(pack({ tests_passed: true, type: 'domain' }))).toBeNull();
    expect(publishBlocker(pack({ status: 'published' }))).toMatch(/already published/);
  });

  it('describes strictness in words', () => {
    expect(strictnessWords('higher')).toBe('Higher is stricter');
    expect(strictnessWords('lower')).toBe('Lower is stricter');
  });
});
