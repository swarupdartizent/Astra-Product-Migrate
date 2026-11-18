import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import s from '../shared.module.css';
import styles from './Design.module.css';
import { confidenceText } from './model';

/** A confidence score as a bar with the number; the threshold is marked when known. */
export function ConfidenceMeter({
  value,
  threshold,
  label,
}: {
  value: number | null;
  threshold: number | null;
  label: string;
}) {
  if (value === null) return <span>Not scored</span>;
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const lowText = threshold !== null && value < threshold ? `below ${threshold.toFixed(2)}` : null;
  return (
    <span className={styles.meter} data-low={lowText !== null}>
      <span
        className={styles.meterTrack}
        role="meter"
        aria-label={`Confidence for ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${confidenceText(value)}${lowText ? `, ${lowText} (the review threshold)` : ''}`}
      >
        <span className={styles.meterFill} style={{ width: `${String(pct)}%` }} />
        {threshold !== null ? (
          <span
            className={styles.meterThreshold}
            style={{ left: `${String(Math.round(threshold * 100))}%` }}
            aria-hidden="true"
          />
        ) : null}
      </span>
      <span className={styles.meterValue}>{value.toFixed(2)}</span>
      {lowText ? <span className={s.xs}>{lowText}</span> : null}
    </span>
  );
}

/** Source on the left, target on the right. */
export function Pair({
  source,
  target,
  retire = false,
  targetLabel = 'Target',
}: {
  source: ReactNode;
  target: ReactNode;
  retire?: boolean;
  targetLabel?: string;
}) {
  return (
    <div className={styles.pair}>
      <section className={styles.pairSide} aria-label="Source">
        <span className={styles.pairLabel}>Source</span>
        {source}
      </section>
      <ArrowRight className={styles.pairArrow} aria-hidden="true" />
      <section className={styles.pairSide} data-retire={retire} aria-label={targetLabel}>
        <span className={styles.pairLabel}>{targetLabel}</span>
        {target}
      </section>
    </div>
  );
}
