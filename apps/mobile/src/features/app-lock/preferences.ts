import { APP_LOCK_GRACES, type AppLockGrace, type AppLockPreferences } from './policy';

export const APP_LOCK_ENABLED_PREFERENCE = 'app.app-lock.enabled';
export const APP_LOCK_GRACE_PREFERENCE = 'app.app-lock.grace';

export type AppLockPreferenceSource = {
  getLocalPreference(key: string): Promise<string | null>;
  setLocalPreference(key: string, value: string): Promise<void>;
};

export type AppLockPreferenceStore = {
  readonly read: () => Promise<AppLockPreferences>;
  readonly write: (preferences: AppLockPreferences) => Promise<void>;
};

function decodeBoolean(value: string | null): boolean {
  if (value === null) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('The app-lock enabled preference is malformed');
}

function decodeGrace(value: string | null): AppLockGrace {
  if (value === null) return 'immediate';
  if ((APP_LOCK_GRACES as readonly string[]).includes(value)) return value as AppLockGrace;
  throw new Error('The app-lock grace preference is malformed');
}

export function decodeAppLockPreferences(values: {
  readonly enabled: string | null;
  readonly grace: string | null;
}): AppLockPreferences {
  return { enabled: decodeBoolean(values.enabled), grace: decodeGrace(values.grace) };
}

export function createAppLockPreferenceStore(
  source: AppLockPreferenceSource,
): AppLockPreferenceStore {
  return {
    async read() {
      const [enabled, grace] = await Promise.all([
        source.getLocalPreference(APP_LOCK_ENABLED_PREFERENCE),
        source.getLocalPreference(APP_LOCK_GRACE_PREFERENCE),
      ]);
      return decodeAppLockPreferences({ enabled, grace });
    },
    async write(preferences) {
      await source.setLocalPreference(APP_LOCK_ENABLED_PREFERENCE, String(preferences.enabled));
      await source.setLocalPreference(APP_LOCK_GRACE_PREFERENCE, preferences.grace);
    },
  };
}
