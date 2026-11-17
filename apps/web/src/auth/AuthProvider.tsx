import { ErrorResponse, type User, type UserManager } from 'oidc-client-ts';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { configureApiAuth } from '@/api/client';
import { readOidcConfig, safeReturnTo } from './config';
import {
  AuthContext,
  type AuthContextValue,
  type AuthStatus,
  type AuthUser,
  type SessionEndReason,
  type SignInOptions,
} from './context';
import { getUserManager } from './userManager';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  endReason: SessionEndReason | null;
}

interface RedirectState {
  returnTo?: string;
}

const END_REASON_KEY = 'astra.auth.endReason';

function toAuthUser(user: User): AuthUser {
  const profile = user.profile;
  return {
    sub: profile.sub,
    name: profile.name ?? profile.preferred_username ?? null,
    email: profile.email ?? null,
  };
}

function takeStoredEndReason(): SessionEndReason | null {
  try {
    const value = window.sessionStorage.getItem(END_REASON_KEY);
    window.sessionStorage.removeItem(END_REASON_KEY);
    return value === 'signed_out' || value === 'expired' ? value : null;
  } catch {
    return null;
  }
}

function storeEndReason(reason: SessionEndReason): void {
  try {
    window.sessionStorage.setItem(END_REASON_KEY, reason);
  } catch {
    // Not critical: the sign-in page just won't explain why.
  }
}

/** One redirect callback per URL, even under StrictMode's double effects. */
const callbackResults = new Map<string, Promise<User>>();

export interface AuthProviderProps {
  children: ReactNode;
  /** Injected in tests; defaults to the app's OIDC UserManager. */
  userManager?: UserManager;
  /** Called whenever the session ends (sign-out or expiry), e.g. to clear cached data. */
  onSessionEnd?: () => void;
}

export function AuthProvider({ children, userManager, onSessionEnd }: AuthProviderProps) {
  const manager = useMemo(() => userManager ?? getUserManager(), [userManager]);
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    endReason: null,
  });

  const endingRef = useRef(false);
  const refreshRef = useRef<Promise<boolean> | null>(null);
  const onSessionEndRef = useRef(onSessionEnd);
  useEffect(() => {
    onSessionEndRef.current = onSessionEnd;
  }, [onSessionEnd]);

  const endSession = useCallback(
    async (reason: SessionEndReason) => {
      if (endingRef.current) return;
      endingRef.current = true;
      if (reason === 'expired') {
        toast.warning('Your session has expired', {
          id: 'session-expired',
          description: 'Sign in again to continue where you left off.',
        });
      }
      await manager.removeUser().catch(() => undefined);
      onSessionEndRef.current?.();
      setState({ status: 'unauthenticated', user: null, endReason: reason });
    },
    [manager],
  );

  // Restore an existing session and subscribe to token lifecycle events.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      let user = await manager.getUser().catch(() => null);
      if (user?.expired) {
        user = user.refresh_token ? await manager.signinSilent().catch(() => null) : null;
        if (!user) await manager.removeUser().catch(() => undefined);
      }
      if (cancelled) return;
      setState(
        user
          ? { status: 'authenticated', user: toAuthUser(user), endReason: null }
          : { status: 'unauthenticated', user: null, endReason: takeStoredEndReason() },
      );
    }
    void restore();

    const events = manager.events;
    const unsubscribe = [
      events.addUserLoaded((user) => {
        endingRef.current = false;
        setState({ status: 'authenticated', user: toAuthUser(user), endReason: null });
      }),
      events.addAccessTokenExpired(() => {
        void endSession('expired');
      }),
      events.addSilentRenewError((error) => {
        // The provider refused the refresh (session idle/max lifetime reached, revoked).
        // Transient network failures are left alone; token expiry will catch them.
        if (error instanceof ErrorResponse) void endSession('expired');
      }),
    ];
    return () => {
      cancelled = true;
      unsubscribe.forEach((off) => off());
    };
  }, [manager, endSession]);

  // Give the API client access to tokens and a way to report a rejected session.
  useEffect(
    () =>
      configureApiAuth({
        getAccessToken: async () =>
          (await manager.getUser().catch(() => null))?.access_token ?? null,
        refresh: () => {
          refreshRef.current ??= manager
            .signinSilent()
            .then((user) => user !== null)
            .catch(() => false)
            .finally(() => {
              refreshRef.current = null;
            });
          return refreshRef.current;
        },
        onUnauthorized: () => {
          void endSession('expired');
        },
      }),
    [manager, endSession],
  );

  const signIn = useCallback(
    async (options: SignInOptions = {}) => {
      const redirectState: RedirectState = { returnTo: safeReturnTo(options.returnTo ?? '/') };
      const { mfaAcrValues } = readOidcConfig();
      await manager.signinRedirect({
        state: redirectState,
        ...(options.mfa || options.fresh ? { prompt: 'login' } : {}),
        ...(options.mfa && mfaAcrValues ? { acr_values: mfaAcrValues } : {}),
      });
    },
    [manager],
  );

  const signOut = useCallback(async () => {
    endingRef.current = true;
    onSessionEndRef.current?.();
    storeEndReason('signed_out');
    try {
      // Ends the provider session too, then returns to /sign-in.
      await manager.signoutRedirect();
    } catch {
      // Provider unreachable: still end the local session.
      await manager.removeUser().catch(() => undefined);
      takeStoredEndReason();
      setState({ status: 'unauthenticated', user: null, endReason: 'signed_out' });
      toast.info('Signed out on this device', {
        description: 'The identity provider could not be reached to end its session.',
      });
    }
  }, [manager]);

  const completeSignIn = useCallback(async () => {
    const key = window.location.href;
    let pending = callbackResults.get(key);
    if (!pending) {
      pending = manager.signinRedirectCallback();
      callbackResults.set(key, pending);
    }
    const user = await pending;
    const redirectState = (user.state ?? {}) as RedirectState;
    return safeReturnTo(redirectState.returnTo);
  }, [manager]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, signIn, signOut, completeSignIn }),
    [state, signIn, signOut, completeSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
