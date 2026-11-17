import styles from './Observability.module.css';

/** Decorative proportional bar; the number beside it carries the value for assistive tech. */
export function Bar({ percent, tone = 'accent' }: { percent: number; tone?: 'accent' | 'danger' }) {
  return (
    <span className={styles.barTrack} aria-hidden="true">
      <span
        className={styles.barFill}
        data-tone={tone}
        style={{ width: `${Math.max(percent, percent > 0 ? 1 : 0)}%` }}
      />
    </span>
  );
}
