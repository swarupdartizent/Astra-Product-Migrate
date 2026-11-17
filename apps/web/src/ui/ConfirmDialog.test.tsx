import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('requires the exact confirmation text before a destructive action', async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        tone="danger"
        title="Delete tenant"
        description="This permanently deletes the tenant and its data. It cannot be undone."
        confirmLabel="Delete tenant"
        confirmationText="acme-test"
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Delete tenant' });
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);

    const confirm = screen.getByRole('button', { name: 'Delete tenant' });
    expect(confirm).toBeDisabled();

    const input = screen.getByRole('textbox', { name: /Type acme-test to confirm/ });
    await userEvent.type(input, 'acme-tes');
    expect(confirm).toBeDisabled();
    await userEvent.type(input, 't');
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('keeps the dialog open and shows the error when the action fails', async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Revoke access"
        description="The user loses access immediately."
        onConfirm={() => Promise.reject(new Error('The API refused the request.'))}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The API refused the request.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
