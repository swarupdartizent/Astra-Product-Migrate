import { createContext, useContext, type AriaAttributes } from 'react';

export interface FieldContextValue {
  controlId: string;
  labelId: string;
  helpId: string | undefined;
  errorId: string | undefined;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldControlProps {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  required?: boolean | undefined;
  disabled?: boolean | undefined;
}

/**
 * Merges Field-provided accessibility wiring (id, aria-describedby, aria-invalid, required)
 * into a control's own props. Explicit props on the control always win.
 */
export function useFieldControl<P extends FieldControlProps>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy =
    [props['aria-describedby'], field.helpId, field.errorId].filter(Boolean).join(' ') || undefined;
  return {
    ...props,
    id: props.id ?? field.controlId,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid || undefined),
    required: props.required ?? (field.required || undefined),
    disabled: props.disabled ?? (field.disabled || undefined),
  };
}
