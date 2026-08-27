import type { SessionResponse } from '@alyte/contracts';

export const CLOUD_SESSION_STORAGE_KEY = 'alyte.cloud.session.v1';

export type StoredCloudSession = Pick<
  SessionResponse,
  'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'refreshTokenExpiresAt'
>;

export type SecureStoreAdapter = {
  readonly getItemAsync: (key: string) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string) => Promise<void>;
  readonly deleteItemAsync: (key: string) => Promise<void>;
};

export type CloudSessionRepository = {
  readonly read: () => Promise<StoredCloudSession | null>;
  readonly write: (session: StoredCloudSession) => Promise<void>;
  readonly clear: () => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new Error(`Invalid cloud session ${field}`);
  }
  return value;
}

function sessionDate(value: unknown, field: string): string {
  const result = sessionText(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid cloud session ${field}`);
  return result;
}

export function decodeStoredCloudSession(value: string): StoredCloudSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid cloud session');
  }
  if (!isRecord(parsed)) throw new Error('Invalid cloud session');
  return {
    accessToken: sessionText(parsed.accessToken, 'access token'),
    refreshToken: sessionText(parsed.refreshToken, 'refresh token'),
    accessTokenExpiresAt: sessionDate(parsed.accessTokenExpiresAt, 'access expiry'),
    refreshTokenExpiresAt: sessionDate(parsed.refreshTokenExpiresAt, 'refresh expiry'),
  };
}

function encodeStoredCloudSession(session: StoredCloudSession): string {
  // Account identifiers and Apple identity data deliberately do not enter this document. The
  // only durable cloud state on the device is opaque app session material.
  return JSON.stringify({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
  });
}

const productionSecureStore: SecureStoreAdapter = {
  async getItemAsync(key) {
    const secureStore = await import('expo-secure-store');
    return secureStore.getItemAsync(key);
  },
  async setItemAsync(key, value) {
    const secureStore = await import('expo-secure-store');
    await secureStore.setItemAsync(key, value, {
      keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async deleteItemAsync(key) {
    const secureStore = await import('expo-secure-store');
    await secureStore.deleteItemAsync(key);
  },
};

export function createCloudSessionRepository(
  secureStore: SecureStoreAdapter = productionSecureStore,
): CloudSessionRepository {
  return {
    async read() {
      const value = await secureStore.getItemAsync(CLOUD_SESSION_STORAGE_KEY);
      if (value === null) return null;
      try {
        return decodeStoredCloudSession(value);
      } catch {
        // A malformed token envelope is not a recoverable signed-in state. Remove only this
        // credential record; local health storage is in a separate repository and untouched.
        await secureStore.deleteItemAsync(CLOUD_SESSION_STORAGE_KEY);
        return null;
      }
    },
    write(session) {
      return secureStore.setItemAsync(CLOUD_SESSION_STORAGE_KEY, encodeStoredCloudSession(session));
    },
    clear() {
      return secureStore.deleteItemAsync(CLOUD_SESSION_STORAGE_KEY);
    },
  };
}

export function storedSessionFromResponse(response: SessionResponse): StoredCloudSession {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    accessTokenExpiresAt: response.accessTokenExpiresAt,
    refreshTokenExpiresAt: response.refreshTokenExpiresAt,
  };
}
