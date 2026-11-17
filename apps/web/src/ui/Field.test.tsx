import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './Field';
import { Input } from './Input';
import { Switch } from './Switch';

describe('Field', () => {
  it('links label, help and error to the control', () => {
    render(
      <Field label="Tenant name" help="Shown to all users." error="Name is required" required>
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /Tenant name/ });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Shown to all users. Name is required');
  });

  it('is valid when there is no error', () => {
    render(
      <Field label="Region">
        <Input />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Region' })).not.toHaveAttribute('aria-invalid');
  });

  it('labels inline toggles', () => {
    render(
      <Field label="Enable notifications" inline>
        <Switch />
      </Field>,
    );
    expect(screen.getByRole('switch', { name: 'Enable notifications' })).toBeInTheDocument();
  });
});
