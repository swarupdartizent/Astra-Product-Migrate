import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/errors';
import { renderWithProviders } from '@/test/utils';
import { ApiErrorView } from './ApiErrorView';

describe('ApiErrorView', () => {
  it('offers a multi-factor step-up sign-in for mfa-required problems', async () => {
    const error = new ApiError({
      type: 'https://astra.example.test/problems/mfa-required',
      title: 'Multi-factor authentication required',
      status: 403,
      detail: null,
    });
    const { auth } = renderWithProviders(<ApiErrorView error={error} />);

    expect(
      screen.getByRole('heading', { name: 'Multi-factor sign-in required' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with multi-factor' }));
    expect(auth.signIn).toHaveBeenCalledWith(expect.objectContaining({ mfa: true }));
  });

  it('shows permission denied for other 403s, without retry', () => {
    const error = new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    renderWithProviders(<ApiErrorView error={error} onRetry={() => undefined} />);
    expect(
      screen.getByRole('heading', { name: "You don't have permission to view this" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('explains an unreachable API and offers retry', () => {
    renderWithProviders(
      <ApiErrorView error={ApiError.network(new TypeError('x'))} onRetry={() => undefined} />,
    );
    expect(
      screen.getByRole('heading', { name: 'Cannot reach the Astra Migrate API' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
