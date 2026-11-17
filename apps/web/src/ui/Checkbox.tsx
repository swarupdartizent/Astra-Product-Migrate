import * as RadixCheckbox from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '@/lib/cx';
import { useFieldControl } from './field-context';
import styles from './toggles.module.css';

export type CheckboxProps = ComponentPropsWithRef<typeof RadixCheckbox.Root>;

/** Tri-state capable checkbox. Use inside <Field inline> for a label. */
export function Checkbox({ className, ...props }: CheckboxProps) {
  const fieldProps = useFieldControl(props);
  return (
    <RadixCheckbox.Root className={cx(styles.checkbox, className)} {...fieldProps}>
      <RadixCheckbox.Indicator className={styles.checkboxIndicator}>
        {props.checked === 'indeterminate' ? (
          <Minus aria-hidden="true" />
        ) : (
          <Check aria-hidden="true" />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
