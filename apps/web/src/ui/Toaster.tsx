import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@/theme/useTheme';
import styles from './Toaster.module.css';

/**
 * Mount once. Trigger toasts anywhere with `toast()` from `@/ui` (re-exported from sonner):
 * toast.success(title, { description }), toast.error(...), toast.warning(...), toast.info(...).
 * Toasts are announced via an ARIA live region.
 */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      closeButton
      richColors={false}
      duration={6000}
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast: styles.toast,
          title: styles.title,
          description: styles.description,
          closeButton: styles.close,
          actionButton: styles.action,
          success: styles.success,
          error: styles.error,
          warning: styles.warning,
          info: styles.info,
          icon: styles.icon,
        },
      }}
    />
  );
}
