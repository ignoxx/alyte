export type ProtectionReport = {
  readonly protectedPaths: readonly string[];
  readonly missingSidecarPaths: readonly string[];
};

export type ProtectionOptions = {
  /** Missing WAL/SHM files are tolerated only during first-open preparation. */
  readonly requireSidecars?: boolean;
};

export type ProtectedPathReport = {
  readonly protectedPaths: readonly string[];
};

export interface ProtectedPathProtection {
  protectPath(path: string): Promise<ProtectedPathReport>;
  hashFile(path: string): Promise<string>;
}

export class ProtectionError extends Error {
  override readonly name = 'ProtectionError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface DatabaseProtection {
  protectDatabaseFiles(
    databasePath: string,
    options?: ProtectionOptions,
  ): Promise<ProtectionReport>;
}

/**
 * The native module is deliberately optional at import time so pure repository tests can run in
 * Node. A missing module is an unsafe persistence state, not permission to continue unprotected.
 */
export const nativeDatabaseProtection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath, options = {}) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<DatabaseProtection>('AlyteProtection');
    if (native === null) {
      throw new ProtectionError(
        'AlyteProtection is unavailable; local health records cannot be persisted safely',
      );
    }

    let report: ProtectionReport;
    try {
      report = await native.protectDatabaseFiles(databasePath, options);
    } catch (error) {
      throw new ProtectionError('The local database could not be protected', { cause: error });
    }

    if (!Array.isArray(report.protectedPaths) || !Array.isArray(report.missingSidecarPaths)) {
      throw new ProtectionError('AlyteProtection returned an invalid protection report');
    }
    const normalizedDatabasePath = databasePath.replace(/^file:\/\//, '');
    const protectedPrimary =
      report.protectedPaths.includes(databasePath) ||
      report.protectedPaths.includes(normalizedDatabasePath);
    if (!protectedPrimary) {
      throw new ProtectionError('The primary local database file was not protected');
    }
    if (options.requireSidecars ?? true) {
      const protectedSidecars = [
        `${normalizedDatabasePath}-wal`,
        `${normalizedDatabasePath}-shm`,
      ].every((path) => report.protectedPaths.includes(path));
      if (!protectedSidecars || report.missingSidecarPaths.length > 0) {
        throw new ProtectionError('SQLite WAL and SHM sidecars were not protected');
      }
    }
    return report;
  },
};

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
      throw new ProtectionError('The local health file could not be protected', { cause: error });
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
      throw new ProtectionError('The local health file could not be hashed', { cause: error });
    }
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new ProtectionError('AlyteProtection returned an invalid source hash');
    }
    return hash;
  },
};
