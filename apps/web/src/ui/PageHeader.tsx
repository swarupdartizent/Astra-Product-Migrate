import { Link, type LinkProps } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './PageHeader.module.css';

export interface Breadcrumb {
  label: ReactNode;
  /** Omit for the current page. */
  to?: LinkProps['to'];
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Primary page actions, aligned to the end. */
  actions?: ReactNode;
  breadcrumbs?: readonly Breadcrumb[];
  /** Small element beside the title, e.g. a StatusPill. */
  meta?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header className={cx(styles.header, className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
          <ol>
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <Fragment key={index}>
                  <li>
                    {crumb.to && !isLast ? (
                      <Link to={crumb.to} className={styles.crumbLink}>
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
                    )}
                  </li>
                  {!isLast ? (
                    <li aria-hidden="true" className={styles.separator}>
                      <ChevronRight />
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className={styles.row}>
        <div className={styles.text}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{title}</h1>
            {meta}
          </div>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </header>
  );
}
