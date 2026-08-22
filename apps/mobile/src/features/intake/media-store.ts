import {
  createProtectedReportFileService,
  type ProtectedReportFileService,
} from '../labs/file-service';
import type { IntakeMediaStore } from './service';

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
): IntakeMediaStore {
  return {
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
