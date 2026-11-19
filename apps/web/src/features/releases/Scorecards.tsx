import { Fragment, type ReactNode } from 'react';
import type { ReleaseImprovement, ReleaseRegression, SuiteScore } from '@/api/releases-types';
import { CopyButton, Mono, StatusPill } from '@/ui';
import { shortDigest } from '../gates/model';
import s from '../shared.module.css';
import {
  COMPARE_KIND,
  describeMeasure,
  formatDelta,
  formatScore,
  groupByArea,
  regressionSubject,
  splitMeasure,
  type SuiteComparison,
} from './model';
import styles from './Releases.module.css';

/** A digest shortened for reading, with its full value in the title and a copy button. */
export function Digest({ value, label }: { value: string; label: string }) {
  return (
    <span className={styles.digest}>
      <Mono title={value}>{shortDigest(value)}</Mono>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

/** Keyboard-reachable, named scroll region around a wide table (WCAG 2.1.1). */
function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className={styles.tableWrap}
      // A scrollable table must be reachable by keyboard (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}

function MeasureName({ name }: { name: string }) {
  const { measure } = splitMeasure(name);
  return <Mono>{measure}</Mono>;
}

export function RegressionsTable({
  regressions,
  label,
}: {
  regressions: readonly ReleaseRegression[];
  label: string;
}) {
  return (
    <TableRegion label={label}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Suite</th>
            <th scope="col">Measure</th>
            <th scope="col" className={styles.num}>
              Baseline
            </th>
            <th scope="col" className={styles.num}>
              Current
            </th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {regressions.map((r) => (
            <tr key={`${r.suite}|${r.measure ?? ''}`} className={styles.fell}>
              <th scope="row">{r.suite}</th>
              <td>{r.measure ? <Mono>{regressionSubject(r)}</Mono> : regressionSubject(r)}</td>
              <td className={styles.num}>{formatScore(r.baseline)}</td>
              <td className={styles.num}>
                {r.current === null ? (
                  <span className={s.muted}>Missing</span>
                ) : (
                  formatScore(r.current)
                )}
              </td>
              <td>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

export function ImprovementsTable({
  improved,
  label,
}: {
  improved: readonly ReleaseImprovement[];
  label: string;
}) {
  return (
    <TableRegion label={label}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Suite</th>
            <th scope="col">Measure</th>
            <th scope="col" className={styles.num}>
              Baseline
            </th>
            <th scope="col" className={styles.num}>
              Current
            </th>
            <th scope="col" className={styles.num}>
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {improved.map((r) => (
            <tr key={`${r.suite}|${r.measure}`} className={styles.improved}>
              <th scope="row">{r.suite}</th>
              <td>
                <Mono>{r.measure}</Mono>
              </td>
              <td className={styles.num}>{formatScore(r.baseline)}</td>
              <td className={styles.num}>{formatScore(r.current)}</td>
              <td className={styles.num}>{formatDelta(r.baseline, r.current)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

/** Every measure of every suite, grouped by area, with what each one measures. */
export function SuiteScorecards({
  suites,
  regressions = [],
}: {
  suites: Readonly<Record<string, SuiteScore>>;
  regressions?: readonly ReleaseRegression[];
}) {
  const sorted = Object.entries(suites).sort(([a], [b]) => a.localeCompare(b));
  if (sorted.length === 0) return <p className={s.muted}>This scorecard has no suites.</p>;
  return (
    <div className={s.stack}>
      {sorted.map(([suite, score]) => {
        const fell = new Set(regressions.filter((r) => r.suite === suite).map((r) => r.measure));
        const entries = Object.entries(score.measures);
        const groups = groupByArea(entries, ([name]) => name);
        return (
          <section key={suite} aria-label={`Suite ${suite}`}>
            <h3 className={styles.suiteHead}>
              <span>
                Suite <Mono>{suite}</Mono>
              </span>
              <span className={`${s.xs} ${s.muted}`}>
                suite digest <Digest value={score.digest} label={`digest of suite ${suite}`} />
              </span>
            </h3>
            <TableRegion label={`Measures of suite ${suite}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col" className={styles.num}>
                      Score
                    </th>
                    <th scope="col">What it measures</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(({ area, items }) => (
                    <Fragment key={area.key}>
                      <tr className={styles.areaRow}>
                        <th scope="colgroup" colSpan={3}>
                          {area.label}
                          {area.engine ? (
                            <span className={styles.areaEngine}>{area.engine}</span>
                          ) : null}
                        </th>
                      </tr>
                      {items.map(([name, value]) => (
                        <tr key={name} className={fell.has(name) ? styles.fell : undefined}>
                          <th scope="row">
                            <MeasureName name={name} />
                            {fell.has(name) ? (
                              <>
                                {' '}
                                <StatusPill tone="danger">Fell</StatusPill>
                              </>
                            ) : null}
                          </th>
                          <td className={styles.num}>{formatScore(value)}</td>
                          <td className={styles.desc}>{describeMeasure(name) ?? '—'}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          </section>
        );
      })}
    </div>
  );
}

/** Baseline and now, side by side, per suite and area; what fell is marked in words and colour. */
export function ComparisonTables({
  comparisons,
  baselineName,
  baselineKnown,
}: {
  comparisons: readonly SuiteComparison[];
  baselineName: string | null;
  /** False when only the changed measures' baseline values are known. */
  baselineKnown: boolean;
}) {
  const baseHeader = baselineName ? `Baseline (${baselineName})` : 'Baseline';
  return (
    <div className={s.stack}>
      {comparisons.map((c) => {
        const groups = groupByArea(c.rows, (r) => r.measure);
        return (
          <section key={c.suite} aria-label={`Comparison for suite ${c.suite}`}>
            <h3 className={styles.suiteHead}>
              <span>
                Suite <Mono>{c.suite}</Mono>
              </span>
              {c.missing ? <StatusPill tone="danger">Suite missing</StatusPill> : null}
              {c.changed ? <StatusPill tone="info">Suite changed since baseline</StatusPill> : null}
            </h3>
            {c.rows.length === 0 ? (
              <p className={s.muted}>
                {c.missing ? 'The suite is no longer evaluated.' : 'No measures.'}
              </p>
            ) : (
              <TableRegion label={`Baseline and now for suite ${c.suite}`}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Measure</th>
                      <th scope="col" className={styles.num}>
                        {baseHeader}
                      </th>
                      <th scope="col" className={styles.num}>
                        Now
                      </th>
                      <th scope="col" className={styles.num}>
                        Change
                      </th>
                      <th scope="col">Result</th>
                      <th scope="col">What it measures</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map(({ area, items }) => (
                      <Fragment key={area.key}>
                        <tr className={styles.areaRow}>
                          <th scope="colgroup" colSpan={6}>
                            {area.label}
                            {area.engine ? (
                              <span className={styles.areaEngine}>{area.engine}</span>
                            ) : null}
                          </th>
                        </tr>
                        {items.map((r) => {
                          const kind = COMPARE_KIND[r.kind];
                          const bad = r.kind === 'fell' || r.kind === 'missing';
                          return (
                            <tr
                              key={r.measure}
                              className={
                                bad
                                  ? styles.fell
                                  : r.kind === 'improved'
                                    ? styles.improved
                                    : undefined
                              }
                            >
                              <th scope="row">
                                <MeasureName name={r.measure} />
                              </th>
                              <td className={styles.num}>
                                {r.baseline === null && r.kind === 'same' && !baselineKnown ? (
                                  <span className={s.muted}>Same</span>
                                ) : (
                                  formatScore(r.baseline)
                                )}
                              </td>
                              <td className={styles.num}>
                                {r.current === null ? (
                                  <span className={s.muted}>Missing</span>
                                ) : (
                                  formatScore(r.current)
                                )}
                              </td>
                              <td className={styles.num}>{formatDelta(r.baseline, r.current)}</td>
                              <td>
                                <StatusPill tone={kind.tone}>{kind.label}</StatusPill>
                              </td>
                              <td className={styles.desc}>{describeMeasure(r.measure) ?? '—'}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </TableRegion>
            )}
          </section>
        );
      })}
    </div>
  );
}
