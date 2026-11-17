import * as RadixSwitch from '@radix-ui/react-switch';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '@/lib/cx';
import { useFieldControl } from './field-context';
import styles from './toggles.module.css';

export type SwitchProps = ComponentPropsWithRef<typeof RadixSwitch.Root>;

/** On/off setting that applies immediately. Use inside <Field inline> for a label. */
export function Switch({ className, ...props }: SwitchProps) {
  const fieldProps = useFieldControl(props);
  return (
    <RadixSwitch.Root className={cx(styles.switch, className)} {...fieldProps}>
      <RadixSwitch.Thumb className={styles.thumb} />
    </RadixSwitch.Root>
  );
}
