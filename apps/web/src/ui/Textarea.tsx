import type { Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './controls.module.css';
import { useFieldControl } from './field-context';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ mono = false, className, rows = 4, ...props }: TextareaProps) {
  const fieldProps = useFieldControl(props);
  return (
    <textarea
      rows={rows}
      className={cx(styles.control, styles.textarea, mono && styles.mono, className)}
      {...fieldProps}
    />
  );
}
