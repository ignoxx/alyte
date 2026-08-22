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
  > = createProtectedReportFileService(),
): IntakeMediaStore {
  function required<T>(value: T | undefined, operation: string): T {
    if (value === undefined)
      throw new Error(`Protected file service cannot ${operation} Intake Images`);
    return value;
  }

  return {
    async destination(source, captureId) {
      return required(files.intakeDestination, 'name').call(files, captureId, source);
    },
    async save(source, captureId): Promise<ProtectedCopy> {
      return required(files.stageIntake, 'stage').call(files, source, captureId);
    },
    async inspect(path) {
      assertOwnedIntakePath(path);
      return required(files.inspectIntake, 'inspect').call(files, path);
    },
    async list() {
      return required(files.listIntake, 'list').call(files);
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
