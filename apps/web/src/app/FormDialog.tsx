import { useId, type ReactNode, type SyntheticEvent } from 'react';
import { Button, Dialog, DialogBody, DialogContent, DialogFooter } from '@/ui';
import { FormError } from './FormError';

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  submitLabel: string;
  /** Submit handler; the default form submission is already prevented. */
  onSubmit: () => void;
  pending: boolean;
  /** Error from the last submit (ApiError or other). */
  error?: unknown;
  /** Field names rendered inline, so FormError does not repeat them. */
  fields?: readonly string[];
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Shown above the footer while the request runs (e.g. what is being built). */
  progress?: ReactNode;
  children: ReactNode;
}

/** Modal form with consistent footer, pending state and error reporting. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  pending,
  error,
  fields,
  tone = 'default',
  size = 'md',
  progress,
  children,
}: FormDialogProps) {
  const formId = useId();
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) onSubmit();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        title={title}
        {...(description ? { description } : {})}
        size={size}
        dismissible={!pending}
      >
        <form id={formId} onSubmit={submit} noValidate>
          <DialogBody>
            {children}
            <FormError error={error} {...(fields ? { fields } : {})} />
            {pending && progress ? (
              <div role="status" aria-live="polite">
                {progress}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={pending}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
