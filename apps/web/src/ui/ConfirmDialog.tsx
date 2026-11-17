import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button } from './Button';
import { Dialog, DialogBody, DialogContent, DialogFooter } from './Dialog';
import { Field } from './Field';
import { Input } from './Input';
import { Mono } from './Mono';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** What will happen, stated plainly (and whether it can be undone). */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" for destructive actions. */
  tone?: 'default' | 'danger';
  /**
   * Typed confirmation: the user must type this exact text (e.g. the tenant name) before the
   * confirm button enables. Use for irreversible, high-impact actions.
   */
  confirmationText?: string;
  /** Runs on confirm. Dialog stays open with a spinner until it settles; closes on success. */
  onConfirm: () => void | Promise<void>;
  /** Extra content between the description and the footer. */
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  confirmationText,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const matches = confirmationText === undefined || typed === confirmationText;

  function handleOpenChange(next: boolean) {
    if (pending) return;
    if (!next) {
      setTyped('');
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setTyped('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action failed. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent title={title} description={description} size="sm" dismissible={!pending}>
        <form id={formId} onSubmit={(event) => void submit(event)}>
          {children || confirmationText !== undefined || error ? (
            <DialogBody>
              {children}
              {confirmationText !== undefined ? (
                <Field
                  label={
                    <>
                      Type <Mono chip>{confirmationText}</Mono> to confirm
                    </>
                  }
                  error={error ?? undefined}
                >
                  <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={pending}
                  />
                </Field>
              ) : error ? (
                <p role="alert" style={{ color: 'var(--color-danger-text)' }}>
                  {error}
                </p>
              ) : null}
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === 'danger' ? 'danger' : 'primary'}
              disabled={!matches}
              loading={pending}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
