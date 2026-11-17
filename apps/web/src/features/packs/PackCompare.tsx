import { useState } from 'react';
import { usePackDiff } from '@/api/packs';
import type { PackDetail, PackSectionDiff } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Mono, Select, Skeleton } from '@/ui';
import s from '../shared.module.css';
import { changedFields, compareVersions } from './model';
import styles from './Packs.module.css';

interface Item {
  id?: string;
  key?: string;
  title?: string;
  statement?: string;
  value?: unknown;
}

function itemId(item: Item): string {
  return item.id ?? item.key ?? '?';
}

function itemText(item: Item): string {
  if (item.title) return item.title;
  if (item.statement) return item.statement;
  if (item.value !== undefined) return `= ${JSON.stringify(item.value)}`;
  return '';
}

function short(value: unknown): string {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function Section({ title, diff }: { title: string; diff: PackSectionDiff<Item> }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  return (
    <section className={styles.diffSection} aria-label={title}>
      <h3 className={s.cellPrimary}>
        {title}{' '}
        <span className={`${s.muted} ${s.small}`}>
          {total === 0
            ? 'no changes'
            : `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`}
        </span>
      </h3>
      {total > 0 ? (
        <ul className={styles.diffList}>
          {diff.added.map((item) => (
            <li key={`a-${itemId(item)}`} className={styles.diffItem} data-kind="added">
              <span className={styles.diffMark} aria-hidden="true">
                +
              </span>
              <span>
                <span className="sr-only">Added: </span>
                <Mono>{itemId(item)}</Mono> {itemText(item)}
              </span>
            </li>
          ))}
          {diff.removed.map((item) => (
            <li key={`r-${itemId(item)}`} className={styles.diffItem} data-kind="removed">
              <span className={styles.diffMark} aria-hidden="true">
                −
              </span>
              <span>
                <span className="sr-only">Removed: </span>
                <Mono>{itemId(item)}</Mono> {itemText(item)}
              </span>
            </li>
          ))}
          {diff.changed.map((c) => (
            <li key={`c-${c.id}`} className={styles.diffItem} data-kind="changed">
              <span className={styles.diffMark} aria-hidden="true">
                ~
              </span>
              <span className={s.cellStack}>
                <span>
                  <span className="sr-only">Changed: </span>
                  <Mono>{c.id}</Mono>
                </span>
                {changedFields(
                  c.before as Record<string, unknown>,
                  c.after as Record<string, unknown>,
                ).map((f) => (
                  <span key={f.field} className={s.small}>
                    <Mono>{f.field}</Mono>: {short(f.before)} → {short(f.after)}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function PackCompare({ pack }: { pack: PackDetail }) {
  const others = pack.other_versions.filter((v) => v !== pack.version);
  const [other, setOther] = useState<string | null>(others[0] ?? null);
  // Always show the change from the older to the newer version.
  const [from, to] =
    other && compareVersions(other, pack.version) > 0
      ? [pack.version, other]
      : [other, pack.version];
  const diff = usePackDiff(pack.name, from, to);

  return (
    <Card aria-labelledby="compare-title">
      <CardHeader
        titleId="compare-title"
        title="Compare versions"
        description="What changes for a project that moves between these versions. Moving a project to another pack version is a new blueprint version that needs approval."
        actions={
          <div style={{ width: '12rem' }}>
            <Field label="Compare with" hideLabel>
              <Select
                size="sm"
                options={others.map((v) => ({ value: v, label: `Compare with ${v}` }))}
                value={other ?? ''}
                onValueChange={setOther}
                placeholder="Choose a version"
              />
            </Field>
          </div>
        }
      />
      <CardBody>
        {!other ? (
          <EmptyState compact title="No other versions" />
        ) : diff.isPending ? (
          <Skeleton height="8rem" />
        ) : diff.isError ? (
          <ApiErrorView
            error={diff.error}
            title="Could not compare"
            compact
            onRetry={() => void diff.refetch()}
          />
        ) : (
          <>
            <p className={s.small} style={{ marginBottom: 'var(--space-3)' }}>
              From <Badge>{diff.data.from}</Badge> to <Badge>{diff.data.to}</Badge>
            </p>
            <Section title="Controls" diff={diff.data.controls} />
            <Section title="Rules" diff={diff.data.rules} />
            <Section title="Settings" diff={diff.data.settings} />
            <section className={styles.diffSection} aria-label="Requirements">
              <h3 className={s.cellPrimary}>Requirements</h3>
              <p className={s.small}>
                Before:{' '}
                {diff.data.requires.before.length
                  ? diff.data.requires.before.map((r) => `${r.name} ${r.versions}`).join(', ')
                  : 'none'}
                <br />
                After:{' '}
                {diff.data.requires.after.length
                  ? diff.data.requires.after.map((r) => `${r.name} ${r.versions}`).join(', ')
                  : 'none'}
              </p>
            </section>
          </>
        )}
      </CardBody>
    </Card>
  );
}
