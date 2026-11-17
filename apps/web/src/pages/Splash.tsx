import { ProductMark } from '@/app/ProductMark';
import { Spinner } from '@/ui';
import styles from './Splash.module.css';

/** Full-screen loading state used before the app shell can render. */
export function Splash({ label = 'Loading Astra Migrate…' }: { label?: string }) {
  return (
    <main className={styles.splash} aria-busy="true">
      <ProductMark showName={false} size="lg" />
      <div className={styles.status}>
        <Spinner />
        <p role="status">{label}</p>
      </div>
    </main>
  );
}
