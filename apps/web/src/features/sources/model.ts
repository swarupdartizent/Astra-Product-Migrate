import type { SourceEngine } from '@/api/types';
import type { FieldErrors } from '@/lib/forms';

export interface ConnForm {
  name: string;
  adapter: string;
  engine: SourceEngine | '';
  host: string;
  port: string;
  database: string;
  username: string;
  password_ref: string;
  encrypt: boolean;
}

export function validateConnection(f: ConnForm): FieldErrors<keyof ConnForm> {
  const e: FieldErrors<keyof ConnForm> = {};
  if (!/^[a-z][a-z0-9-]{2,99}$/.test(f.name))
    e.name = 'Use 3–100 lowercase letters, digits and hyphens, starting with a letter.';
  if (!f.adapter) e.adapter = 'Choose a published source adapter.';
  if (!f.engine) e.engine = 'Choose the engine.';
  if (!f.host.trim()) e.host = 'Enter the host.';
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    e.port = 'Use a port between 1 and 65535.';
  if (!f.database.trim()) e.database = 'Enter the database.';
  if (!f.username.trim()) e.username = 'Enter the read-only account.';
  if (!/^secret:\/\/.+/.test(f.password_ref))
    e.password_ref = 'Choose the secret that holds the password.';
  return e;
}
