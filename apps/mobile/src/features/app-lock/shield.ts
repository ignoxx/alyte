export type SnapshotShieldBridge = {
  readonly clear: () => Promise<void>;
  readonly isInstalled: () => Promise<boolean>;
};

type NativeSnapshotShield = {
  readonly clearSnapshotShield: () => void;
  readonly isSnapshotShieldInstalled: () => boolean;
};

/** The JS boundary intentionally cannot install the shield; native lifecycle owns installation. */
export const nativeSnapshotShield: SnapshotShieldBridge = {
  async clear() {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeSnapshotShield>('AlyteProtection');
    if (!native) throw new Error('Alyte native privacy shield is unavailable');
    native.clearSnapshotShield();
  },
  async isInstalled() {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeSnapshotShield>('AlyteProtection');
    if (!native) throw new Error('Alyte native privacy shield is unavailable');
    return native.isSnapshotShieldInstalled();
  },
};
