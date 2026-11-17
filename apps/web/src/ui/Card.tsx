import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Render as <section> (default, labelled by its title) or a plain <div>. */
  as?: 'section' | 'div' | 'article';
  /** Remove body padding, e.g. when a table fills the card. */
  flush?: boolean;
}

export function Card({ as: Tag = 'section', flush = false, className, ...rest }: CardProps) {
  return <Tag className={cx(styles.card, flush && styles.flush, className)} {...rest} />;
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  /** Id for the title, so the card can use aria-labelledby. */
  titleId?: string;
  description?: ReactNode;
  /** Controls aligned to the end of the header. */
  actions?: ReactNode;
}

export function CardHeader({
  title,
  titleId,
  description,
  actions,
  className,
  ...rest
}: CardHeaderProps) {
  return (
    <div className={cx(styles.header, className)} {...rest}>
      <div className={styles.heading}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.body, className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.footer, className)} {...rest} />;
}
