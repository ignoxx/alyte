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

/**
 * A protected path is stored in the local database as this container-independent URI. Native
 * APIs still receive an absolute file URI after `resolvePath` has checked ownership.
 */
const PROTECTED_PATH_SCHEME = 'protected://';
const PROTECTED_DIRECTORY_NAMES = new Set<string>([
  PROTECTED_REPORT_DIRECTORIES.originals,
  PROTECTED_REPORT_DIRECTORIES.working,
  PROTECTED_REPORT_DIRECTORIES.sanitized,
  PROTECTED_REPORT_DIRECTORIES.intake,
  PROTECTED_REPORT_DIRECTORIES.transient,
  PROTECTED_REPORT_DIRECTORIES.exports,
]);

export type ProtectedPathFacts = {
  readonly status: 'verified';
  readonly protectedPaths: readonly string[];
  readonly backupExcluded: true;
};

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
  /** Native protection and backup exclusion were verified before the path was returned. */
  readonly protection?: ProtectedPathFacts;
};

export type ProtectedExportWorkspace = {
  readonly stagingPath: string;
  readonly portableStagingReference: string;
  readonly archivePartialPath: string;
  readonly archivePath: string;
  readonly portableArchiveReference: string;
};

export type ProtectedExportWorkspaceReferences = Pick<
  ProtectedExportWorkspace,
  'portableStagingReference' | 'portableArchiveReference'
>;

export type ProtectedExportSource = {
  readonly path: string;
  readonly portablePath: string;
  readonly sourceHash: string;
  readonly byteSize: number | null;
};

export type ProtectedExportFile = {
  readonly path: string;
  readonly relativePath: string;
  readonly sourceHash: string;
  readonly byteSize: number | null;
};

export type IntakeImageSource = {
  readonly uri: string;
  readonly name?: string | null;
  readonly filename?: string | null;
  readonly mimeType?: string | null;
  readonly byteSize?: number | null;
};

export type ProtectedReportFileService = {
  initialize(): Promise<void>;
  stage(source: LabSourceSelection, importId: string): Promise<ProtectedCopy>;
  promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy>;
  recoverPromoted(reportId: string, source: LabSourceSelection): Promise<ProtectedCopy | null>;
  hashFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Rebase a persisted path onto the current app container after an iOS container relocation. */
  resolvePath?(path: string): Promise<string>;
  /** Return the stable database representation for an app-owned protected path. */
  portablePath?(path: string): string;
  cleanupTransientImports(): Promise<void>;
  /** Destination and verification seams for newly rendered Sanitized Reports. */
  sanitizedDestination?(reportId: string, derivativeId: string): Promise<string>;
  protectArtifact?(path: string): Promise<ProtectedCopy>;
  /** Intake media uses this same protected-file owner; methods remain optional for lab test fakes. */
  intakeDestination?(captureId: string, source: IntakeImageSource): Promise<string>;
  stageIntake?(source: IntakeImageSource, captureId: string): Promise<ProtectedCopy>;
  inspectIntake?(path: string): Promise<ProtectedCopy | null>;
  listIntake?(): Promise<readonly string[]>;
  /** Narrow workspace operations for local Full Export; no arbitrary recursive path API is exposed. */
  exportWorkspaceReferences?(jobId: string): ProtectedExportWorkspaceReferences;
  createExportWorkspace?(jobId: string): Promise<ProtectedExportWorkspace>;
  writeExportFile?(
    workspace: ProtectedExportWorkspace,
    relativePath: string,
    contents: string,
  ): Promise<ProtectedExportFile>;
  copyExportMedia?(
    workspace: ProtectedExportWorkspace,
    source: ProtectedExportSource,
    relativePath: string,
  ): Promise<ProtectedExportFile>;
  inspectExportSource?(
    path: string,
    category: 'original-reports' | 'sanitized-reports' | 'intake-images',
  ): Promise<ProtectedExportSource | null>;
  protectExportArchive?(path: string): Promise<ProtectedCopy>;
  removeExportArtifacts?(
    workspace: ProtectedExportWorkspace,
    options?: { readonly removeArchive?: boolean },
  ): Promise<void>;
  removeExportArtifactsByReference?(
    portableStagingReference: string | null,
    portableArchiveReference: string | null,
  ): Promise<void>;
};

export type ProtectedReportFileServiceOptions = {
  readonly protection?: ProtectedPathProtection;
  readonly fileSystem?: typeof FileSystemTypes;
  readonly rootDirectory?: string;
};

/**
 * Single owner for reference-aware report artifact removal. Repository queries supply only counts;
 * the protected-file boundary owns path de-duplication, adapter validation, removal, and verification.
 */
export async function deleteProtectedReportArtifacts(
  fileService: ProtectedReportFileService,
  paths: readonly (string | null)[],
  referenceCount: (path: string) => Promise<number>,
): Promise<void> {
  for (const path of new Set(
    paths.filter((candidate): candidate is string => candidate !== null),
  )) {
    if ((await referenceCount(path)) !== 0) continue;
    await fileService.remove(path);
    if (await fileService.exists(path)) {
      throw new Error('Protected report artifact remained after deletion');
    }
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinPath(directory: string, component: string): string {
  return `${stripTrailingSlash(directory)}/${component}`;
}

function hasUnsafePathSegment(path: string): boolean {
  return (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.includes('?') ||
    path.includes('#') ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  );
}

function protectedSuffix(path: string): string | null {
  if (path.startsWith(PROTECTED_PATH_SCHEME)) {
    const suffix = path.slice(PROTECTED_PATH_SCHEME.length);
    if (hasUnsafePathSegment(suffix)) return null;
    const segments = suffix.split('/');
    if (segments.length !== 2 || !PROTECTED_DIRECTORY_NAMES.has(segments[0]!)) return null;
    return suffix;
  }

  const marker = `/${PROTECTED_REPORT_DIRECTORIES.root}/`;
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return null;
  const prefix = path.slice(0, markerIndex);
  const suffix = path.slice(markerIndex + marker.length);
  if (hasUnsafePathSegment(suffix)) return null;
  const segments = suffix.split('/');
  if (segments.length !== 2 || !PROTECTED_DIRECTORY_NAMES.has(segments[0]!)) return null;

  // Current paths are accepted only beneath the initialized root. Legacy paths are accepted only
  // when they have the shape of an iOS app Documents container. This prevents a hostile database
  // row such as /tmp/alyte-protected/... from being rebased into the current app container.
  if (
    prefix.startsWith('file://') &&
    /\/Containers\/Data\/Application\/[0-9a-f-]{36}\/Documents$/i.test(prefix)
  ) {
    return suffix;
  }
  return null;
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

function originalFilename(reportId: string, source: LabSourceSelection): string {
  return `${safeFilename(reportId, createSortableOpaqueId('report'))}-${safeFilename(source.name, 'source')}${extensionFor(source)}`;
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

  function suffixForOwnedPath(path: string): string {
    if (root !== null) {
      const currentPrefix = `${stripTrailingSlash(root)}/`;
      if (path.startsWith(currentPrefix)) {
        const suffix = path.slice(currentPrefix.length);
        if (!hasUnsafePathSegment(suffix)) {
          const segments = suffix.split('/');
          if (segments.length === 2 && PROTECTED_DIRECTORY_NAMES.has(segments[0]!)) {
            return suffix;
          }
        }
      }
    }
    const suffix = protectedSuffix(path);
    if (suffix === null) throw new Error('The requested path is not an owned protected file');
    return suffix;
  }

  function nativePathForSuffix(suffix: string): string {
    if (root === null) throw new Error('Protected report storage is not initialized');
    return joinPath(root, suffix);
  }

  function portablePath(path: string): string {
    return `${PROTECTED_PATH_SCHEME}${suffixForOwnedPath(path)}`;
  }

  async function resolvePath(path: string): Promise<string> {
    await initialize();
    return nativePathForSuffix(suffixForOwnedPath(path));
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
      const protectionReport = await protection.protectPath(to);
      const sourceHash = await protection.hashFile(to);
      const fileInfo = await info(to);
      if (!fileInfo.exists) throw new Error('Protected source copy disappeared');
      return {
        path: to,
        sourceHash,
        byteSize: fileInfo.size,
        protection: {
          status: 'verified',
          protectedPaths: protectionReport.protectedPaths,
          backupExcluded: true,
        },
      };
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
    const promoted = await copyProtected(
      staged.path,
      joinPath(
        joinPath(root, PROTECTED_REPORT_DIRECTORIES.originals),
        originalFilename(reportId, source),
      ),
    );
    if (promoted.sourceHash !== staged.sourceHash) {
      await fileSystem.deleteAsync(promoted.path, { idempotent: true });
      throw new Error('Protected Original Report hash changed during copy');
    }
    return promoted;
  }

  async function recoverPromoted(
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy | null> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const path = joinPath(
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.originals),
      originalFilename(reportId, source),
    );
    if (!(await exists(path))) return null;
    const fileInfo = await info(path);
    // A copy can be interrupted after its destination is created but before the database row is
    // updated. When the picker supplied a size, reject and remove a truncated destination rather
    // than turning an incomplete artifact into a retained Original Report on relaunch.
    if (
      source.byteSize !== undefined &&
      source.byteSize !== null &&
      fileInfo.size !== source.byteSize
    ) {
      await fileSystem.deleteAsync(path, { idempotent: true });
      return null;
    }
    let sourceHash: string;
    try {
      sourceHash = await protection.hashFile(path);
    } catch (error) {
      // A destination found without a verifiable hash is an interrupted artifact, not a source
      // we may retain or deduplicate. Remove it before relaunch reconciliation continues.
      await fileSystem.deleteAsync(path, { idempotent: true });
      throw error;
    }
    return { path, sourceHash, byteSize: fileInfo.size };
  }

  async function hashFile(path: string): Promise<string> {
    return protection.hashFile(await resolvePath(path));
  }

  async function exists(path: string): Promise<boolean> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    try {
      return (await info(await resolvePath(path))).exists;
    } catch (error) {
      if (
        path.startsWith(PROTECTED_PATH_SCHEME) ||
        path.includes(`/${PROTECTED_REPORT_DIRECTORIES.root}/`)
      ) {
        throw error;
      }
      // Existence checks are also used to verify that a picker-owned source was not mutated. They
      // are read-only; destructive/hash operations still require an owned protected path.
      return (await info(path)).exists;
    }
  }

  async function remove(path: string): Promise<void> {
    fileSystemPromise ??= import('expo-file-system/legacy');
    fileSystem ??= await fileSystemPromise;
    await fileSystem.deleteAsync(await resolvePath(path), { idempotent: true });
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

  async function sanitizedDestination(reportId: string, derivativeId: string): Promise<string> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    return joinPath(
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.sanitized),
      `${safeFilename(reportId, 'report')}-${safeFilename(derivativeId, 'sanitized')}.pdf`,
    );
  }

  async function protectArtifact(path: string): Promise<ProtectedCopy> {
    await initialize();
    return protectedNativeArtifact(await resolvePath(path));
  }

  async function protectedNativeArtifact(nativePath: string): Promise<ProtectedCopy> {
    const sourceHash = await protection.hashFile(nativePath);
    const protectionReport = await protection.protectPath(nativePath);
    const fileInfo = await info(nativePath);
    if (!fileInfo.exists) throw new Error('Sanitized Report artifact disappeared');
    return {
      path: nativePath,
      sourceHash,
      byteSize: fileInfo.size,
      protection: {
        status: 'verified',
        protectedPaths: protectionReport.protectedPaths,
        backupExcluded: true,
      },
    };
  }

  function intakeExtension(source: IntakeImageSource): string {
    const name = (source.name ?? source.filename)?.toLowerCase() ?? '';
    return (
      name.match(/\.[a-z0-9]{1,8}$/)?.[0] ??
      (source.mimeType === 'image/png'
        ? '.png'
        : source.mimeType === 'image/webp'
          ? '.webp'
          : '.jpg')
    );
  }

  function intakeFilename(captureId: string, source: IntakeImageSource): string {
    return `${safeFilename(captureId, createSortableOpaqueId('snap'))}${intakeExtension(source)}`;
  }

  async function intakeDestination(captureId: string, source: IntakeImageSource): Promise<string> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    return joinPath(
      joinPath(root, PROTECTED_REPORT_DIRECTORIES.intake),
      intakeFilename(captureId, source),
    );
  }

  async function stageIntake(source: IntakeImageSource, captureId: string): Promise<ProtectedCopy> {
    await initialize();
    const destination = await intakeDestination(captureId, source);
    const staged = await copyProtected(source.uri, destination);
    if (
      source.byteSize !== undefined &&
      source.byteSize !== null &&
      staged.byteSize !== source.byteSize
    ) {
      await remove(destination);
      throw new Error('Protected Intake Image size changed during capture');
    }
    return staged;
  }

  async function inspectIntake(path: string): Promise<ProtectedCopy | null> {
    await initialize();
    const suffix = suffixForOwnedPath(path);
    if (!suffix.startsWith(`${PROTECTED_REPORT_DIRECTORIES.intake}/`)) {
      throw new Error('The requested path is not an owned Intake Image');
    }
    const nativePath = nativePathForSuffix(suffix);
    if (!(await exists(nativePath))) return null;
    const fileInfo = await info(nativePath);
    const sourceHash = await protection.hashFile(nativePath);
    const protectionReport = await protection.protectPath(nativePath);
    return {
      path: nativePath,
      sourceHash,
      byteSize: fileInfo.size,
      protection: {
        status: 'verified',
        protectedPaths: protectionReport.protectedPaths,
        backupExcluded: true,
      },
    };
  }

  async function listIntake(): Promise<readonly string[]> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const directory = joinPath(root, PROTECTED_REPORT_DIRECTORIES.intake);
    return (await fileSystem.readDirectoryAsync(directory)).map((name) =>
      joinPath(directory, name),
    );
  }

  function exportJobName(jobId: string): string {
    const value = safeFilename(jobId, 'export-job');
    if (value !== jobId || value.length === 0 || value.includes('.')) {
      throw new Error('The export job identifier is not safe');
    }
    return value;
  }

  function exportWorkspaceReferences(jobId: string): ProtectedExportWorkspaceReferences {
    const name = exportJobName(jobId);
    return {
      portableStagingReference: `${PROTECTED_PATH_SCHEME}${PROTECTED_REPORT_DIRECTORIES.exports}/${name}.partial`,
      portableArchiveReference: `${PROTECTED_PATH_SCHEME}${PROTECTED_REPORT_DIRECTORIES.exports}/${name}.zip`,
    };
  }

  function exportRelativePath(relativePath: string): string {
    if (
      relativePath.length === 0 ||
      relativePath.includes('\\') ||
      relativePath.includes('\u0000') ||
      relativePath.startsWith('/') ||
      hasUnsafePathSegment(relativePath)
    ) {
      throw new Error('The export relative path is invalid');
    }
    return relativePath;
  }

  function exportWorkspaceRoot(workspace: ProtectedExportWorkspace): string {
    const suffix = suffixForOwnedPath(workspace.portableStagingReference);
    if (!suffix.startsWith(`${PROTECTED_REPORT_DIRECTORIES.exports}/`)) {
      throw new Error('The export workspace is not owned by Alyte');
    }
    const native = nativePathForSuffix(suffix);
    if (native !== workspace.stagingPath) throw new Error('The export workspace changed');
    return native;
  }

  function exportArchivePath(path: string): string {
    const suffix = suffixForOwnedPath(path);
    if (!suffix.startsWith(`${PROTECTED_REPORT_DIRECTORIES.exports}/`)) {
      throw new Error('The export archive is not owned by Alyte');
    }
    return nativePathForSuffix(suffix);
  }

  async function regularFileInfo(path: string): Promise<{ exists: boolean; size: number | null }> {
    const result = (await fileSystem.getInfoAsync(path)) as {
      readonly exists: boolean;
      readonly isDirectory?: boolean;
      readonly size?: number;
    };
    if (!result.exists) return { exists: false, size: null };
    if (result.isDirectory === true) throw new Error('Export media must be a regular file');
    return { exists: true, size: typeof result.size === 'number' ? result.size : null };
  }

  async function createExportWorkspace(jobId: string): Promise<ProtectedExportWorkspace> {
    await initialize();
    if (root === null) throw new Error('Protected report storage is not initialized');
    const name = exportJobName(jobId);
    const exportsRoot = joinPath(root, PROTECTED_REPORT_DIRECTORIES.exports);
    const stagingPath = joinPath(exportsRoot, `${name}.partial`);
    const archivePartialPath = joinPath(exportsRoot, `${name}.zip.partial`);
    const archivePath = joinPath(exportsRoot, `${name}.zip`);
    if (
      (await fileSystem.getInfoAsync(stagingPath)).exists ||
      (await fileSystem.getInfoAsync(archivePartialPath)).exists ||
      (await fileSystem.getInfoAsync(archivePath)).exists
    ) {
      throw new Error('The export workspace already exists');
    }
    try {
      await fileSystem.makeDirectoryAsync(stagingPath, { intermediates: false });
      await protectDirectory(stagingPath);
      if (!(await fileSystem.getInfoAsync(stagingPath)).exists) {
        throw new Error('Export staging workspace disappeared after protection');
      }
    } catch (error) {
      try {
        await fileSystem.deleteAsync(stagingPath, { idempotent: true });
      } catch {
        throw new Error('Export staging workspace cleanup is pending');
      }
      if ((await fileSystem.getInfoAsync(stagingPath)).exists) {
        throw new Error('Export staging workspace cleanup is pending');
      }
      throw error;
    }
    return {
      stagingPath,
      portableStagingReference: portablePath(stagingPath),
      archivePartialPath,
      archivePath,
      portableArchiveReference: portablePath(archivePath),
    };
  }

  async function workspaceDestination(
    workspace: ProtectedExportWorkspace,
    relativePath: string,
  ): Promise<string> {
    const destination = joinPath(exportWorkspaceRoot(workspace), exportRelativePath(relativePath));
    const parent = destination.slice(0, destination.lastIndexOf('/'));
    await fileSystem.makeDirectoryAsync(parent, { intermediates: true });
    await protectDirectory(parent);
    return destination;
  }

  async function writeExportFile(
    workspace: ProtectedExportWorkspace,
    relativePath: string,
    contents: string,
  ): Promise<ProtectedExportFile> {
    const destination = await workspaceDestination(workspace, relativePath);
    const writer = fileSystem as typeof fileSystem & {
      writeAsStringAsync(
        path: string,
        value: string,
        options?: { readonly encoding?: unknown },
      ): Promise<void>;
    };
    await writer.writeAsStringAsync(destination, contents, { encoding: 'utf8' });
    const protectedArtifact = await protectedNativeArtifact(destination);
    return {
      path: destination,
      relativePath,
      sourceHash: protectedArtifact.sourceHash,
      byteSize: protectedArtifact.byteSize,
    };
  }

  async function copyExportMedia(
    workspace: ProtectedExportWorkspace,
    source: ProtectedExportSource,
    relativePath: string,
  ): Promise<ProtectedExportFile> {
    const destination = await workspaceDestination(workspace, relativePath);
    await fileSystem.copyAsync({ from: source.path, to: destination });
    try {
      const protectedArtifact = await protectedNativeArtifact(destination);
      if (protectedArtifact.sourceHash !== source.sourceHash) {
        throw new Error('Export media hash changed during copy');
      }
      return {
        path: destination,
        relativePath,
        sourceHash: protectedArtifact.sourceHash,
        byteSize: protectedArtifact.byteSize,
      };
    } catch (error) {
      await fileSystem.deleteAsync(destination, { idempotent: true });
      throw error;
    }
  }

  async function inspectExportSource(
    path: string,
    category: 'original-reports' | 'sanitized-reports' | 'intake-images',
  ): Promise<ProtectedExportSource | null> {
    await initialize();
    const suffix = suffixForOwnedPath(path);
    const expectedDirectory =
      category === 'original-reports'
        ? PROTECTED_REPORT_DIRECTORIES.originals
        : category === 'sanitized-reports'
          ? PROTECTED_REPORT_DIRECTORIES.sanitized
          : PROTECTED_REPORT_DIRECTORIES.intake;
    if (!suffix.startsWith(`${expectedDirectory}/`)) {
      throw new Error('The selected export media is not in its declared category');
    }
    const native = nativePathForSuffix(suffix);
    const fileInfo = await regularFileInfo(native);
    if (!fileInfo.exists) return null;
    const protectedArtifact = await protectedNativeArtifact(native);
    return {
      path: native,
      portablePath: portablePath(native),
      sourceHash: protectedArtifact.sourceHash,
      byteSize: fileInfo.size,
    };
  }

  async function protectExportArchive(path: string): Promise<ProtectedCopy> {
    return protectArtifact(exportArchivePath(path));
  }

  async function removeExportArtifacts(
    workspace: ProtectedExportWorkspace,
    options: { readonly removeArchive?: boolean } = {},
  ): Promise<void> {
    await initialize();
    const rootPath = exportWorkspaceRoot(workspace);
    const archivePartial = exportArchivePath(workspace.archivePartialPath);
    const archive = exportArchivePath(workspace.archivePath);
    await fileSystem.deleteAsync(rootPath, { idempotent: true });
    await fileSystem.deleteAsync(archivePartial, { idempotent: true });
    if (options.removeArchive !== false)
      await fileSystem.deleteAsync(archive, { idempotent: true });
    if ((await fileSystem.getInfoAsync(rootPath)).exists) {
      throw new Error('Export staging workspace remained after deletion');
    }
    if ((await fileSystem.getInfoAsync(archivePartial)).exists) {
      throw new Error('Export partial archive remained after deletion');
    }
    if (options.removeArchive !== false && (await fileSystem.getInfoAsync(archive)).exists) {
      throw new Error('Export archive remained after deletion');
    }
  }

  async function removeExportArtifactsByReference(
    portableStagingReference: string | null,
    portableArchiveReference: string | null,
  ): Promise<void> {
    await initialize();
    const stagingPath =
      portableStagingReference === null
        ? null
        : exportWorkspaceRoot({
            stagingPath: await resolvePath(portableStagingReference),
            portableStagingReference,
            archivePartialPath: joinPath(root!, 'unused.partial'),
            archivePath: joinPath(root!, 'unused.zip'),
            portableArchiveReference: `${PROTECTED_PATH_SCHEME}${PROTECTED_REPORT_DIRECTORIES.exports}/unused.zip`,
          });
    const archivePath =
      portableArchiveReference === null ? null : exportArchivePath(portableArchiveReference);
    const partialPath = archivePath === null ? null : `${archivePath}.partial`;
    if (stagingPath !== null) await fileSystem.deleteAsync(stagingPath, { idempotent: true });
    if (partialPath !== null) await fileSystem.deleteAsync(partialPath, { idempotent: true });
    if (archivePath !== null) await fileSystem.deleteAsync(archivePath, { idempotent: true });
    for (const path of [stagingPath, partialPath, archivePath]) {
      if (path !== null && (await fileSystem.getInfoAsync(path)).exists) {
        throw new Error('Export artifact remained after relaunch cleanup');
      }
    }
  }

  return {
    initialize,
    stage,
    promote,
    recoverPromoted,
    hashFile,
    exists,
    remove,
    resolvePath,
    portablePath,
    cleanupTransientImports,
    sanitizedDestination,
    protectArtifact,
    intakeDestination,
    stageIntake,
    inspectIntake,
    listIntake,
    exportWorkspaceReferences,
    createExportWorkspace,
    writeExportFile,
    copyExportMedia,
    inspectExportSource,
    protectExportArchive,
    removeExportArtifacts,
    removeExportArtifactsByReference,
  };
}
