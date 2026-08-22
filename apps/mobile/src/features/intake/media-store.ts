import type * as FileSystemTypes from 'expo-file-system/legacy';
import {
  createProtectedReportFileService,
  type ProtectedReportFileService,
} from '../labs/file-service';
import { nativePathProtection, type ProtectedPathProtection } from '../labs/protection';
import type { IntakeMediaStore } from './service';

export type IntakeMediaSource = {
  readonly uri: string;
  readonly filename?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
  readonly byteSize?: number | null | undefined;
};

export type StoredIntakeMedia = {
  readonly path: string;
  readonly byteSize: number | null;
};

function assertOwnedIntakePath(path: string): void {
  const normalized = path.replaceAll('\\', '/');
  const hasTraversal = normalized.split('/').some((segment) => segment === '..');
  if (
    hasTraversal ||
    (!normalized.includes('/alyte-protected/intake-media/') &&
      !normalized.startsWith('protected://intake-media/'))
  ) {
    throw new Error('The requested media path is not an owned Intake Image');
  }
}

export function createProtectedIntakeMediaStore(
  files: Pick<ProtectedReportFileService, 'remove' | 'exists'> = createProtectedReportFileService(),
  options: {
    readonly protection?: ProtectedPathProtection;
    readonly rootDirectory?: string;
  } = {},
): IntakeMediaStore {
  const protection = options.protection ?? nativePathProtection;
  let fileSystem: typeof FileSystemTypes | null = null;
  let intakeDirectory: string | null = null;

  function joinPath(directory: string, component: string): string {
    return `${directory.replace(/\/+$/, '')}/${component}`;
  }

  function safeExtension(source: IntakeMediaSource): string {
    const filename = source.filename?.toLowerCase() ?? '';
    const fromFilename = filename.match(/\.[a-z0-9]{1,8}$/)?.[0];
    if (fromFilename !== undefined) return fromFilename;
    if (source.mimeType === 'image/png') return '.png';
    if (source.mimeType === 'image/webp') return '.webp';
    return '.jpg';
  }

  function safeId(id: string): string {
    const value = id.replace(/[^a-zA-Z0-9_-]+/g, '-');
    if (value.length === 0) throw new Error('Intake Image capture id is required');
    return value.slice(0, 120);
  }

  async function initializeStorage(): Promise<string> {
    fileSystem ??= await import('expo-file-system/legacy');
    const documentDirectory = options.rootDirectory ?? fileSystem.documentDirectory;
    if (typeof documentDirectory !== 'string' || documentDirectory.length === 0) {
      throw new Error('Protected Intake Image storage is unavailable');
    }
    if (intakeDirectory !== null) return intakeDirectory;
    const root = joinPath(documentDirectory, 'alyte-protected');
    intakeDirectory = joinPath(root, 'intake-media');
    for (const directory of [root, intakeDirectory]) {
      const info = await fileSystem.getInfoAsync(directory);
      if (!info.exists) await fileSystem.makeDirectoryAsync(directory, { intermediates: true });
      await protection.protectPath(directory);
    }
    return intakeDirectory;
  }

  return {
    async list(): Promise<readonly string[]> {
      const directory = await initializeStorage();
      if (fileSystem === null) throw new Error('Protected Intake Image storage is unavailable');
      const names = await fileSystem.readDirectoryAsync(directory);
      return names.map((name) => joinPath(directory, name));
    },
    async save(source: IntakeMediaSource, captureId: string): Promise<StoredIntakeMedia> {
      const directory = await initializeStorage();
      if (fileSystem === null) throw new Error('Protected Intake Image storage is unavailable');
      const path = joinPath(directory, `${safeId(captureId)}${safeExtension(source)}`);
      const existing = await fileSystem.getInfoAsync(path);
      if (existing.exists) {
        // A process can be suspended between copy and protection. Re-assert the native policy
        // before allowing a relaunch/duplicate callback to reuse an existing destination.
        await protection.protectPath(path);
        const byteSize =
          'size' in existing && typeof existing.size === 'number' ? existing.size : null;
        if (
          source.byteSize !== undefined &&
          source.byteSize !== null &&
          byteSize !== source.byteSize
        ) {
          throw new Error('The existing Intake Image is incomplete');
        }
        return {
          path,
          byteSize,
        };
      }
      try {
        await fileSystem.copyAsync({ from: source.uri, to: path });
        await protection.protectPath(path);
        const stored = await fileSystem.getInfoAsync(path);
        if (!stored.exists) throw new Error('Protected Intake Image disappeared after capture');
        const byteSize = 'size' in stored && typeof stored.size === 'number' ? stored.size : null;
        if (
          source.byteSize !== undefined &&
          source.byteSize !== null &&
          byteSize !== source.byteSize
        ) {
          throw new Error('Protected Intake Image size changed during capture');
        }
        return {
          path,
          byteSize,
        };
      } catch (error) {
        await fileSystem.deleteAsync(path, { idempotent: true });
        throw error;
      }
    },
    async remove(path) {
      assertOwnedIntakePath(path);
      await files.remove(path);
    },
    async verifyRemoved(path) {
      assertOwnedIntakePath(path);
      return !(await files.exists(path));
    },
  };
}
