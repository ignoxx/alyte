import {
  createProtectedReportFileService,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from '../labs/file-service';
import type { IntakeMediaStore } from './service';

export type { IntakeImageSource as IntakeMediaSource } from '../labs/file-service';

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
  files: Pick<
    ProtectedReportFileService,
    'remove' | 'exists' | 'intakeDestination' | 'stageIntake' | 'inspectIntake' | 'listIntake'
  > &
    Partial<Pick<ProtectedReportFileService, 'portablePath'>> = createProtectedReportFileService(),
): IntakeMediaStore {
  function required<T>(value: T | undefined, operation: string): T {
    if (value === undefined)
      throw new Error(`Protected file service cannot ${operation} Intake Images`);
    return value;
  }

  return {
    portablePath(path) {
      assertOwnedIntakePath(path);
      return files.portablePath === undefined ? path : files.portablePath(path);
    },
    async destination(source, captureId) {
      const path = await required(files.intakeDestination, 'name').call(files, captureId, source);
      return files.portablePath === undefined ? path : files.portablePath(path);
    },
    async save(source, captureId): Promise<ProtectedCopy> {
      const copy = await required(files.stageIntake, 'stage').call(files, source, captureId);
      return files.portablePath === undefined
        ? copy
        : { ...copy, path: files.portablePath(copy.path) };
    },
    async inspect(path) {
      assertOwnedIntakePath(path);
      const portable = files.portablePath === undefined ? path : files.portablePath(path);
      const copy = await required(files.inspectIntake, 'inspect').call(files, portable);
      return copy === null || files.portablePath === undefined
        ? copy
        : { ...copy, path: files.portablePath(copy.path) };
    },
    async list() {
      const paths = await required(files.listIntake, 'list').call(files);
      return files.portablePath === undefined
        ? paths
        : paths.map((path) => files.portablePath!(path));
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
