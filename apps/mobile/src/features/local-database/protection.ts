export type ProtectionReport = {
  readonly protectedPaths: readonly string[];
  readonly missingSidecarPaths: readonly string[];
};

export type ProtectionOptions = {
  /** Missing WAL/SHM files are tolerated only during first-open preparation. */
  readonly requireSidecars?: boolean;
};

export interface DatabaseProtection {
  protectDatabaseFiles(
    databasePath: string,
    options?: ProtectionOptions,
  ): Promise<ProtectionReport>;
}

export class ProtectionError extends Error {
  override readonly name = 'ProtectionError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
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
