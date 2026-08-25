import { APP_LOCK_GRACES, type AppLockGrace, type AppLockPreferences } from './policy';

/** One typed value keeps enabled and grace changes atomic in app_preferences. */
export const APP_LOCK_POLICY_PREFERENCE = 'app.app-lock.policy';

export type AppLockPreferenceSource = {
  getLocalPreference(key: string): Promise<string | null>;
  setLocalPreference(key: string, value: string): Promise<void>;
};

export type AppLockPreferenceStore = {
  readonly read: () => Promise<AppLockPreferences>;
  readonly write: (preferences: AppLockPreferences) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePolicyDocument(value: string): AppLockPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The app-lock policy preference is malformed');
  }
  if (!isRecord(parsed)) throw new Error('The app-lock policy preference is malformed');
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'enabled' || keys[1] !== 'grace') {
    throw new Error('The app-lock policy preference is malformed');
  }
  if (typeof parsed.enabled !== 'boolean' || typeof parsed.grace !== 'string') {
    throw new Error('The app-lock policy preference is malformed');
  }
  if (!(APP_LOCK_GRACES as readonly string[]).includes(parsed.grace)) {
    throw new Error('The app-lock policy preference is malformed');
  }
  return { enabled: parsed.enabled, grace: parsed.grace as AppLockGrace };
}

export function decodeAppLockPreferences(value: string | null): AppLockPreferences {
  if (value === null) return { enabled: false, grace: 'immediate' };
  return decodePolicyDocument(value);
}

function encodePolicyDocument(preferences: AppLockPreferences): string {
  return JSON.stringify({ enabled: preferences.enabled, grace: preferences.grace });
}

export function createAppLockPreferenceStore(
  source: AppLockPreferenceSource,
): AppLockPreferenceStore {
  return {
    async read() {
      return decodeAppLockPreferences(await source.getLocalPreference(APP_LOCK_POLICY_PREFERENCE));
    },
    async write(preferences) {
      await source.setLocalPreference(
        APP_LOCK_POLICY_PREFERENCE,
        encodePolicyDocument(preferences),
      );
    },
  };
}
