import { createSortableOpaqueId } from '@alyte/domain';
import {
  openProtectedExportDatabase,
  type ExportDatabase,
  type ExportDatabaseSession,
} from '../export/service';
import {
  createProtectedReportFileService,
  type ProtectedReportFileService,
} from '../labs/file-service';
import {
  EMPTY_LOCAL_DATA_COUNTS,
  LOCAL_DELETION_FAILURE_CATEGORIES,
  LOCAL_DELETION_SCOPES,
  localDeletionPlanHash,
  stableJson,
  subtractCounts,
  type DeletionPlan,
  type DeletionResult,
  type ExportMediaSummary,
  type LocalDataCounts,
  type LocalDataSummary,
  type LocalDeletionFailureCategory,
  type LocalDeletionScope,
} from './model';

type ControlDatabaseSession = ExportDatabaseSession;
type ControlFiles = Pick<Required<ProtectedReportFileService>, 'remove' | 'exists'> &
  Pick<ProtectedReportFileService, 'listOwnedFiles' | 'removeOwnedFile'>;

type ControlServiceOptions = {
  readonly databaseFactory?: () => Promise<ControlDatabaseSession>;
  readonly files?: ControlFiles;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly appVersion?: string;
  readonly variant?: 'development' | 'preview' | 'production';
};

type PathReference = {
  readonly category: DeletionPlan['fileReferences'][number]['category'];
  readonly path: string;
  readonly ownerId: string | null;
};

type DeletionSnapshot = {
  readonly counts: LocalDataCounts;
  readonly reportIds: readonly string[];
  readonly allReportIds: readonly string[];
  readonly recordIds: readonly string[];
  readonly measurementIds: readonly string[];
  readonly eventIds: readonly string[];
  /** Every path-bearing row is captured in the same transaction as counts and IDs. */
  readonly pathReferences: readonly PathReference[];
  readonly sanitizationDraftKeys: readonly string[];
};

type IdRow = { readonly id: unknown };
type ExportPathRow = {
  readonly id: unknown;
  readonly portable_staging_reference: unknown;
  readonly portable_archive_reference: unknown;
};

const COUNT_KEYS = Object.keys(EMPTY_LOCAL_DATA_COUNTS) as (keyof LocalDataCounts)[];

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${field}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value, 'protected path');
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function pathReference(category: PathReference['category'], path: unknown): PathReference | null {
  const value = nullableString(path);
  return value === null ? null : { category, path: value, ownerId: null };
}

function ownedPathReference(
  category: PathReference['category'],
  ownerId: unknown,
  path: unknown,
): PathReference | null {
  const reference = pathReference(category, path);
  if (reference === null) return null;
  return {
    ...reference,
    ownerId:
      ownerId === null || ownerId === undefined ? null : requiredString(ownerId, 'path owner'),
  };
}

async function ids(database: ExportDatabase, sql: string, ...params: readonly unknown[]) {
  const rows = await database.getAllAsync<IdRow>(sql, ...params);
  return uniqueSorted(rows.map((row) => requiredString(row.id, 'row id')));
}

function sumDeletedCounts(snapshot: DeletionSnapshot, scope: LocalDeletionScope): LocalDataCounts {
  const all = snapshot.counts;
  switch (scope) {
    case 'reports':
      return {
        ...EMPTY_LOCAL_DATA_COUNTS,
        reports: all.reports,
        reportPages: all.reportPages,
        sanitizedReports: all.sanitizedReports,
        extractionDrafts: all.extractionDrafts,
        extractionRows: all.extractionRows,
        sanitizationDrafts: all.sanitizationDrafts,
      };
    case 'records':
      return {
        ...EMPTY_LOCAL_DATA_COUNTS,
        records: all.records,
        measurements: all.measurements,
        corrections: all.corrections,
        combinedDeletions: all.combinedDeletions,
      };
    case 'events':
      return {
        ...EMPTY_LOCAL_DATA_COUNTS,
        intakeEvents: all.intakeEvents,
        intakeComponents: all.intakeComponents,
        intakeImages: all.intakeImages,
        cloudJobs: all.cloudJobs,
        captureRecoveries: all.captureRecoveries,
      };
    case 'media':
      return {
        ...EMPTY_LOCAL_DATA_COUNTS,
        intakeImages: all.intakeImages,
        sanitizedReports: all.sanitizedReports,
        cloudJobs: all.cloudJobs,
        captureRecoveries: all.captureRecoveries,
      };
    case 'all-health':
      return { ...all, exportJobs: all.exportJobs };
  }
}

function countRows(rows: Readonly<Record<keyof LocalDataCounts, number>>): LocalDataCounts {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, rows[key] ?? 0])) as LocalDataCounts;
}

async function readSnapshot(database: ExportDatabase): Promise<DeletionSnapshot> {
  const snapshot = {} as { -readonly [K in keyof LocalDataCounts]: number };
  await database.getAllAsync<{ readonly snapshot_pin: number }>('SELECT 1 AS snapshot_pin;');

  const count = async (key: keyof LocalDataCounts, sql: string): Promise<void> => {
    const rows = await database.getAllAsync<{ readonly count: unknown }>(sql);
    const value = rows[0]?.count;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid local count for ${key}`);
    }
    snapshot[key] = value;
  };

  await count(
    'reports',
    "SELECT COUNT(*) AS count FROM lab_reports WHERE import_state <> 'deleted';",
  );
  await count('reportPages', 'SELECT COUNT(*) AS count FROM lab_report_pages;');
  await count(
    'sanitizedReports',
    "SELECT COUNT(*) AS count FROM sanitized_report_derivatives WHERE verification_state <> 'deleted';",
  );
  await count('records', 'SELECT COUNT(*) AS count FROM lab_records;');
  await count('measurements', 'SELECT COUNT(*) AS count FROM measurements;');
  await count('corrections', 'SELECT COUNT(*) AS count FROM measurement_corrections;');
  await count(
    'extractionDrafts',
    "SELECT COUNT(*) AS count FROM extraction_drafts WHERE state <> 'failed';",
  );
  await count('extractionRows', 'SELECT COUNT(*) AS count FROM extraction_draft_rows;');
  await count('intakeEvents', 'SELECT COUNT(*) AS count FROM intake_events;');
  await count('intakeComponents', 'SELECT COUNT(*) AS count FROM intake_components;');
  await count(
    'intakeImages',
    'SELECT COUNT(*) AS count FROM intake_events WHERE source_media_path IS NOT NULL;',
  );
  await count('cloudJobs', 'SELECT COUNT(*) AS count FROM cloud_jobs;');
  await count('captureRecoveries', 'SELECT COUNT(*) AS count FROM intake_capture_recovery;');
  await count('combinedDeletions', 'SELECT COUNT(*) AS count FROM lab_combined_deletions;');
  await count('exportJobs', 'SELECT COUNT(*) AS count FROM local_export_jobs;');
  await count(
    'sanitizationDrafts',
    "SELECT COUNT(*) AS count FROM app_preferences WHERE key LIKE 'labs.sanitization-draft.%';",
  );

  const allReportIds = await ids(database, 'SELECT id FROM lab_reports ORDER BY id ASC;');
  const reportIds = await ids(
    database,
    "SELECT id FROM lab_reports WHERE import_state <> 'deleted' ORDER BY id ASC;",
  );
  const recordIds = await ids(database, 'SELECT id FROM lab_records ORDER BY id ASC;');
  const measurementIds = await ids(database, 'SELECT id FROM measurements ORDER BY id ASC;');
  const eventIds = await ids(database, 'SELECT id FROM intake_events ORDER BY id ASC;');

  const reportPathRows = await database.getAllAsync<{ id: unknown; original_path: unknown }>(
    'SELECT id, original_path FROM lab_reports ORDER BY id ASC;',
  );
  const reportPaths = reportPathRows
    .map((row) => ownedPathReference('original-report', row.id, row.original_path))
    .filter((value): value is PathReference => value !== null);
  const reportPageRows = await database.getAllAsync<{
    readonly id: unknown;
    readonly report_id: unknown;
    readonly derived_path: unknown;
  }>('SELECT id, report_id, derived_path FROM lab_report_pages ORDER BY report_id ASC, id ASC;');
  const reportPagePaths = reportPageRows
    .map((row) => ownedPathReference('report-page', row.report_id, row.derived_path))
    .filter((value): value is PathReference => value !== null);
  const sanitizedPathRows = await database.getAllAsync<{
    readonly id: unknown;
    readonly report_id: unknown;
    readonly artifact_path: unknown;
  }>('SELECT id, report_id, artifact_path FROM sanitized_report_derivatives ORDER BY id ASC;');
  const sanitizedPaths = sanitizedPathRows
    .map((row) => ownedPathReference('sanitized-report', row.report_id, row.artifact_path))
    .filter((value): value is PathReference => value !== null);
  const intakePathRows = await database.getAllAsync<{ id: unknown; source_media_path: unknown }>(
    'SELECT id, source_media_path FROM intake_events WHERE source_media_path IS NOT NULL ORDER BY id ASC;',
  );
  const intakePaths = intakePathRows
    .map((row) => ownedPathReference('intake-image', row.id, row.source_media_path))
    .filter((value): value is PathReference => value !== null);
  const cloudJobRows = await database.getAllAsync<{
    readonly id: unknown;
    readonly event_id: unknown;
    readonly media_path: unknown;
  }>('SELECT id, event_id, media_path FROM cloud_jobs ORDER BY id ASC;');
  const cloudJobPaths = cloudJobRows
    .map((row) => ownedPathReference('cloud-job-media', row.event_id, row.media_path))
    .filter((value): value is PathReference => value !== null);
  const recoveryRows = await database.getAllAsync<{
    readonly capture_id: unknown;
    readonly event_id: unknown;
    readonly media_path: unknown;
  }>(
    'SELECT capture_id, event_id, media_path FROM intake_capture_recovery ORDER BY capture_id ASC;',
  );
  const captureRecoveryPaths = recoveryRows
    .map((row) => ownedPathReference('capture-recovery-media', row.event_id, row.media_path))
    .filter((value): value is PathReference => value !== null);
  const exportPathRows = await database.getAllAsync<ExportPathRow>(
    `SELECT id, portable_staging_reference, portable_archive_reference
     FROM local_export_jobs ORDER BY id ASC;`,
  );
  const exportPaths = exportPathRows.flatMap((row) => {
    const references = [row.portable_staging_reference, row.portable_archive_reference]
      .map(nullableString)
      .filter((value): value is string => value !== null);
    return references.map((path) => ({
      category: 'export' as const,
      path,
      ownerId: requiredString(row.id, 'export job id'),
    }));
  });
  const draftRows = await database.getAllAsync<{ readonly key: unknown }>(
    "SELECT key FROM app_preferences WHERE key LIKE 'labs.sanitization-draft.%' ORDER BY key ASC;",
  );

  return {
    counts: countRows(snapshot),
    reportIds,
    allReportIds,
    recordIds,
    measurementIds,
    eventIds,
    pathReferences: [
      ...reportPaths,
      ...reportPagePaths,
      ...sanitizedPaths,
      ...intakePaths,
      ...cloudJobPaths,
      ...captureRecoveryPaths,
      ...exportPaths,
    ],
    sanitizationDraftKeys: uniqueSorted(
      draftRows.map((row) => requiredString(row.key, 'sanitization draft key')),
    ),
  };
}

function planInput(snapshot: DeletionSnapshot, scope: LocalDeletionScope) {
  const deleted = sumDeletedCounts(snapshot, scope);
  const includeReports = scope === 'reports' || scope === 'media' || scope === 'all-health';
  const includeRecords = scope === 'records' || scope === 'all-health';
  const includeEvents = scope === 'events' || scope === 'all-health';
  const reportIds =
    scope === 'all-health' || scope === 'media' ? snapshot.allReportIds : snapshot.reportIds;
  const targetIds = {
    reportIds: includeReports ? reportIds : [],
    recordIds: includeRecords ? snapshot.recordIds : [],
    measurementIds: includeRecords ? snapshot.measurementIds : [],
    eventIds: includeEvents ? snapshot.eventIds : [],
  };
  const selectedEvents = new Set(targetIds.eventIds);
  const selectedReports = new Set(targetIds.reportIds);
  const fileReferences = snapshot.pathReferences.filter((reference) => {
    switch (reference.category) {
      case 'original-report':
      case 'report-page':
      case 'sanitized-report':
        return (
          (scope === 'reports' || scope === 'media' || scope === 'all-health') &&
          reference.ownerId !== null &&
          selectedReports.has(reference.ownerId)
        );
      case 'intake-image':
        return (
          (scope === 'media' || scope === 'all-health' || scope === 'events') &&
          reference.ownerId !== null &&
          (scope === 'media' || scope === 'all-health' || selectedEvents.has(reference.ownerId))
        );
      case 'cloud-job-media':
        return (
          scope === 'media' ||
          scope === 'all-health' ||
          (scope === 'events' &&
            reference.ownerId !== null &&
            selectedEvents.has(reference.ownerId))
        );
      case 'capture-recovery-media':
        // A recovery with no event is still an intake attempt and must be removed by an Events
        // or Media operation; retaining its file would strand a health artifact.
        return scope === 'media' || scope === 'all-health' || scope === 'events';
      case 'export':
        return scope === 'all-health';
    }
  });
  return {
    scope,
    counts: snapshot.counts,
    deleted,
    targetIds,
    fileReferences: uniquePathReferences(fileReferences),
    sanitizationDraftKeys: includeReports ? snapshot.sanitizationDraftKeys : [],
  };
}

function uniquePathReferences(references: readonly PathReference[]): readonly PathReference[] {
  const seen = new Set<string>();
  return references
    .filter((reference) => {
      const key = `${reference.category}:${reference.ownerId ?? ''}:${reference.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) =>
      `${left.category}:${left.path}`.localeCompare(`${right.category}:${right.path}`),
    );
}

function referenceSelectedByPlan(reference: PathReference, plan: DeletionPlan): boolean {
  const selectedReports = new Set(plan.targetIds.reportIds);
  const selectedEvents = new Set(plan.targetIds.eventIds);
  switch (reference.category) {
    case 'original-report':
    case 'report-page':
    case 'sanitized-report':
      return reference.ownerId !== null && selectedReports.has(reference.ownerId);
    case 'intake-image':
      return (
        (plan.scope === 'media' || plan.scope === 'all-health' || plan.scope === 'events') &&
        reference.ownerId !== null &&
        (plan.scope !== 'events' || selectedEvents.has(reference.ownerId))
      );
    case 'cloud-job-media':
      return (
        plan.scope === 'media' ||
        plan.scope === 'all-health' ||
        (plan.scope === 'events' &&
          reference.ownerId !== null &&
          selectedEvents.has(reference.ownerId))
      );
    case 'capture-recovery-media':
      return plan.scope === 'media' || plan.scope === 'all-health' || plan.scope === 'events';
    case 'export':
      return plan.scope === 'all-health';
  }
}

function createPlan(snapshot: DeletionSnapshot, scope: LocalDeletionScope): DeletionPlan {
  const input = planInput(snapshot, scope);
  const planHash = localDeletionPlanHash({
    scope: input.scope,
    counts: input.counts,
    deleted: input.deleted,
    targetIds: input.targetIds,
    fileReferences: input.fileReferences,
    sanitizationDraftKeys: input.sanitizationDraftKeys,
  });
  const deleted = input.deleted;
  return {
    scope,
    planHash,
    counts: input.counts,
    willRemain: subtractCounts(input.counts, deleted),
    targetIds: input.targetIds,
    fileReferences: input.fileReferences,
    sanitizationDraftKeys: input.sanitizationDraftKeys,
  };
}

function categoryForError(error: unknown): LocalDeletionFailureCategory {
  if (error instanceof Error && /owned protected|owned path/i.test(error.message)) {
    return 'unowned-path';
  }
  return 'file-failed';
}

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
    await database.runAsync('DELETE FROM lab_combined_deletions;');
    await database.runAsync('DELETE FROM local_export_jobs;');
    await database.runAsync(
      'DELETE FROM app_preferences WHERE key LIKE ?;',
      'labs.sanitization-draft.%',
    );
    await database.runAsync('DELETE FROM local_deletion_operations WHERE id <> ?;', operationId);
  }
}

function planJson(plan: DeletionPlan): string {
  return stableJson({
    scope: plan.scope,
    planHash: plan.planHash,
    counts: plan.counts,
    willRemain: plan.willRemain,
    targetIds: plan.targetIds,
    fileReferences: plan.fileReferences,
    sanitizationDraftKeys: plan.sanitizationDraftKeys,
  });
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
  const files = options.files ?? (createProtectedReportFileService() as ControlFiles);
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

  async function removeFiles(
    database: ExportDatabase,
    plan: DeletionPlan,
  ): Promise<readonly LocalDeletionFailureCategory[]> {
    const failures: LocalDeletionFailureCategory[] = [];
    // Re-read every path-bearing row immediately before file work. A file may be named by more
    // than one health family (for example an Intake Image and a queued cloud/recovery row), so a
    // selected path is removed only when no out-of-scope reference would survive this operation.
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
        // Export staging is an owned directory; the existing export file owner removes the
        // directory and its deterministic archive siblings through its narrow resolver.
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

  async function execute(plan: DeletionPlan): Promise<DeletionResult> {
    const operationId = makeId('local-deletion');
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
    const failures = await removeFiles(session.database, plan);
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
      : execute(parsed);
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

  async function reconcileOwnedOrphans(database: ExportDatabase): Promise<void> {
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
        // Keep a retryable, category-only failure for the next startup. No path crosses UI.
      }
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
          const operationId = requiredString(row.id, 'deletion operation id');
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
          const failures = await removeFiles(session.database, plan);
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
        await reconcileOwnedOrphans(session.database);
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
