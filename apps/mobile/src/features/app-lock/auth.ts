import type * as LocalAuthentication from 'expo-local-authentication';
import type { AppLockAuthOutcome } from './policy';

export type AppLockAuthProvider = {
  readonly authenticateAsync: (
    options: LocalAuthentication.LocalAuthenticationOptions,
  ) => Promise<LocalAuthentication.LocalAuthenticationResult>;
};

export type AppLockAuthService = {
  readonly authenticate: (promptMessage: string) => Promise<AppLockAuthOutcome>;
};

const productionProvider: AppLockAuthProvider = {
  authenticateAsync: async (options) => {
    const native = await import('expo-local-authentication');
    return native.authenticateAsync(options);
  },
};

function errorKind(error: unknown): AppLockAuthOutcome['kind'] {
  if (typeof error !== 'string') return 'failed';
  switch (error.toLowerCase()) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return 'cancelled';
    case 'lockout':
      return 'lockout';
    case 'not_available':
    case 'passcode_not_set':
      return 'unavailable';
    case 'not_enrolled':
    case 'invalid_context':
      return 'enrollment-changed';
    default:
      return 'failed';
  }
}

/**
 * LocalAuthentication creates a fresh system authentication context for each call. Calls are
 * serialized so an old system prompt cannot race a newer foreground attempt.
 */
export function createAppLockAuthService(
  provider: AppLockAuthProvider = productionProvider,
): AppLockAuthService {
  let inFlight: Promise<AppLockAuthOutcome> | null = null;

  return {
    authenticate(promptMessage) {
      if (inFlight !== null) return inFlight;
      const attempt = (async () => {
        try {
          const result = await provider.authenticateAsync({
            promptMessage,
            disableDeviceFallback: false,
          });
          if (result.success) return { kind: 'success' } as const;
          return { kind: errorKind(result.error) } as AppLockAuthOutcome;
        } catch (error) {
          return { kind: errorKind(error) } as AppLockAuthOutcome;
        }
      })();
      inFlight = attempt;
      void attempt.finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
      return attempt;
    },
  };
}
