import {
  EMPTY_LOCAL_DATA_COUNTS,
  localDeletionPlanHash,
  stableJson,
  subtractCounts,
  type DeletionPlan,
  type LocalDataCounts,
  type LocalDeletionScope,
} from './model';
import type { ExportDatabase } from '../export/service';

export type PathReference = {
  readonly category: DeletionPlan['fileReferences'][number]['category'];
  readonly path: string;
  readonly ownerId: string | null;
};

export type DeletionSnapshot = {
  readonly counts: LocalDataCounts;
  /** Combined rows owned by active reports selected by the reports scope. */
  readonly reportCombinedDeletions: number;
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

const COUNT_KEYS = Object.keys(EMPTY_LOCAL_DATA_COUNTS) as (keyof LocalDataCounts)[];

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${field}`);
  return value;
}

export function nullableString(value: unknown): string | null {
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

export async function ids(database: ExportDatabase, sql: string, ...params: readonly unknown[]) {
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
        combinedDeletions: snapshot.reportCombinedDeletions,
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
    case 'reset-app':
      return { ...all, exportJobs: all.exportJobs };
  }
}

function deletesAllHealth(scope: LocalDeletionScope): boolean {
  return scope === 'all-health' || scope === 'reset-app';
}

function countRows(rows: Readonly<Record<keyof LocalDataCounts, number>>): LocalDataCounts {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, rows[key] ?? 0])) as LocalDataCounts;
}

export async function readSnapshot(database: ExportDatabase): Promise<DeletionSnapshot> {
  const snapshot = {} as { -readonly [K in keyof LocalDataCounts]: number };
  // A read transaction caller pins this snapshot with a harmless query before all dependent
  // counts, IDs, and path references are read.
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
  let reportCombinedDeletions = 0;
  if (reportIds.length > 0) {
    const combinedRows = await database.getAllAsync<{ readonly count: unknown }>(
      `SELECT COUNT(*) AS count FROM lab_combined_deletions WHERE report_id IN (${reportIds
        .map(() => '?')
        .join(', ')});`,
      ...reportIds,
    );
    const value = combinedRows[0]?.count;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('Invalid local count for reportCombinedDeletions');
    }
    reportCombinedDeletions = value;
  }
  const recordIds = await ids(database, 'SELECT id FROM lab_records ORDER BY id ASC;');
  const measurementIds = await ids(database, 'SELECT id FROM measurements ORDER BY id ASC;');
  const eventIds = await ids(database, 'SELECT id FROM intake_events ORDER BY id ASC;');

  const reportRows = await database.getAllAsync<{ id: unknown; original_path: unknown }>(
    'SELECT id, original_path FROM lab_reports ORDER BY id ASC;',
  );
  const reportPaths = reportRows
    .map((row) => ownedPathReference('original-report', row.id, row.original_path))
    .filter((value): value is PathReference => value !== null);
  const pageRows = await database.getAllAsync<{
    id: unknown;
    report_id: unknown;
    derived_path: unknown;
  }>('SELECT id, report_id, derived_path FROM lab_report_pages ORDER BY report_id ASC, id ASC;');
  const pagePaths = pageRows
    .map((row) => ownedPathReference('report-page', row.report_id, row.derived_path))
    .filter((value): value is PathReference => value !== null);
  const sanitizedRows = await database.getAllAsync<{
    id: unknown;
    report_id: unknown;
    artifact_path: unknown;
  }>('SELECT id, report_id, artifact_path FROM sanitized_report_derivatives ORDER BY id ASC;');
  const sanitizedPaths = sanitizedRows
    .map((row) => ownedPathReference('sanitized-report', row.report_id, row.artifact_path))
    .filter((value): value is PathReference => value !== null);
  const intakeRows = await database.getAllAsync<{ id: unknown; source_media_path: unknown }>(
    'SELECT id, source_media_path FROM intake_events WHERE source_media_path IS NOT NULL ORDER BY id ASC;',
  );
  const intakePaths = intakeRows
    .map((row) => ownedPathReference('intake-image', row.id, row.source_media_path))
    .filter((value): value is PathReference => value !== null);
  const cloudRows = await database.getAllAsync<{ event_id: unknown; media_path: unknown }>(
    'SELECT event_id, media_path FROM cloud_jobs ORDER BY id ASC;',
  );
  const cloudPaths = cloudRows
    .map((row) => ownedPathReference('cloud-job-media', row.event_id, row.media_path))
    .filter((value): value is PathReference => value !== null);
  const recoveryRows = await database.getAllAsync<{ event_id: unknown; media_path: unknown }>(
    'SELECT event_id, media_path FROM intake_capture_recovery ORDER BY capture_id ASC;',
  );
  const recoveryPaths = recoveryRows
    .map((row) => ownedPathReference('capture-recovery-media', row.event_id, row.media_path))
    .filter((value): value is PathReference => value !== null);
  const exportRows = await database.getAllAsync<{
    readonly id: unknown;
    readonly portable_staging_reference: unknown;
    readonly portable_archive_reference: unknown;
  }>(
    'SELECT id, portable_staging_reference, portable_archive_reference FROM local_export_jobs ORDER BY id ASC;',
  );
  const exportPaths = exportRows.flatMap((row) =>
    [row.portable_staging_reference, row.portable_archive_reference]
      .map(nullableString)
      .filter((value): value is string => value !== null)
      .map((path) => ({
        category: 'export' as const,
        path,
        ownerId: requiredString(row.id, 'export job id'),
      })),
  );
  const draftRows = await database.getAllAsync<{ readonly key: unknown }>(
    "SELECT key FROM app_preferences WHERE key LIKE 'labs.sanitization-draft.%' ORDER BY key ASC;",
  );

  return {
    counts: countRows(snapshot),
    reportCombinedDeletions,
    reportIds,
    allReportIds,
    recordIds,
    measurementIds,
    eventIds,
    pathReferences: [
      ...reportPaths,
      ...pagePaths,
      ...sanitizedPaths,
      ...intakePaths,
      ...cloudPaths,
      ...recoveryPaths,
      ...exportPaths,
    ],
    sanitizationDraftKeys: uniqueSorted(
      draftRows.map((row) => requiredString(row.key, 'sanitization draft key')),
    ),
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

export function createPlan(snapshot: DeletionSnapshot, scope: LocalDeletionScope): DeletionPlan {
  const deleted = sumDeletedCounts(snapshot, scope);
  const allHealth = deletesAllHealth(scope);
  const includeReports = scope === 'reports' || scope === 'media' || allHealth;
  const includeRecords = scope === 'records' || allHealth;
  const includeEvents = scope === 'events' || allHealth;
  const reportIds = allHealth || scope === 'media' ? snapshot.allReportIds : snapshot.reportIds;
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
          (scope === 'reports' || scope === 'media' || allHealth) &&
          reference.ownerId !== null &&
          selectedReports.has(reference.ownerId)
        );
      case 'intake-image':
        return (
          (scope === 'media' || allHealth || scope === 'events') &&
          reference.ownerId !== null &&
          (scope === 'media' || allHealth || selectedEvents.has(reference.ownerId))
        );
      case 'cloud-job-media':
        return (
          scope === 'media' ||
          allHealth ||
          (scope === 'events' &&
            reference.ownerId !== null &&
            selectedEvents.has(reference.ownerId))
        );
      case 'capture-recovery-media':
        return scope === 'media' || allHealth || scope === 'events';
      case 'export':
        return allHealth;
    }
  });
  const planInput = {
    scope,
    counts: snapshot.counts,
    deleted,
    targetIds,
    fileReferences: uniquePathReferences(fileReferences),
    sanitizationDraftKeys: includeReports ? snapshot.sanitizationDraftKeys : [],
  };
  return {
    scope,
    planHash: localDeletionPlanHash(planInput),
    counts: snapshot.counts,
    willRemain: subtractCounts(snapshot.counts, deleted),
    targetIds,
    fileReferences: planInput.fileReferences,
    sanitizationDraftKeys: planInput.sanitizationDraftKeys,
  };
}

export function referenceSelectedByPlan(reference: PathReference, plan: DeletionPlan): boolean {
  const selectedReports = new Set(plan.targetIds.reportIds);
  const selectedEvents = new Set(plan.targetIds.eventIds);
  const allHealth = deletesAllHealth(plan.scope);
  switch (reference.category) {
    case 'original-report':
    case 'report-page':
    case 'sanitized-report':
      return reference.ownerId !== null && selectedReports.has(reference.ownerId);
    case 'intake-image':
      return (
        (plan.scope === 'media' || allHealth || plan.scope === 'events') &&
        reference.ownerId !== null &&
        (plan.scope !== 'events' || selectedEvents.has(reference.ownerId))
      );
    case 'cloud-job-media':
      return (
        plan.scope === 'media' ||
        allHealth ||
        (plan.scope === 'events' &&
          reference.ownerId !== null &&
          selectedEvents.has(reference.ownerId))
      );
    case 'capture-recovery-media':
      return plan.scope === 'media' || allHealth || plan.scope === 'events';
    case 'export':
      return allHealth;
  }
}

export function planJson(plan: DeletionPlan): string {
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
