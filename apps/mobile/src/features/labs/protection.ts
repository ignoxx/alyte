import { ProtectionError, protectionFailureCategory } from '../local-database/protection';

export type {
  DatabaseProtection,
  ProtectionOptions,
  ProtectionReport,
} from '../local-database/protection';
export { nativeDatabaseProtection, ProtectionError } from '../local-database/protection';

export type ProtectedPathReport = {
  readonly protectedPaths: readonly string[];
};

export interface ProtectedPathProtection {
  protectPath(path: string): Promise<ProtectedPathReport>;
  hashFile(path: string): Promise<string>;
}

/**
 * The same narrow native boundary protects Original Reports and derives their immutable hash.
 * There is deliberately no JavaScript fallback: an unavailable native module is an unsafe state
 * for health-content persistence.
 */
export const nativePathProtection: ProtectedPathProtection = {
  async protectPath(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<ProtectedPathProtection>('AlyteProtection');
    if (native === null) {
      throw new ProtectionError(
        'AlyteProtection is unavailable; local health files cannot be persisted safely',
      );
    }
    let report: ProtectedPathReport;
    try {
      report = await native.protectPath(path);
    } catch (error) {
      throw new ProtectionError('The local health file could not be protected', {
        cause: error,
        category: protectionFailureCategory(error),
      });
    }
    const normalizedPath = path.replace(/^file:\/\//, '');
    if (
      !Array.isArray(report.protectedPaths) ||
      (!report.protectedPaths.includes(path) && !report.protectedPaths.includes(normalizedPath))
    ) {
      throw new ProtectionError('AlyteProtection did not verify the local health file');
    }
    return report;
  },
  async hashFile(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<ProtectedPathProtection>('AlyteProtection');
    if (native === null) {
      throw new ProtectionError(
        'AlyteProtection is unavailable; local health files cannot be verified safely',
      );
    }
    let hash: string;
    try {
      hash = await native.hashFile(path);
    } catch (error) {
      throw new ProtectionError('The local health file could not be hashed', {
        cause: error,
        category: protectionFailureCategory(error),
      });
    }
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new ProtectionError('AlyteProtection returned an invalid source hash');
    }
    return hash;
  },
};
