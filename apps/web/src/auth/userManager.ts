import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { readOidcConfig } from './config';

let instance: UserManager | null = null;

/**
 * Authorization Code + PKCE against the configured OIDC provider. Tokens live in
 * sessionStorage (cleared when the tab closes). Silent renew uses the refresh token, so no
 * hidden iframe or third-party cookies are needed.
 */
export function getUserManager(): UserManager {
  if (instance) return instance;
  const config = readOidcConfig();
  instance = new UserManager({
    authority: config.authority,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 60,
    monitorSession: false,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
  return instance;
}
