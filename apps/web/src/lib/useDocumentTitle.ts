import { useEffect } from 'react';

const PRODUCT = 'Astra Migrate';

/** Sets a unique, descriptive page title (WCAG 2.4.2). */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${PRODUCT}` : PRODUCT;
  }, [title]);
}
