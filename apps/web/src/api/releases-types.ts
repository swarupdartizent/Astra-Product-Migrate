/**
 * Release gate (I13, E22.F1.S2): release records, the preview evaluation, and recording a release.
 * Shapes follow api/routes/releases.py and evaluation/engine.py (compare, run).
 */

import type { DateTime, Uuid } from './types';

export type ReleaseStatus = 'released' | 'blocked';

/** One measure that fell, disappeared, or one suite that disappeared (`measure` null). */
export interface ReleaseRegression {
  suite: string;
  /** "area.measure", or null when the whole suite is missing. */
  measure: string | null;
  baseline: number | null;
  current: number | null;
  detail: string;
}

/** One measure that rose above the baseline. */
export interface ReleaseImprovement {
  suite: string;
  measure: string;
  baseline: number;
  current: number;
}

/** A suite's scorecard: the digest of its suite file and its measures (0 to 1, higher is better). */
export interface SuiteScore {
  digest: string;
  measures: Record<string, number>;
}

export interface Release {
  id: Uuid;
  name: string;
  status: ReleaseStatus;
  /** The released record this one was compared with; null for the first release. */
  baseline_release: string | null;
  regressions: ReleaseRegression[];
  improved: ReleaseImprovement[];
  reason: string;
  recorded_by: string | null;
  created_at: DateTime | null;
  engine_digest: string | null;
}

/** GET /releases/{id} and POST /releases: the release with its full scorecard. */
export interface ReleaseDetail extends Release {
  suites: Record<string, SuiteScore>;
}

/** GET /releases */
export interface ReleaseList {
  releases: Release[];
  /** True when the caller may run the evaluation and record releases (platform golden:run). */
  can_record: boolean;
}

/** GET /releases/evaluation: the scorecard now, compared with the latest released record. */
export interface ReleaseEvaluation {
  baseline_release: string | null;
  passed: boolean;
  regressions: ReleaseRegression[];
  improved: ReleaseImprovement[];
  /** Suites whose file changed since the baseline. */
  changed_suites: string[];
  suites: Record<string, SuiteScore>;
  engine_digest: string;
}

/** POST /releases */
export interface ReleaseIn {
  name: string;
  reason: string;
}
