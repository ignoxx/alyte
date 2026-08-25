import type { ExportDatabase } from '../export/service';
import type { ProtectedReportFileService } from '../labs/file-service';
import type { DeletionPlan, LocalDeletionFailureCategory } from './model';
import {
  nullableString,
  readSnapshot,
  referenceSelectedByPlan,
  requiredString,
} from './repository';

export type LocalControlFiles = Pick<Required<ProtectedReportFileService>, 'remove' | 'exists'> &
  Pick<ProtectedReportFileService, 'listOwnedFiles' | 'removeOwnedFile'>;

function categoryForError(error: unknown): LocalDeletionFailureCategory {
  if (error instanceof Error && /owned protected|owned path/i.test(error.message)) {
    return 'unowned-path';
  }
  return 'file-failed';
}

/** File-first coordinator with cross-table reference counting and idempotent absence handling. */
export async function removePlannedFiles(
  database: ExportDatabase,
  plan: DeletionPlan,
  files: LocalControlFiles,
): Promise<readonly LocalDeletionFailureCategory[]> {
  const failures: LocalDeletionFailureCategory[] = [];
  const currentReferences = (await readSnapshot(database)).pathReferences;
  const retainedPaths = new Set(
    currentReferences
      .filter((reference) => !referenceSelectedByPlan(reference, plan))
      .map((reference) => reference.path),
  );
  const attempted = new Set<string>();
  for (const reference of plan.fileReferences) {
    if (attempted.has(reference.path)) continue;
    attempted.add(reference.path);
    if (retainedPaths.has(reference.path)) continue;
    try {
      if (reference.category === 'export') {
        await files.remove(reference.path);
        if (await files.exists(reference.path)) throw new Error('Export artifact remained');
      } else if (files.removeOwnedFile !== undefined) {
        await files.removeOwnedFile(reference.path);
        if (await files.exists(reference.path)) throw new Error('Protected file remained');
      } else {
        await files.remove(reference.path);
        if (await files.exists(reference.path)) throw new Error('Protected file remained');
      }
    } catch (error) {
      failures.push(categoryForError(error));
    }
  }
  return [...new Set(failures)];
}

/** Startup sweep deletes only unreferenced files beneath Alyte-owned protected directories. */
export async function reconcileOwnedOrphans(
  database: ExportDatabase,
  files: LocalControlFiles,
): Promise<void> {
  if (files.listOwnedFiles === undefined || files.removeOwnedFile === undefined) return;
  const referencedRows = await database.getAllAsync<{ readonly path: unknown }>(`
    SELECT original_path AS path FROM lab_reports WHERE original_path IS NOT NULL
    UNION ALL SELECT derived_path AS path FROM lab_report_pages WHERE derived_path IS NOT NULL
    UNION ALL SELECT artifact_path AS path FROM sanitized_report_derivatives WHERE artifact_path IS NOT NULL
    UNION ALL SELECT source_media_path AS path FROM intake_events WHERE source_media_path IS NOT NULL
    UNION ALL SELECT media_path AS path FROM cloud_jobs WHERE media_path IS NOT NULL
    UNION ALL SELECT media_path AS path FROM intake_capture_recovery WHERE media_path IS NOT NULL
    UNION ALL SELECT portable_staging_reference AS path FROM local_export_jobs WHERE portable_staging_reference IS NOT NULL
    UNION ALL SELECT portable_archive_reference AS path FROM local_export_jobs WHERE portable_archive_reference IS NOT NULL;
  `);
  const referenced = new Set(
    referencedRows
      .map((row) => nullableString(row.path))
      .filter((path): path is string => path !== null),
  );
  const ownedFiles = await files.listOwnedFiles();
  for (const candidate of ownedFiles) {
    const keep =
      referenced.has(candidate) ||
      [...referenced].some(
        (reference) =>
          reference.startsWith('protected://exports/') &&
          candidate.startsWith(`${reference.replace(/\/$/u, '')}/`),
      );
    if (keep) continue;
    try {
      await files.removeOwnedFile(candidate);
    } catch {
      // A later startup can retry an orphan cleanup; no path or native error crosses the UI.
    }
  }
}

export function operationIdFromRow(value: unknown): string {
  return requiredString(value, 'deletion operation id');
}
