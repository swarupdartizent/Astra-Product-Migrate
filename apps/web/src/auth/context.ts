import { createContext } from 'react';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

/** Why the last session ended, so the sign-in page can explain it. */
export type SessionEndReason = 'expired' | 'signed_out';

export interface AuthUser {
  /** OIDC subject. */
  sub: string;
  name: string | null;
  email: string | null;
}

export interface SignInOptions {
  /** Same-origin path to return to after sign-in. */
  returnTo?: string;
  /** Step-up: force a fresh, multi-factor sign-in (prompt=login plus configured acr_values). */
  mfa?: boolean;
  /** Force a fresh sign-in (prompt=login), e.g. after a tenant's session timeout. */
  fresh?: boolean;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  endReason: SessionEndReason | null;
  signIn: (options?: SignInOptions) => Promise<void>;
  signOut: () => Promise<void>;
  /** Completes the redirect sign-in; resolves to the path to return to. */
  completeSignIn: () => Promise<string>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
