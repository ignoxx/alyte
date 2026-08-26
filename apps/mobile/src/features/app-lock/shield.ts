import { requireOptionalNativeModule } from 'expo-modules-core';

export type SnapshotShieldBridge = {
  readonly clear: () => Promise<void>;
  readonly isInstalled: () => Promise<boolean>;
  /**
   * Explicitly tells native that an opaque React startup/lock surface is mounted. Native may
   * continue to shield the app until this handoff has happened.
   */
  readonly markReactGateMounted: () => void;
};

type NativeSnapshotShield = {
  readonly clearSnapshotShield: () => boolean | undefined;
  readonly isSnapshotShieldInstalled: () => boolean;
  readonly markReactGateMounted: () => void;
};

function nativeModule(): NativeSnapshotShield | null {
  return requireOptionalNativeModule<NativeSnapshotShield>('AlyteProtection');
}

/** The JS boundary intentionally cannot install the shield; native lifecycle owns installation. */
export const nativeSnapshotShield: SnapshotShieldBridge = {
  markReactGateMounted() {
    // A missing protection module is handled by the existing fail-closed persistence/app-lock
    // paths. There is no native shield to clear in Expo Go, so the handoff itself is a no-op.
    try {
      nativeModule()?.markReactGateMounted();
    } catch {
      // Keep startup effects from throwing if a stale/malformed native module is present. The
      // subsequent clear remains rejected, so the controller stays behind its neutral gate.
    }
  },
  async clear() {
    const native = nativeModule();
    if (!native) throw new Error('Alyte native privacy shield is unavailable');
    const result = native.clearSnapshotShield();
    // The native method returns false when the app is inactive or React has not acknowledged the
    // opaque gate yet. Verify the postcondition so a stale controller cannot publish "unlocked"
    // while the opaque shield is still covering the app.
    if (result === false || native.isSnapshotShieldInstalled()) {
      throw new Error('Alyte native privacy shield is still installed');
    }
  },
  async isInstalled() {
    const native = nativeModule();
    if (!native) throw new Error('Alyte native privacy shield is unavailable');
    return native.isSnapshotShieldInstalled();
  },
};
