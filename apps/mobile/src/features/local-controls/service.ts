import { createSortableOpaqueId } from '@alyte/domain';
import {
  openProtectedExportDatabase,
  type ExportDatabase,
  type ExportDatabaseSession,
} from '../export/service';
import { createProtectedReportFileService } from '../labs/file-service';
import {
  LOCAL_DELETION_FAILURE_CATEGORIES,
  LOCAL_DELETION_SCOPES,
  type DeletionPlan,
  type DeletionResult,
  type ExportMediaSummary,
  type LocalDataSummary,
  type LocalDeletionFailureCategory,
  type LocalDeletionScope,
} from './model';
import {
  reconcileOwnedOrphans,
  removePlannedFiles,
  operationIdFromRow,
  type LocalControlFiles,
} from './file-coordinator';
import { createPlan, ids, planJson, readSnapshot } from './repository';

type ControlDatabaseSession = ExportDatabaseSession;
type ControlServiceOptions = {
  readonly databaseFactory?: () => Promise<ControlDatabaseSession>;
  readonly files?: LocalControlFiles;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly appVersion?: string;
  readonly variant?: 'development' | 'preview' | 'production';
};

function arrayPlaceholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

async function updateOperation(
  database: ExportDatabase,
  input: {
    readonly id: string;
    readonly state: 'requested' | 'running' | 'completed' | 'failed';
    readonly now: string;
    readonly failureCategories?: readonly LocalDeletionFailureCategory[];
  },
): Promise<void> {
  const result = await database.runAsync(
    `UPDATE local_deletion_operations
     SET state = ?, failure_categories_json = ?, updated_at = ?,
       started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
     WHERE id = ?;`,
    input.state,
    JSON.stringify(input.failureCategories ?? []),
    input.now,
    input.state,
    input.now,
    input.state,
    input.state === 'completed' ? input.now : null,
    input.id,
  );
  if (result.changes !== 1) throw new Error('Local deletion operation could not be updated');
}

async function applyDatabaseDeletion(
  database: ExportDatabase,
  plan: DeletionPlan,
  operationId: string,
  now: string,
): Promise<void> {
  const reportIds = plan.targetIds.reportIds;
  const recordIds = plan.targetIds.recordIds;
  const measurementIds = plan.targetIds.measurementIds;
  const eventIds = plan.targetIds.eventIds;
  const bind = (idsToDelete: readonly string[]) => [...idsToDelete];

  // This control row references both sides of a combined deletion. Remove it before deleting
  // either parent so every scope remains valid with foreign keys enabled.
  if (plan.scope === 'all-health') {
    await database.runAsync('DELETE FROM lab_combined_deletions;');
  } else if (plan.scope === 'reports' && reportIds.length > 0) {
    await database.runAsync(
      `DELETE FROM lab_combined_deletions WHERE report_id IN (${arrayPlaceholders(reportIds)});`,
      ...bind(reportIds),
    );
  } else if (plan.scope === 'records' && recordIds.length > 0) {
    await database.runAsync(
      `DELETE FROM lab_combined_deletions WHERE record_id IN (${arrayPlaceholders(recordIds)});`,
      ...bind(recordIds),
    );
  }

  if (plan.scope === 'reports' || plan.scope === 'all-health') {
    if (reportIds.length > 0) {
      await database.runAsync(
        `DELETE FROM extraction_draft_rows WHERE draft_id IN (SELECT id FROM extraction_drafts WHERE report_id IN (${arrayPlaceholders(reportIds)}));`,
        ...bind(reportIds),
      );
      await database.runAsync(
        `DELETE FROM extraction_drafts WHERE report_id IN (${arrayPlaceholders(reportIds)});`,
        ...bind(reportIds),
      );
      await database.runAsync(
        `DELETE FROM lab_report_pages WHERE report_id IN (${arrayPlaceholders(reportIds)});`,
        ...bind(reportIds),
      );
      await database.runAsync(
        `DELETE FROM sanitized_report_derivatives WHERE report_id IN (${arrayPlaceholders(reportIds)});`,
        ...bind(reportIds),
      );
      await database.runAsync(
        `DELETE FROM lab_reports WHERE id IN (${arrayPlaceholders(reportIds)});`,
        ...bind(reportIds),
      );
    }
    if (plan.sanitizationDraftKeys.length > 0) {
      await database.runAsync(
        `DELETE FROM app_preferences WHERE key IN (${arrayPlaceholders(plan.sanitizationDraftKeys)});`,
        ...bind(plan.sanitizationDraftKeys),
      );
    }
  }

  if (plan.scope === 'records' || plan.scope === 'all-health') {
    if (measurementIds.length > 0) {
      await database.runAsync(
        `DELETE FROM measurement_corrections WHERE measurement_id IN (${arrayPlaceholders(measurementIds)});`,
        ...bind(measurementIds),
      );
      await database.runAsync(
        `DELETE FROM measurements WHERE id IN (${arrayPlaceholders(measurementIds)});`,
        ...bind(measurementIds),
      );
    }
    if (recordIds.length > 0) {
      await database.runAsync(
        `DELETE FROM lab_records WHERE id IN (${arrayPlaceholders(recordIds)});`,
        ...bind(recordIds),
      );
    }
  }

  if (plan.scope === 'events' || plan.scope === 'all-health') {
    if (eventIds.length > 0) {
      await database.runAsync(
        `DELETE FROM intake_capture_recovery WHERE event_id IN (${arrayPlaceholders(eventIds)});`,
        ...bind(eventIds),
      );
      await database.runAsync(
        `DELETE FROM cloud_jobs WHERE event_id IN (${arrayPlaceholders(eventIds)});`,
        ...bind(eventIds),
      );
      await database.runAsync(
        `DELETE FROM intake_events WHERE id IN (${arrayPlaceholders(eventIds)});`,
        ...bind(eventIds),
      );
    }
    // A crash can leave a capture recovery before its Intake Event is committed. It is still an
    // intake artifact, so an Events operation owns and removes that orphan as well.
    if (plan.scope === 'events') {
      await database.runAsync('DELETE FROM intake_capture_recovery WHERE event_id IS NULL;');
    }
  }

  if (plan.scope === 'media') {
    await database.runAsync(
      // Media deletion removes source bytes while retaining report/source metadata and pages.
      'UPDATE lab_reports SET original_path = NULL, source_hash = NULL, deletion_error = NULL, updated_at = ? WHERE original_path IS NOT NULL;',
      now,
    );
    // Keep the page rows as structured report metadata, but never retain a pointer to removed
    // working-page bytes.
    await database.runAsync(
      'UPDATE lab_report_pages SET derived_path = NULL WHERE derived_path IS NOT NULL;',
    );
    await database.runAsync(
      "UPDATE sanitized_report_derivatives SET artifact_path = NULL, artifact_hash = NULL, verification_state = 'deleted', deleted_at = ?, updated_at = ? WHERE verification_state <> 'deleted';",
      now,
      now,
    );
    await database.runAsync(
      'UPDATE intake_events SET source_media_path = NULL, source_media_hash = NULL, source_media_size = NULL, source_media_protection_json = NULL, updated_at = ? WHERE source_media_path IS NOT NULL;',
      now,
    );
    await database.runAsync('DELETE FROM cloud_jobs;');
    await database.runAsync('DELETE FROM intake_capture_recovery;');
  }

  if (plan.scope === 'all-health') {
    // The current operation remains durable so a relaunch can show a terminal state. Other
    // control rows, export staging references, and sanitization drafts are local-health state.
    await database.runAsync('DELETE FROM extraction_draft_rows;');
    await database.runAsync('DELETE FROM extraction_drafts;');
    await database.runAsync('DELETE FROM measurement_corrections;');
    await database.runAsync('DELETE FROM measurements;');
    await database.runAsync('DELETE FROM lab_records;');
    await database.runAsync('DELETE FROM lab_report_pages;');
    await database.runAsync('DELETE FROM sanitized_report_derivatives;');
    await database.runAsync('DELETE FROM lab_reports;');
    await database.runAsync('DELETE FROM intake_components;');
    await database.runAsync('DELETE FROM intake_events;');
    await database.runAsync('DELETE FROM cloud_jobs;');
    await database.runAsync('DELETE FROM intake_capture_recovery;');
    await database.runAsync('DELETE FROM local_export_jobs;');
    // Keep non-health app preferences (including the one-time development showcase bootstrap
    // marker). Only sanitization drafts are health-linked and are removed here.
    await database.runAsync(
      'DELETE FROM app_preferences WHERE key LIKE ?;',
      'labs.sanitization-draft.%',
    );
    await database.runAsync('DELETE FROM local_deletion_operations WHERE id <> ?;', operationId);
  }
}

export type LocalControlsService = {
  summary(): Promise<LocalDataSummary>;
  preview(scope: LocalDeletionScope): Promise<DeletionPlan>;
  execute(plan: DeletionPlan): Promise<DeletionResult>;
  retry(operationId: string): Promise<DeletionResult>;
  exportMediaSummary(): Promise<ExportMediaSummary>;
  diagnosticsState(): Promise<{
    readonly localStorage: 'available' | 'unavailable';
    readonly protectedFiles: 'available' | 'unavailable';
  }>;
  reconcile(): Promise<void>;
};

export function createLocalControlsService(
  options: ControlServiceOptions = {},
): LocalControlsService {
  const now = options.now ?? (() => new Date().toISOString());
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const files = options.files ?? (createProtectedReportFileService() as LocalControlFiles);
  const databaseFactory = options.databaseFactory ?? (() => openProtectedExportDatabase());
  let reconcilePromise: Promise<void> | null = null;

  async function open(): Promise<ControlDatabaseSession> {
    return databaseFactory();
  }

  async function summary(): Promise<LocalDataSummary> {
    const session = await open();
    try {
      let result!: LocalDataSummary;
      await session.database.withTransactionAsync(async () => {
        const snapshot = await readSnapshot(session.database);
        result = { counts: snapshot.counts, generatedAt: now() };
      });
      return result;
    } finally {
      await session.close();
    }
  }

  async function preview(scope: LocalDeletionScope): Promise<DeletionPlan> {
    if (!LOCAL_DELETION_SCOPES.includes(scope)) throw new Error('Unsupported local deletion scope');
    const session = await open();
    try {
      let result!: DeletionPlan;
      await session.database.withTransactionAsync(async () => {
        const snapshot = await readSnapshot(session.database);
        result = createPlan(snapshot, scope);
      });
      return result;
    } finally {
      await session.close();
    }
  }

  async function execute(
    plan: DeletionPlan,
    existingOperationId?: string,
  ): Promise<DeletionResult> {
    const operationId = existingOperationId ?? makeId('local-deletion');
    const session = await open();
    let persisted = false;
    try {
      await session.database.withTransactionAsync(async () => {
        const snapshot = await readSnapshot(session.database);
        const fresh = createPlan(snapshot, plan.scope);
        if (fresh.planHash !== plan.planHash) {
          throw Object.assign(new Error('The local deletion preview is stale'), {
            category: 'stale-preview' as const,
          });
        }
        if (existingOperationId === undefined) {
          await session.database.runAsync(
            `INSERT INTO local_deletion_operations
             (id, scope, plan_hash, plan_json, state, failure_categories_json, requested_at, updated_at)
             VALUES (?, ?, ?, ?, 'requested', '[]', ?, ?);`,
            operationId,
            plan.scope,
            plan.planHash,
            planJson(plan),
            now(),
            now(),
          );
        } else {
          const operationRows = await session.database.getAllAsync<{
            readonly state: unknown;
            readonly plan_hash: unknown;
          }>('SELECT state, plan_hash FROM local_deletion_operations WHERE id = ?;', operationId);
          const operation = operationRows[0];
          if (
            operation === undefined ||
            !['requested', 'running', 'failed'].includes(String(operation.state)) ||
            operation.plan_hash !== plan.planHash
          ) {
            throw Object.assign(new Error('The local deletion operation is not retryable'), {
              category: 'stale-preview' as const,
            });
          }
        }
        await updateOperation(session.database, { id: operationId, state: 'running', now: now() });
        persisted = true;
      });
    } catch (error) {
      await session.close();
      if (error instanceof Error && 'category' in error && error.category === 'stale-preview') {
        return { state: 'failed', operationId, failureCategories: ['stale-preview'] };
      }
      return { state: 'failed', operationId, failureCategories: ['database-failed'] };
    }

    if (!persisted) {
      await session.close();
      return { state: 'failed', operationId, failureCategories: ['database-failed'] };
    }
    const failures = await removePlannedFiles(session.database, plan, files);
    if (failures.length > 0) {
      await session.database.withTransactionAsync(async () => {
        await updateOperation(session.database, {
          id: operationId,
          state: 'failed',
          now: now(),
          failureCategories: failures,
        });
      });
      await session.close();
      return { state: 'failed', operationId, failureCategories: failures };
    }

    try {
      await session.database.withTransactionAsync(async () => {
        await applyDatabaseDeletion(session.database, plan, operationId, now());
        await updateOperation(session.database, {
          id: operationId,
          state: 'completed',
          now: now(),
        });
      });
      await session.close();
      return { state: 'completed', operationId, failureCategories: [] };
    } catch {
      try {
        await session.database.withTransactionAsync(async () => {
          await updateOperation(session.database, {
            id: operationId,
            state: 'failed',
            now: now(),
            failureCategories: ['database-failed'],
          });
        });
      } catch {
        // If SQLite is unavailable after file work, the running operation remains durable for the
        // next launch's reconciliation attempt.
      }
      await session.close();
      return { state: 'failed', operationId, failureCategories: ['database-failed'] };
    }
  }

  async function retry(operationId: string): Promise<DeletionResult> {
    const session = await open();
    let parsed: DeletionPlan | null = null;
    try {
      const rows = await session.database.getAllAsync<{
        readonly scope: unknown;
        readonly plan_json: unknown;
      }>('SELECT scope, plan_json FROM local_deletion_operations WHERE id = ?;', operationId);
      const row = rows[0];
      if (row === undefined || typeof row.plan_json !== 'string') {
        return { state: 'failed', operationId, failureCategories: ['database-failed'] };
      }
      parsed = JSON.parse(row.plan_json) as DeletionPlan;
    } catch {
      return { state: 'failed', operationId, failureCategories: ['database-failed'] };
    } finally {
      await session.close();
    }
    return parsed === null
      ? { state: 'failed', operationId, failureCategories: ['database-failed'] }
      : execute(parsed, operationId);
  }

  async function exportMediaSummary(): Promise<ExportMediaSummary> {
    const session = await open();
    try {
      let result!: ExportMediaSummary;
      await session.database.withTransactionAsync(async () => {
        await session.database.getAllAsync<{ readonly snapshot_pin: number }>(
          'SELECT 1 AS snapshot_pin;',
        );
        const originals = await ids(
          session.database,
          "SELECT id FROM lab_reports WHERE original_path IS NOT NULL AND import_state <> 'deleted' ORDER BY id ASC;",
        );
        const sanitized = await ids(
          session.database,
          "SELECT id FROM sanitized_report_derivatives WHERE artifact_path IS NOT NULL AND verification_state <> 'deleted' ORDER BY id ASC;",
        );
        const intake = await ids(
          session.database,
          'SELECT id FROM intake_events WHERE source_media_path IS NOT NULL ORDER BY id ASC;',
        );
        result = {
          selection: {
            originalReportIds: originals,
            sanitizedReportDerivativeIds: sanitized,
            intakeImageEventIds: intake,
          },
          counts: {
            originalReports: originals.length,
            sanitizedReports: sanitized.length,
            intakeImages: intake.length,
          },
        };
      });
      return result;
    } finally {
      await session.close();
    }
  }

  async function diagnosticsState() {
    const session = await open();
    try {
      await session.database.getAllAsync('SELECT 1;');
      let protectedFiles: 'available' | 'unavailable' = 'available';
      try {
        if (files.listOwnedFiles !== undefined) await files.listOwnedFiles();
      } catch {
        protectedFiles = 'unavailable';
      }
      return { localStorage: 'available' as const, protectedFiles };
    } catch {
      return { localStorage: 'unavailable' as const, protectedFiles: 'unavailable' as const };
    } finally {
      await session.close();
    }
  }

  async function reconcile(): Promise<void> {
    if (reconcilePromise !== null) return reconcilePromise;
    reconcilePromise = (async () => {
      const session = await open();
      try {
        const rows = await session.database.getAllAsync<{
          readonly id: unknown;
          readonly state: unknown;
          readonly plan_json: unknown;
          readonly failure_categories_json: unknown;
        }>(
          `SELECT id, state, plan_json, failure_categories_json
           FROM local_deletion_operations WHERE state IN ('requested', 'running', 'failed') ORDER BY requested_at ASC;`,
        );
        for (const row of rows) {
          const operationId = operationIdFromRow(row.id);
          // An all-health operation intentionally removes older control rows after it reaches its
          // database phase. The initial query may therefore contain an operation that no longer
          // exists by the time this loop reaches it.
          if (
            (
              await session.database.getAllAsync<{ readonly id: unknown }>(
                'SELECT id FROM local_deletion_operations WHERE id = ?;',
                operationId,
              )
            ).length === 0
          ) {
            continue;
          }
          if (typeof row.plan_json !== 'string') continue;
          let plan: DeletionPlan;
          try {
            plan = JSON.parse(row.plan_json) as DeletionPlan;
          } catch {
            await updateOperation(session.database, {
              id: operationId,
              state: 'failed',
              now: now(),
              failureCategories: ['database-failed'],
            });
            continue;
          }
          // A failed operation is retryable. A requested/running row is resumed after a kill. The
          // same plan remains authoritative; missing files are idempotently absent.
          const failures = await removePlannedFiles(session.database, plan, files);
          if (failures.length > 0) {
            await updateOperation(session.database, {
              id: operationId,
              state: 'failed',
              now: now(),
              failureCategories: failures,
            });
            continue;
          }
          try {
            await session.database.withTransactionAsync(async () => {
              await applyDatabaseDeletion(session.database, plan, operationId, now());
              await updateOperation(session.database, {
                id: operationId,
                state: 'completed',
                now: now(),
              });
            });
          } catch {
            await updateOperation(session.database, {
              id: operationId,
              state: 'failed',
              now: now(),
              failureCategories: ['database-failed'],
            });
          }
        }
        await reconcileOwnedOrphans(session.database, files);
      } finally {
        await session.close();
      }
    })().finally(() => {
      reconcilePromise = null;
    });
    return reconcilePromise;
  }

  return { summary, preview, execute, retry, exportMediaSummary, diagnosticsState, reconcile };
}

export function isLocalDeletionFailureCategory(
  value: unknown,
): value is LocalDeletionFailureCategory {
  return LOCAL_DELETION_FAILURE_CATEGORIES.includes(value as LocalDeletionFailureCategory);
}
