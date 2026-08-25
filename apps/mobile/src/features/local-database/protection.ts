export type ProtectionReport = {
  readonly protectedPaths: readonly string[];
  readonly missingSidecarPaths: readonly string[];
};

export const PROTECTION_FAILURE_CATEGORIES = [
  'primary_database_missing',
  'data_protection_verification',
  'backup_exclusion_verification',
  'file_missing',
  'invalid_hash',
  'invalid_file_type',
  'native_module_unavailable',
  'invalid_native_report',
  'native_failure',
] as const;

export type ProtectionFailureCategory = (typeof PROTECTION_FAILURE_CATEGORIES)[number];

export type ProtectionOptions = {
  /** Retained for native API compatibility; absent WAL/SHM files are always tolerated. */
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
  readonly category: ProtectionFailureCategory;

  constructor(
    message: string,
    options?: { cause?: unknown; category?: ProtectionFailureCategory },
  ) {
    super(message, options);
    this.category = options?.category ?? 'native_failure';
  }
}

function isProtectionFailureCategory(value: unknown): value is ProtectionFailureCategory {
  return (
    typeof value === 'string' &&
    (PROTECTION_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function protectionFailureCategory(error: unknown): ProtectionFailureCategory {
  if (typeof error !== 'object' || error === null) return 'native_failure';
  const candidate = error as {
    readonly failureCategory?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown };
    readonly message?: unknown;
  };
  const category = candidate.failureCategory ?? candidate.userInfo?.failureCategory;
  if (isProtectionFailureCategory(category)) return category;
  const message = candidate.message;
  if (typeof message === 'string') {
    const messageCategory = PROTECTION_FAILURE_CATEGORIES.find((value) => message.includes(value));
    if (messageCategory !== undefined) return messageCategory;
  }
  return 'native_failure';
}

export function validateProtectionReport(
  databasePath: string,
  report: unknown,
): asserts report is ProtectionReport {
  if (
    typeof report !== 'object' ||
    report === null ||
    !Array.isArray((report as ProtectionReport).protectedPaths) ||
    !Array.isArray((report as ProtectionReport).missingSidecarPaths)
  ) {
    throw new ProtectionError('AlyteProtection returned an invalid protection report', {
      category: 'invalid_native_report',
    });
  }

  const normalizedDatabasePath = databasePath.replace(/^file:\/\//, '');
  const protectedPaths = (report as ProtectionReport).protectedPaths;
  if (!protectedPaths.includes(databasePath) && !protectedPaths.includes(normalizedDatabasePath)) {
    throw new ProtectionError('The primary local database file was not protected', {
      category: 'data_protection_verification',
    });
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
        { category: 'native_module_unavailable' },
      );
    }

    let report: ProtectionReport;
    try {
      report = await native.protectDatabaseFiles(databasePath, options);
    } catch (error) {
      throw new ProtectionError('The local database could not be protected', {
        cause: error,
        category: protectionFailureCategory(error),
      });
    }

    validateProtectionReport(databasePath, report);
    return report;
  },
};
