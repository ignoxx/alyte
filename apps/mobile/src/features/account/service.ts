import {
  CONTRACT_VERSION,
  type CloudAllowanceResponse,
  type CloudReconcileResponse,
  type AccountExportResponse,
  type SessionResponse,
} from '@alyte/contracts';
import { CloudApiClient, CloudApiError, createIdempotencyKey, type CloudApi } from './cloud-api';
import {
  createCloudSessionRepository,
  createCloudPendingOperationRepository,
  storedSessionFromResponse,
  type CloudPendingOperation,
  type CloudPendingOperationRepository,
  type CloudSessionRepository,
  type StoredCloudSession,
} from './session';
import {
  createProtectedReportFileService,
  type ProtectedReportFileService,
} from '../labs/file-service';
import { createAppleNonce, type AppleNonceGenerator } from './apple-nonce';

export type AppleSignInProvider = {
  readonly isAvailable: () => Promise<boolean>;
  readonly signIn: (hashedNonce: string) => Promise<{ readonly identityToken: string | null }>;
};

const productionAppleProvider: AppleSignInProvider = {
  async isAvailable() {
    const apple = await import('expo-apple-authentication');
    return apple.isAvailableAsync();
  },
  async signIn(hashedNonce: string) {
    const apple = await import('expo-apple-authentication');
    const result = await apple.signInAsync({ requestedScopes: [], nonce: hashedNonce });
    return { identityToken: result.identityToken };
  },
};

export type CloudAccountStatus = 'signed-out' | 'restoring' | 'active' | 'offline' | 'working';

export type CloudAccountSnapshot = {
  readonly status: CloudAccountStatus;
  readonly signedIn: boolean;
  readonly accountId: string | null;
  readonly lastErrorCode: string | null;
  readonly pendingDeletion: boolean;
};

export type PreparedCloudAccountExport = {
  readonly account: AccountExportResponse;
  /** A protected, backup-excluded temporary file URL for the native share controller. */
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type CloudAccountService = {
  readonly bootstrap: () => Promise<void>;
  readonly getSnapshot: () => CloudAccountSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly isAppleSignInAvailable: () => Promise<boolean>;
  readonly signInWithApple: () => Promise<void>;
  readonly exportAccount: (signal?: AbortSignal) => Promise<AccountExportResponse>;
  readonly prepareAccountExport: (signal?: AbortSignal) => Promise<PreparedCloudAccountExport>;
  readonly signOut: () => Promise<void>;
  /** Clears only this device's optional cloud session and retry marker. It never calls the API. */
  readonly clearDeviceState: () => Promise<void>;
  readonly deleteAccount: (idempotencyKey?: string) => Promise<void>;
  readonly getAllowanceSummary: () => Promise<CloudAllowanceResponse>;
  readonly reconcileAllowances: () => Promise<CloudReconcileResponse>;
};

export type CloudAccountServiceOptions = {
  readonly repository?: CloudSessionRepository;
  readonly pendingOperations?: CloudPendingOperationRepository;
  readonly api?: CloudApi;
  readonly apple?: AppleSignInProvider;
  readonly nonceGenerator?: AppleNonceGenerator;
  readonly exportFiles?: CloudAccountExportFiles;
  readonly now?: () => number;
};

export type CloudAccountExportFiles = Pick<
  Required<ProtectedReportFileService>,
  'createExportWorkspace' | 'writeExportFile' | 'removeExportArtifacts'
>;

const ACCESS_REFRESH_SKEW_MS = 30_000;
const MAX_CLOUD_EXPORT_BYTES = 256 * 1024;

function isCloudApiError(error: unknown): error is CloudApiError {
  return error instanceof CloudApiError;
}

function isOfflineError(error: unknown): boolean {
  return (
    isCloudApiError(error) &&
    (error.code === 'offline' ||
      error.code === 'api_unconfigured' ||
      error.code === 'request_timeout')
  );
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
  const pendingOperations = options.pendingOperations ?? createCloudPendingOperationRepository();
  const api = options.api ?? new CloudApiClient({ requireHttps: true });
  const apple = options.apple ?? productionAppleProvider;
  const nonceGenerator = options.nonceGenerator ?? createAppleNonce;
  const exportFiles: CloudAccountExportFiles =
    options.exportFiles ?? (createProtectedReportFileService() as CloudAccountExportFiles);
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let session: StoredCloudSession | null = null;
  let accountId: string | null = null;
  let pendingDeletion: CloudPendingOperation | null = null;
  let snapshot: CloudAccountSnapshot = {
    status: 'signed-out',
    signedIn: false,
    accountId: null,
    lastErrorCode: null,
    pendingDeletion: false,
  };
  let bootstrapPromise: Promise<void> | null = null;
  let refreshPromise: Promise<string> | null = null;
  let signInPromise: Promise<void> | null = null;

  function publish(
    status: CloudAccountStatus,
    lastErrorCode: string | null = snapshot.lastErrorCode,
  ): void {
    snapshot = {
      status,
      signedIn: session !== null,
      accountId,
      lastErrorCode,
      pendingDeletion: pendingDeletion !== null,
    };
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

  async function clearDeviceState(): Promise<void> {
    session = null;
    accountId = null;
    pendingDeletion = null;
    let failure: unknown;
    try {
      await repository.clear();
    } catch (error) {
      failure = error;
    }
    try {
      await pendingOperations.clear();
    } catch (error) {
      failure ??= error;
    }
    publish('signed-out', failure === undefined ? null : 'session_storage_unavailable');
    if (failure !== undefined) throw failure;
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
          const code = errorCode(error);
          try {
            await clearDeviceSession();
          } catch {
            // The original authentication error remains the useful service result.
          }
          publish('signed-out', code);
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
        error.code === 'session_invalid' &&
        session !== null &&
        session.accessToken === accessToken
      ) {
        accessToken = await refreshStoredSession();
        try {
          return await operation(accessToken);
        } catch (retryError) {
          if (isOfflineError(retryError)) publish('offline', errorCode(retryError));
          throw retryError;
        }
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
        try {
          pendingDeletion = await pendingOperations.read();
        } catch {
          // A pending retry marker is advisory recovery state. A SecureStore read failure must
          // never prevent the account-free local app from opening.
          pendingDeletion = null;
        }
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
        const code = errorCode(error);
        if (isOfflineError(error) || isCancellation(error)) {
          publish('offline', code);
        } else {
          try {
            if (session !== null) await clearDeviceSession();
          } catch {
            // Keep local mode usable even when credential cleanup cannot be completed now.
          }
          publish('signed-out', code === 'unknown' ? 'session_storage_unavailable' : code);
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

  async function isAppleSignInAvailable(): Promise<boolean> {
    try {
      return await apple.isAvailable();
    } catch {
      return false;
    }
  }

  async function performSignInWithApple(): Promise<void> {
    publish('working', null);
    try {
      if (api.isConfigured !== undefined && !api.isConfigured()) {
        throw new CloudApiError(0, 'api_unconfigured');
      }
      if (!(await isAppleSignInAvailable())) throw new CloudApiError(0, 'apple_unavailable');
      let nonce;
      try {
        nonce = await nonceGenerator();
      } catch {
        throw new CloudApiError(0, 'nonce_unavailable');
      }
      let result: { readonly identityToken: string | null };
      try {
        result = await apple.signIn(nonce.hashedNonce);
      } catch (error) {
        if (isCancellation(error)) throw new CloudApiError(400, 'identity_cancelled');
        throw error;
      }
      if (result.identityToken === null || result.identityToken.length === 0) {
        throw new CloudApiError(400, 'identity_token_required');
      }
      const response = await api.exchangeApple(
        result.identityToken,
        nonce.rawNonce,
        createIdempotencyKey(),
      );
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

  function signInWithApple(): Promise<void> {
    if (signInPromise !== null) return signInPromise;
    const operation = performSignInWithApple();
    signInPromise = operation;
    void operation
      .finally(() => {
        if (signInPromise === operation) signInPromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async function exportAccount(signal?: AbortSignal): Promise<AccountExportResponse> {
    const result = await withAccess((accessToken) => api.exportAccount(accessToken, signal));
    accountId = result.accountId;
    publish('active', null);
    return result;
  }

  async function getAllowanceSummary(): Promise<CloudAllowanceResponse> {
    if (api.getAllowanceSummary === undefined) {
      throw new CloudApiError(503, 'cloud_allowances_unavailable');
    }
    const result = await withAccess((accessToken) => api.getAllowanceSummary!(accessToken));
    if (accountId !== null && result.accountId !== accountId) {
      throw new CloudApiError(502, 'account_mismatch');
    }
    accountId = result.accountId;
    publish('active', null);
    return result;
  }

  async function reconcileAllowances(): Promise<CloudReconcileResponse> {
    if (api.reconcileAllowances === undefined) {
      throw new CloudApiError(503, 'cloud_allowances_unavailable');
    }
    const result = await withAccess((accessToken) => api.reconcileAllowances!(accessToken));
    if (accountId !== null && result.accountId !== accountId) {
      throw new CloudApiError(502, 'account_mismatch');
    }
    accountId = result.accountId;
    publish('active', null);
    return result;
  }

  async function prepareAccountExport(signal?: AbortSignal): Promise<PreparedCloudAccountExport> {
    const account = await exportAccount(signal);
    const serialized = JSON.stringify({ contractVersion: CONTRACT_VERSION, account });
    if (serialized === undefined) throw new CloudApiError(502, 'invalid_response');
    if (new TextEncoder().encode(serialized).byteLength > MAX_CLOUD_EXPORT_BYTES) {
      throw new CloudApiError(502, 'export_too_large');
    }

    const workspace = await exportFiles.createExportWorkspace(
      `cloud-account-${createIdempotencyKey()}`,
    );
    try {
      const artifact = await exportFiles.writeExportFile(
        workspace,
        'account-metadata.json',
        serialized,
      );
      let cleanupPromise: Promise<void> | null = null;
      const cleanup = (): Promise<void> => {
        cleanupPromise ??= exportFiles.removeExportArtifacts(workspace);
        return cleanupPromise;
      };
      return { account, path: artifact.path, cleanup };
    } catch (error) {
      await exportFiles.removeExportArtifacts(workspace).catch(() => undefined);
      throw error;
    }
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

  async function deleteAccount(idempotencyKey?: string): Promise<void> {
    if (session === null) throw new CloudApiError(401, 'session_required');
    const operationKey =
      pendingDeletion?.idempotencyKey ?? idempotencyKey ?? createIdempotencyKey();
    const nextPending: CloudPendingOperation = {
      kind: 'account-delete',
      idempotencyKey: operationKey,
      createdAt: new Date(now()).toISOString(),
    };
    try {
      await pendingOperations.write(nextPending);
      pendingDeletion = nextPending;
    } catch (error) {
      publish('active', 'session_storage_unavailable');
      throw error;
    }
    publish('working', null);
    try {
      const response = await withAccess((accessToken) =>
        api.deleteAccount(accessToken, operationKey),
      );
      if (response.deleted !== true) throw new CloudApiError(502, 'invalid_response');
      try {
        await clearDeviceSession();
      } finally {
        pendingDeletion = null;
        await pendingOperations.clear();
        publish('signed-out', null);
      }
    } catch (error) {
      publish(
        session === null ? 'signed-out' : isOfflineError(error) ? 'offline' : 'active',
        errorCode(error),
      );
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
    isAppleSignInAvailable,
    exportAccount,
    prepareAccountExport,
    signOut,
    clearDeviceState,
    deleteAccount,
    getAllowanceSummary,
    reconcileAllowances,
  };
}

export { CONTRACT_VERSION };
