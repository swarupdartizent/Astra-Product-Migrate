import { useState } from 'react';
import { useInviteUser } from '@/api/access';
import type { User } from '@/api/types';
import { FormDialog } from '@/app/FormDialog';
import { hasErrors, mergeFieldErrors, type FieldErrors } from '@/lib/forms';
import { Field, Input, toast } from '@/ui';

interface InviteForm {
  email: string;
  display_name: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteUserDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (user: User) => void;
}) {
  const invite = useInviteUser();
  const [form, setForm] = useState<InviteForm>({ email: '', display_name: '' });
  const [submitted, setSubmitted] = useState(false);
  const clientErrors: FieldErrors<keyof InviteForm> = {};
  if (!EMAIL.test(form.email.trim())) clientErrors.email = 'Enter a valid email address.';
  const n = form.display_name.trim().length;
  if (n < 2 || n > 200) clientErrors.display_name = 'Use 2–200 characters.';
  const errors = mergeFieldErrors(clientErrors, invite.error, submitted);

  function set(key: keyof InviteForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (invite.error) invite.reset();
  }

  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Invite a person"
      description="Registers the person by email so you can grant roles now. Their account links on first sign-in, once their identity provider confirms the email address. No email is sent."
      submitLabel="Invite"
      pending={invite.isPending}
      error={invite.error}
      fields={['email', 'display_name']}
      onSubmit={() => {
        setSubmitted(true);
        if (hasErrors(clientErrors)) return;
        invite.mutate(
          { email: form.email.trim(), display_name: form.display_name.trim() },
          {
            onSuccess: (user) => {
              toast.success(`${user.display_name} invited`, {
                description: 'Grant them a role so they can do something after signing in.',
              });
              onClose();
              onInvited(user);
            },
          },
        );
      }}
    >
      <Field label="Email" error={errors.email} required>
        <Input
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Name"
        help="Replaced by the name from their identity provider when they sign in."
        error={errors.display_name}
        required
      >
        <Input
          value={form.display_name}
          onChange={(e) => set('display_name', e.target.value)}
          autoComplete="off"
          maxLength={200}
        />
      </Field>
    </FormDialog>
  );
}
