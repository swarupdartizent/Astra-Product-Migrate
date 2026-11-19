import { FileCheck } from 'lucide-react';
import { useState } from 'react';
import { useDocumentChecks, useLoadRun, useRunDocumentChecks } from '@/api/loads';
import type { DocumentStatus, DocumentSummary, LoadRun } from '@/api/loads-types';
import type { Project } from '@/api/types';
import { ApiErrorView } from '@/app/ApiErrorView';
import { FormError } from '@/app/FormError';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Mono,
  Select,
  Skeleton,
  StatusPill,
  toast,
} from '@/ui';
import s from '../shared.module.css';
import styles from './Loads.module.css';
import { DOC_STATUS, docStatus } from './model';
import { RunPicker, Stat, Why } from './Parts';

const ALL = '__all__';
const PAGE = 100;

/**
 * Document checks (E13.F2.S2): every document of the run's extract must link to a record the
 * target accepted, and a repeatable random sample is read back and compared by SHA-256.
 */
export function DocumentsView({
  project,
  runs,
  runsPending,
  runId,
  onRun,
}: {
  project: Project;
  runs: LoadRun[];
  runsPending: boolean;
  runId: string | null;
  onRun: (id: string) => void;
}) {
  const run = useLoadRun(project.id, runId);
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const docs = useDocumentChecks(project.id, runId, status, offset);
  const check = useRunDocumentChecks(project.id, runId ?? '');
  const r = run.data;
  const why = !project.permissions.includes('stage:manage')
    ? 'Document checks need stage management on this project.'
    : !r
      ? 'Loading the run…'
      : r.status !== 'succeeded'
        ? `Document checks run on a finished run; this one is ${r.status}.`
        : r.extract_run_id === null
          ? 'This run has no extract (a reload): check the documents on the original run.'
          : null;
  const summary: DocumentSummary | null = docs.data?.summary ?? r?.summary.documents ?? null;
  if (!runsPending && runs.length === 0) {
    return (
      <EmptyState title="No load runs yet" body="Start a load first, then check its documents." />
    );
  }
  return (
    <div className={s.stack}>
      <Card aria-labelledby="docs-head">
        <CardHeader
          titleId="docs-head"
          title="Document checks"
          description="Each document’s link must resolve at source and point to a record the target accepted. A random sample, seeded by the run so it can be repeated, is read back from the target and compared byte for byte."
          actions={
            <Button
              variant="primary"
              leadingIcon={<FileCheck aria-hidden="true" />}
              disabled={!!why}
              loading={check.isPending}
              aria-describedby={why ? 'docs-why' : undefined}
              onClick={() =>
                check.mutate(undefined, {
                  onSuccess: (res) =>
                    toast[res.passed ? 'success' : 'warning'](
                      res.passed ? 'Document checks passed' : 'Document checks found problems',
                    ),
                })
              }
            >
              Run checks
            </Button>
          }
        />
        <CardBody className={s.stackSm}>
          <div className={s.filters}>
            <RunPicker runs={runs} value={runId} onChange={onRun} />
          </div>
          {why ? <Why id="docs-why">{why}</Why> : null}
          <FormError error={check.error} />
          <div role="status" aria-live="polite">
            {summary ? (
              <div className={s.stackSm}>
                <div className={styles.stats}>
                  <Stat label="Documents" value={summary.documents.toLocaleString()} />
                  <Stat
                    label="Broken links"
                    value={summary.broken_links.toLocaleString()}
                    tone={summary.broken_links ? 'danger' : 'success'}
                  />
                  <Stat label="Sample size" value={summary.sample_size.toLocaleString()} />
                  {Object.entries(summary.sample).map(([k, n]) => (
                    <Stat
                      key={k}
                      label={`Sample: ${docStatus(k).label.toLowerCase()}`}
                      value={n.toLocaleString()}
                      tone={k === 'match' ? 'success' : 'danger'}
                    />
                  ))}
                </div>
                {summary.blocked ? (
                  <Callout tone="warning" title="The read-back sample is blocked">
                    {summary.blocked}
                  </Callout>
                ) : null}
                <Callout
                  tone={summary.passed ? 'success' : 'danger'}
                  title={summary.passed ? 'Documents passed' : 'Documents did not pass'}
                >
                  {summary.passed
                    ? 'Every link resolves to an accepted record and every sampled document matches its source.'
                    : 'See the broken, missing, mismatched or blocked documents below.'}
                </Callout>
              </div>
            ) : (
              <p className={`${s.muted} ${s.small}`}>
                The documents of this run have not been checked.
              </p>
            )}
          </div>
        </CardBody>
      </Card>
      <Card flush aria-labelledby="docs-list-head">
        <CardHeader titleId="docs-list-head" title="Checked documents" />
        <div className={styles.filters} role="group" aria-label="Filter documents">
          <Field label="Status">
            <Select
              size="sm"
              options={[
                { value: ALL, label: 'All' },
                ...Object.entries(DOC_STATUS).map(([k, v]) => ({ value: k, label: v.label })),
              ]}
              value={status || ALL}
              onValueChange={(v) => {
                setStatus(v === ALL ? '' : (v as DocumentStatus));
                setOffset(0);
              }}
            />
          </Field>
        </div>
        {docs.isError ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <ApiErrorView
              error={docs.error}
              title="Could not load the document checks"
              compact
              onRetry={() => void docs.refetch()}
            />
          </div>
        ) : docs.isPending ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <Skeleton height="6rem" />
          </div>
        ) : docs.data.items.length === 0 ? (
          <EmptyState
            compact
            title="No documents"
            body={status ? 'Nothing has this status.' : 'Run the checks to list documents.'}
          />
        ) : (
          <>
            <div
              className={styles.tableWrap}
              // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label="Document checks"
            >
              <table className={styles.table} aria-busy={docs.isFetching}>
                <caption className="sr-only">Documents of the run with their check result</caption>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Link key</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.data.items.map((d) => {
                    const st = docStatus(d.status);
                    return (
                      <tr key={`${d.doc_key}:${d.status}`}>
                        <th scope="row">
                          <Mono className={s.xs}>{d.doc_key}</Mono>
                        </th>
                        <td>{d.entity ?? '—'}</td>
                        <td>{d.link_key ? <Mono className={s.xs}>{d.link_key}</Mono> : '—'}</td>
                        <td>
                          <StatusPill tone={st.tone}>{st.label}</StatusPill>
                        </td>
                        <td className={s.small}>{d.detail ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className={styles.bar}>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                Previous
              </Button>
              <span className={s.muted}>
                {offset + 1}–{offset + docs.data.items.length} of {docs.data.total.toLocaleString()}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset + PAGE >= docs.data.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
