import {
  CONTRACT_VERSION,
  type AccountExportResponse,
  type SessionResponse,
} from '@alyte/contracts';
import { CloudApiClient, CloudApiError, createIdempotencyKey, type CloudApi } from './cloud-api';
import {
  createCloudSessionRepository,
  storedSessionFromResponse,
  type CloudSessionRepository,
  type StoredCloudSession,
} from './session';

export type AppleSignInProvider = {
  readonly isAvailable: () => Promise<boolean>;
  readonly signIn: () => Promise<{ readonly identityToken: string | null }>;
};

const productionAppleProvider: AppleSignInProvider = {
  async isAvailable() {
    const apple = await import('expo-apple-authentication');
    return apple.isAvailableAsync();
  },
  async signIn() {
    const apple = await import('expo-apple-authentication');
    const result = await apple.signInAsync({ requestedScopes: [] });
    return { identityToken: result.identityToken };
  },
};

export type CloudAccountStatus = 'signed-out' | 'restoring' | 'active' | 'offline' | 'working';

export type CloudAccountSnapshot = {
  readonly status: CloudAccountStatus;
  readonly signedIn: boolean;
  readonly accountId: string | null;
  readonly lastErrorCode: string | null;
};

export type CloudAccountService = {
  readonly bootstrap: () => Promise<void>;
  readonly getSnapshot: () => CloudAccountSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly signInWithApple: () => Promise<void>;
  readonly exportAccount: (signal?: AbortSignal) => Promise<AccountExportResponse>;
  readonly signOut: () => Promise<void>;
  readonly deleteAccount: (idempotencyKey?: string) => Promise<void>;
};

export type CloudAccountServiceOptions = {
  readonly repository?: CloudSessionRepository;
  readonly api?: CloudApi;
  readonly apple?: AppleSignInProvider;
  readonly now?: () => number;
};

const ACCESS_REFRESH_SKEW_MS = 30_000;

function isCloudApiError(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError;
}

function isOfflineError(error: unknown): boolean {
  return isCloudApiError(error) && (error.code === 'offline' || error.code === 'api_unconfigured');
}

function isCancellation(error: unknown): boolean {
  if (isCloudApiError(error)) return error.code === 'request_cancelled';
  if (error instanceof Error && /cancel/i.test(error.message)) return true;
  if (!isRecord(error)) return false;
  const code = error.code;
  return typeof code === 'string' && /cancel/i.test(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExpired(isoDate: string, now: number, skew = 0): boolean {
  const time = Date.parse(isoDate);
  return !Number.isFinite(time) || time <= now + skew;
}

function toStoredSession(response: SessionResponse) {
  return storedSessionFromResponse(response);
}

/**
 * Coordinates optional cloud identity without owning any local health records. The repository is a
 * deliberately tiny SecureStore boundary, while all server responses are already decoded by the
 * HTTP adapter before they reach this service.
 */
export function createCloudAccountService(
  options: CloudAccountServiceOptions = {},
): CloudAccountService {
  const repository = options.repository ?? createCloudSessionRepository();
  const api = options.api ?? new CloudApiClient();
  const apple = options.apple ?? productionAppleProvider;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let session: StoredCloudSession | null = null;
  let accountId: string | null = null;
  let snapshot: CloudAccountSnapshot = {
    status: 'signed-out',
    signedIn: false,
    accountId: null,
    lastErrorCode: null,
  };
  let bootstrapPromise: Promise<void> | null = null;
  let refreshPromise: Promise<string> | null = null;

  function publish(
    status: CloudAccountStatus,
    lastErrorCode: string | null = snapshot.lastErrorCode,
  ): void {
    snapshot = { status, signedIn: session !== null, accountId, lastErrorCode };
    listeners.forEach((listener) => listener());
  }

  function errorCode(error: unknown): string {
    return isCloudApiError(error) ? error.code : 'unknown';
  }

  async function clearDeviceSession(): Promise<void> {
    const previous = session;
    session = null;
    accountId = null;
    try {
      await repository.clear();
    } catch (error) {
      // Keep the in-memory boundary closed even if the Keychain adapter is temporarily unavailable.
      // The next launch will fail closed when it cannot read a valid session envelope.
      publish('signed-out', 'session_storage_unavailable');
      throw error;
    }
    if (previous !== null || snapshot.status !== 'signed-out') publish('signed-out', null);
  }

  async function refreshStoredSession(): Promise<string> {
    if (session === null) throw new CloudApiError(401, 'session_required');
    if (hasExpired(session.refreshTokenExpiresAt, now())) {
      await clearDeviceSession();
      throw new CloudApiError(401, 'refresh_token_expired');
    }
    if (refreshPromise !== null) return refreshPromise;
    const current = session;
    const operation = (async () => {
      try {
        const response = await api.refresh(current.refreshToken, createIdempotencyKey());
        const next = toStoredSession(response);
        await repository.write(next);
        session = next;
        accountId = response.accountId;
        publish('active', null);
        return next.accessToken;
      } catch (error) {
        if (!isOfflineError(error) && !isCancellation(error)) {
          try {
            await clearDeviceSession();
          } catch {
            // The original authentication error remains the useful service result.
          }
        } else if (isCancellation(error)) {
          publish(session === null ? 'signed-out' : 'active', errorCode(error));
        } else {
          publish('offline', errorCode(error));
        }
        throw error;
      }
    })();
    refreshPromise = operation;
    void operation
      .then(undefined, () => undefined)
      .then(() => {
        if (refreshPromise === operation) refreshPromise = null;
      });
    return operation;
  }

  async function validAccessToken(): Promise<string> {
    if (session === null) throw new CloudApiError(401, 'session_required');
    if (!hasExpired(session.accessTokenExpiresAt, now(), ACCESS_REFRESH_SKEW_MS)) {
      return session.accessToken;
    }
    return refreshStoredSession();
  }

  async function withAccess<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    let accessToken = await validAccessToken();
    try {
      const result = await operation(accessToken);
      if (snapshot.status === 'offline') publish('active', null);
      return result;
    } catch (error) {
      if (
        isCloudApiError(error) &&
        error.status === 401 &&
        session !== null &&
        session.accessToken === accessToken
      ) {
        accessToken = await refreshStoredSession();
        return operation(accessToken);
      }
      if (isOfflineError(error)) publish('offline', errorCode(error));
      throw error;
    }
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapPromise !== null) return bootstrapPromise;
    if (session !== null) return;
    publish('restoring', null);
    const operation = (async () => {
      try {
        const stored = await repository.read();
        if (stored === null) {
          publish('signed-out', null);
          return;
        }
        session = stored;
        accountId = null;
        if (hasExpired(stored.accessTokenExpiresAt, now(), ACCESS_REFRESH_SKEW_MS)) {
          await refreshStoredSession();
        } else {
          publish('active', null);
        }
      } catch (error) {
        if (isOfflineError(error) || isCancellation(error)) {
          publish('offline', errorCode(error));
        } else if (session !== null) {
          try {
            await clearDeviceSession();
          } catch {
            // Keep local mode usable even when credential cleanup cannot be completed now.
          }
          publish('signed-out', errorCode(error));
        } else {
          publish('signed-out', 'session_storage_unavailable');
        }
      }
    })();
    bootstrapPromise = operation;
    void operation
      .then(undefined, () => undefined)
      .then(() => {
        if (bootstrapPromise === operation) bootstrapPromise = null;
      });
    return operation;
  }

  async function signInWithApple(): Promise<void> {
    publish('working', null);
    try {
      if (!(await apple.isAvailable())) throw new CloudApiError(0, 'apple_unavailable');
      let result: { readonly identityToken: string | null };
      try {
        result = await apple.signIn();
      } catch (error) {
        if (isCancellation(error)) throw new CloudApiError(400, 'identity_cancelled');
        throw error;
      }
      if (result.identityToken === null || result.identityToken.length === 0) {
        throw new CloudApiError(400, 'identity_token_required');
      }
      const response = await api.exchangeApple(result.identityToken, createIdempotencyKey());
      const next = toStoredSession(response);
      await repository.write(next);
      session = next;
      accountId = response.accountId;
      publish('active', null);
    } catch (error) {
      if (isCancellation(error)) {
        publish(session === null ? 'signed-out' : 'active', 'identity_cancelled');
      } else if (isOfflineError(error)) {
        publish(session === null ? 'signed-out' : 'offline', errorCode(error));
      } else {
        publish(session === null ? 'signed-out' : 'active', errorCode(error));
      }
      throw error;
    }
  }

  async function exportAccount(signal?: AbortSignal): Promise<AccountExportResponse> {
    const result = await withAccess((accessToken) => api.exportAccount(accessToken, signal));
    accountId = result.accountId;
    publish('active', null);
    return result;
  }

  async function signOut(): Promise<void> {
    const current = session;
    if (current === null) {
      await clearDeviceSession();
      return;
    }
    publish('working', null);
    const operationKey = createIdempotencyKey();
    let failure: unknown;
    try {
      await withAccess((accessToken) => api.signOut(accessToken, operationKey));
    } catch (error) {
      failure = error;
    } finally {
      try {
        await clearDeviceSession();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  async function deleteAccount(idempotencyKey = createIdempotencyKey()): Promise<void> {
    if (session === null) throw new CloudApiError(401, 'session_required');
    publish('working', null);
    try {
      await withAccess((accessToken) => api.deleteAccount(accessToken, idempotencyKey));
      await clearDeviceSession();
    } catch (error) {
      publish(isOfflineError(error) ? 'offline' : 'active', errorCode(error));
      throw error;
    }
  }

  return {
    bootstrap,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    signInWithApple,
    exportAccount,
    signOut,
    deleteAccount,
  };
}

export { CONTRACT_VERSION };
