import { GitCompare } from 'lucide-react';
import { useState } from 'react';
import { useBlueprintDiff, useVersions } from '@/api/blueprints';
import type { BlueprintDiff, Project, VersionSummary } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Mono,
  Select,
  Skeleton,
  Timestamp,
} from '@/ui';
import s from '../shared.module.css';
import packStyles from '../packs/Packs.module.css';
import { formatDiffValue } from './model';

function VersionHeader({ label, v }: { label: string; v: VersionSummary }) {
  return (
    <div className={s.cellStack}>
      <span className={`${s.muted} ${s.xs}`}>{label}</span>
      <strong>Version {v.number}</strong>
      <span className={s.small}>“{v.message}”</span>
      <span className={`${s.muted} ${s.xs}`}>
        {v.author_name} · <Timestamp value={v.created_at} />
      </span>
    </div>
  );
}

export function DiffList({ diff }: { diff: Pick<BlueprintDiff, 'added' | 'removed' | 'changed'> }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) return <p className={s.muted}>The two versions are the same.</p>;
  return (
    <ul className={packStyles.diffList} aria-label="Differences">
      {diff.added.map((d) => (
        <li key={`a-${d.path}`} className={packStyles.diffItem} data-kind="added">
          <span className={packStyles.diffMark} aria-hidden="true">
            +
          </span>
          <span>
            <span className="sr-only">Added: </span>
            <Mono>{d.path}</Mono> {d.value === true ? '' : `= ${formatDiffValue(d.value)}`}
          </span>
        </li>
      ))}
      {diff.removed.map((d) => (
        <li key={`r-${d.path}`} className={packStyles.diffItem} data-kind="removed">
          <span className={packStyles.diffMark} aria-hidden="true">
            −
          </span>
          <span>
            <span className="sr-only">Removed: </span>
            <Mono>{d.path}</Mono> {d.value === true ? '' : `(was ${formatDiffValue(d.value)})`}
          </span>
        </li>
      ))}
      {diff.changed.map((d) => (
        <li key={`c-${d.path}`} className={packStyles.diffItem} data-kind="changed">
          <span className={packStyles.diffMark} aria-hidden="true">
            ~
          </span>
          <span>
            <span className="sr-only">Changed: </span>
            <Mono>{d.path}</Mono>: {formatDiffValue(d.before)} → {formatDiffValue(d.after)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CompareTab({ project }: { project: Project }) {
  const versions = useVersions(project.id);
  const list = versions.data ?? [];
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const a = from ?? list[1]?.number ?? null;
  const b = to ?? list[0]?.number ?? null;
  const diff = useBlueprintDiff(project.id, a, b);
  const options = list.map((v) => ({ value: String(v.number), label: `Version ${v.number}` }));

  if (versions.isPending) return <Skeleton height="10rem" />;
  if (versions.isError) {
    return (
      <ApiErrorView
        error={versions.error}
        title="Could not load versions"
        onRetry={() => void versions.refetch()}
      />
    );
  }
  if (list.length < 2) {
    return (
      <EmptyState
        icon={<GitCompare />}
        title="Nothing to compare yet"
        body="Comparison needs at least two versions."
      />
    );
  }

  return (
    <Card aria-labelledby="compare-title">
      <CardHeader titleId="compare-title" title="Compare versions" />
      <CardBody className={s.stack}>
        <div className={s.grid2}>
          <Field label="From">
            <Select
              options={options}
              value={a !== null ? String(a) : ''}
              onValueChange={(v) => setFrom(Number(v))}
            />
          </Field>
          <Field label="To">
            <Select
              options={options}
              value={b !== null ? String(b) : ''}
              onValueChange={(v) => setTo(Number(v))}
            />
          </Field>
        </div>
        {a === b ? (
          <p className={s.muted}>Choose two different versions.</p>
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
            <div className={s.grid2}>
              <VersionHeader label="From" v={diff.data.from} />
              <VersionHeader label="To" v={diff.data.to} />
            </div>
            <p className={`${s.muted} ${s.small}`}>
              {diff.data.added.length} added, {diff.data.removed.length} removed,{' '}
              {diff.data.changed.length} changed.
            </p>
            <DiffList diff={diff.data} />
          </>
        )}
      </CardBody>
    </Card>
  );
}
