import type * as FileSystemTypes from 'expo-file-system/legacy';
import type { LabReportSourceType } from '@alyte/domain';
import { createSortableOpaqueId } from '@alyte/domain';
import { nativePathProtection, type ProtectedPathProtection } from './protection';

export const PROTECTED_REPORT_DIRECTORIES = {
  root: 'alyte-protected',
  originals: 'original-reports',
  working: 'working-pages',
  sanitized: 'sanitized-reports',
  intake: 'intake-media',
  transient: 'transient-imports',
  exports: 'exports',
} as const;

export type LabSourceSelection = {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sourceType: LabReportSourceType;
  readonly byteSize?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
};

export type ProtectedCopy = {
  readonly path: string;
  readonly sourceHash: string;
  readonly byteSize: number | null;
};

export type ProtectedReportFileService = {
  initialize(): Promise<void>;
  stage(source: LabSourceSelection, importId: string): Promise<ProtectedCopy>;
  promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy>;
  hashFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  cleanupTransientImports(): Promise<void>;
};

export type ProtectedReportFileServiceOptions = {
  readonly protection?: ProtectedPathProtection;
  readonly fileSystem?: typeof FileSystemTypes;
  readonly rootDirectory?: string;
};

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinPath(directory: string, component: string): string {
  return `${stripTrailingSlash(directory)}/${component}`;
}

function safeFilename(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 120) : fallback;
}

function extensionFor(source: LabSourceSelection): string {
  const name = source.name.toLowerCase();
  if (
    source.sourceType === 'pdf' ||
    source.mimeType === 'application/pdf' ||
    name.endsWith('.pdf')
  ) {
    return '.pdf';
  }
  const extension = name.match(/\.[a-z0-9]{1,8}$/)?.[0];
  return extension ?? '.image';
}

function requireDocumentDirectory(fileSystem: typeof FileSystemTypes): string {
  const directory = fileSystem.documentDirectory;
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('Alyte protected storage is unavailable');
  }
  return directory;
}

export function createProtectedReportFileService(
  options: ProtectedReportFileServiceOptions = {},
): ProtectedReportFileService {
  let fileSystemPromise: Promise<typeof FileSystemTypes> | null = options.fileSystem
    ? Promise.resolve(options.fileSystem)
    : null;
  const protection = options.protection ?? nativePathProtection;
  const documentDirectory = options.rootDirectory;
  let fileSystem!: typeof FileSystemTypes;
  let root: string | null = documentDirectory
    ? joinPath(documentDirectory, PROTECTED_REPORT_DIRECTORIES.root)
    : null;

  function directoryPaths(): readonly string[] {
    if (root === null) throw new Error('Protected report storage is not initialized');
    return [
      root,
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.originals),
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.working),
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.sanitized),
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.intake),
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.transient),
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.exports),
    ];
  }

  async function protectDirectory(path: string): Promise<void> {
    await protection.protectPath(path);
  }

  async function initialize(): Promise<void> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    const rootDirectory = documentDirectory ?? requireDocumentDirectory(fileSystem);
    root ??= joinPath(rootDirectory, PROTECTED_REPORT_DIRECTORIES.root);
    const directories = directoryPaths();
    for (const directory of directories) {
      const directoryInfo = await fileSystem.getInfoAsync(directory);
      if (!directoryInfo.exists) {
        await fileSystem.makeDirectoryAsync(directory, { intermediates: true });
      }
      await protectDirectory(directory);
    }
  }

  async function info(path: string): Promise<{ exists: boolean; size: number | null }> {
    const result = await fileSystem.getInfoAsync(path);
    if (!result.exists) return { exists: false, size: null };
    const size = 'size' in result && typeof result.size === 'number' ? result.size : null;
    return { exists: true, size };
  }

  async function copyProtected(from: string, to: string): Promise<ProtectedCopy> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    try {
      await fileSystem.copyAsync({ from, to });
      await protection.protectPath(to);
      const sourceHash = await protection.hashFile(to);
      const fileInfo = await info(to);
      if (!fileInfo.exists) throw new Error('Protected source copy disappeared');
      return { path: to, sourceHash, byteSize: fileInfo.size };
    } catch (error) {
      await fileSystem.deleteAsync(to, { idempotent: true });
      throw error;
    }
  }

  async function stage(source: LabSourceSelection, importId: string): Promise<ProtectedCopy> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const filename = `${safeFilename(importId, createSortableOpaqueId('import'))}${extensionFor(source)}`;
    return copyProtected(
      source.uri,
      joinPath(joinPath(root, PROTECTED_REPORT_DIRECTORIES.transient), filename),
    );
  }

  async function promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const filename = `${safeFilename(reportId, createSortableOpaqueId('report'))}-${safeFilename(source.name, 'source')}${extensionFor(source)}`;
    const promoted = await copyProtected(
      staged.path,
      joinPath(joinPath(root, PROTECTED_REPORT_DIRECTORIES.originals), filename),
    );
    if (promoted.sourceHash !== staged.sourceHash) {
      await fileSystem.deleteAsync(promoted.path, { idempotent: true });
      throw new Error('Protected Original Report hash changed during copy');
    }
    return promoted;
  }

  async function hashFile(path: string): Promise<string> {
    return protection.hashFile(path);
  }

  async function exists(path: string): Promise<boolean> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    return (await info(path)).exists;
  }

  async function remove(path: string): Promise<void> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    await fileSystem.deleteAsync(path, { idempotent: true });
  }

  async function cleanupTransientImports(): Promise<void> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const directory = joinPath(root, PROTECTED_REPORT_DIRECTORIES.transient);
    const names = await fileSystem.readDirectoryAsync(directory);
    await Promise.all(names.map((name) => remove(joinPath(directory, name))));
  }

  return { initialize, stage, promote, hashFile, exists, remove, cleanupTransientImports };
}
