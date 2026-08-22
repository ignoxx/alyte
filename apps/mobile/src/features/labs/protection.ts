export type ProtectionReport = {
  readonly protectedPaths: readonly string[];
  readonly missingSidecarPaths: readonly string[];
};

export class ProtectionError extends Error {
  override readonly name = 'ProtectionError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface DatabaseProtection {
  protectDatabaseFiles(databasePath: string): Promise<ProtectionReport>;
}

type NativeProtectionModule = {
  protectDatabaseFiles(databasePath: string): Promise<ProtectionReport>;
};

/**
 * The native module is deliberately optional at import time so pure repository tests can run in
 * Node. A missing module is an unsafe persistence state, not permission to continue unprotected.
 */
export const nativeDatabaseProtection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeProtectionModule>('AlyteProtection');
    if (native === null) {
      throw new ProtectionError(
        'AlyteProtection is unavailable; local health records cannot be persisted safely',
      );
    }

    let report: ProtectionReport;
    try {
      report = await native.protectDatabaseFiles(databasePath);
    } catch (error) {
      throw new ProtectionError('The local database could not be protected', { cause: error });
    }

    if (!Array.isArray(report.protectedPaths) || !Array.isArray(report.missingSidecarPaths)) {
      throw new ProtectionError('AlyteProtection returned an invalid protection report');
    }
    const normalizedDatabasePath = databasePath.replace(/^file:\/\//, '');
    if (
      !report.protectedPaths.includes(databasePath) &&
      !report.protectedPaths.includes(normalizedDatabasePath)
    ) {
      throw new ProtectionError('The primary local database file was not protected');
    }
    return report;
  },
};
