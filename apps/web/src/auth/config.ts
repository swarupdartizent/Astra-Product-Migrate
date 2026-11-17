/** OIDC settings, read from Vite env with local-stack defaults. All values are public. */
export interface OidcConfig {
  authority: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** acr_values sent on step-up sign-in when the API demands multi-factor authentication. */
  mfaAcrValues: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

export function readOidcConfig(): OidcConfig {
  const env = import.meta.env;
  const origin = window.location.origin;
  return {
    authority: nonEmpty(env.VITE_OIDC_AUTHORITY) ?? 'http://localhost:18080/realms/astra',
    clientId: nonEmpty(env.VITE_OIDC_CLIENT_ID) ?? 'astra-web',
    redirectUri: nonEmpty(env.VITE_OIDC_REDIRECT_URI) ?? `${origin}/auth/callback`,
    postLogoutRedirectUri: `${origin}/sign-in`,
    mfaAcrValues: nonEmpty(env.VITE_OIDC_MFA_ACR_VALUES),
  };
}

/** Only same-origin, absolute paths are accepted as post-sign-in destinations. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.startsWith('/auth/callback') || value.startsWith('/sign-in')) return '/';
  return value;
}
