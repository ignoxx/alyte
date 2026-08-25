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

export type ZipExpectedEntry = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type ZipOperationResult = {
  readonly operationId: string;
  readonly phase: 'verified' | 'promoted' | 'cancelled';
  readonly entryCount: number;
  readonly bytes: number;
};

export type ZipFailureCategory =
  | 'cancelled'
  | 'invalid-input'
  | 'symlink-rejected'
  | 'path-escape'
  | 'checksum-mismatch'
  | 'entry-mismatch'
  | 'archive-failure'
  | 'native-unavailable';

export type ZipArchiveAdapter = {
  createZip(input: {
    readonly operationId: string;
    readonly stagingPath: string;
    readonly partialArchivePath: string;
    readonly entries: readonly ZipExpectedEntry[];
  }): Promise<ZipOperationResult>;
  promoteZip(input: {
    readonly operationId: string;
    readonly partialArchivePath: string;
    readonly archivePath: string;
  }): Promise<ZipOperationResult>;
  cancelZip(input: {
    readonly operationId: string;
    readonly partialArchivePath: string;
  }): Promise<ZipOperationResult>;
};

type NativeZipArchiveModule = {
  createZip(
    operationId: string,
    stagingPath: string,
    partialArchivePath: string,
    entriesJson: string,
  ): Promise<unknown>;
  promoteZip(
    operationId: string,
    partialArchivePath: string,
    archivePath: string,
  ): Promise<unknown>;
  cancelZip(operationId: string, partialArchivePath: string): Promise<unknown>;
};

function zipFailureCategory(error: unknown): ZipFailureCategory {
  const candidate = error as { readonly failureCategory?: unknown; readonly message?: unknown };
  const value = candidate?.failureCategory ?? candidate?.message;
  if (typeof value === 'string') {
    if (value.includes('cancelled')) return 'cancelled';
    if (value.includes('symlink')) return 'symlink-rejected';
    if (value.includes('path_escape')) return 'path-escape';
    if (value.includes('checksum')) return 'checksum-mismatch';
    if (value.includes('entry')) return 'entry-mismatch';
    if (value.includes('invalid_input')) return 'invalid-input';
  }
  return 'archive-failure';
}

function zipResult(
  value: unknown,
  operationId: string,
  phase: ZipOperationResult['phase'],
): ZipOperationResult {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid ZIP operation result');
  const candidate = value as Record<string, unknown>;
  if (candidate.operationId !== operationId || candidate.phase !== phase) {
    throw new Error('Invalid ZIP operation identity');
  }
  if (
    typeof candidate.entryCount !== 'number' ||
    !Number.isInteger(candidate.entryCount) ||
    candidate.entryCount < 0 ||
    typeof candidate.bytes !== 'number' ||
    !Number.isSafeInteger(candidate.bytes) ||
    candidate.bytes < 0
  ) {
    throw new Error('Invalid ZIP operation counts');
  }
  return {
    operationId,
    phase,
    entryCount: candidate.entryCount,
    bytes: candidate.bytes,
  };
}

/** The only JavaScript-facing ZIP adapter. Native results intentionally contain no paths/names. */
export const nativeZipArchive: ZipArchiveAdapter = {
  async createZip(input) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeZipArchiveModule>('AlyteProtection');
    if (native === null) throw new Error('ZIP archive creation is unavailable on this device');
    try {
      return zipResult(
        await native.createZip(
          input.operationId,
          input.stagingPath,
          input.partialArchivePath,
          JSON.stringify(input.entries),
        ),
        input.operationId,
        'verified',
      );
    } catch (error) {
      const category = zipFailureCategory(error);
      const sanitized = new Error('The export archive could not be created');
      Object.assign(sanitized, { failureCategory: category });
      throw sanitized;
    }
  },
  async promoteZip(input) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeZipArchiveModule>('AlyteProtection');
    if (native === null) throw new Error('ZIP archive promotion is unavailable on this device');
    try {
      return zipResult(
        await native.promoteZip(input.operationId, input.partialArchivePath, input.archivePath),
        input.operationId,
        'promoted',
      );
    } catch (error) {
      const category = zipFailureCategory(error);
      const sanitized = new Error('The export archive could not be finalized');
      Object.assign(sanitized, { failureCategory: category });
      throw sanitized;
    }
  },
  async cancelZip(input) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeZipArchiveModule>('AlyteProtection');
    if (native === null) throw new Error('ZIP archive cancellation is unavailable on this device');
    try {
      return zipResult(
        await native.cancelZip(input.operationId, input.partialArchivePath),
        input.operationId,
        'cancelled',
      );
    } catch (error) {
      const category = zipFailureCategory(error);
      const sanitized = new Error('The export archive could not be cancelled');
      Object.assign(sanitized, { failureCategory: category });
      throw sanitized;
    }
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
