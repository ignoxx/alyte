import {
  assertLabReportDeletionState,
  assertLabReportImportState,
  assertLabReportPage,
  assertLabReportSourceType,
  createSortableOpaqueId,
  type CreateLabReportInput,
  type CreateLabReportPageInput,
  type LabReport,
  type LabReportPage,
  type UpdateLabReportInput,
} from '@alyte/domain';
import type { SqliteDatabase } from './persistence';

type LabReportRow = {
  id: unknown;
  source_type: unknown;
  original_filename: unknown;
  mime_type: unknown;
  byte_size: unknown;
  source_hash: unknown;
  original_path: unknown;
  import_state: unknown;
  failure_reason: unknown;
  encrypted: unknown;
  page_count: unknown;
  created_at: unknown;
  updated_at: unknown;
  imported_at: unknown;
  deletion_state: unknown;
  deletion_requested_at: unknown;
  deletion_error: unknown;
};

type LabReportPageRow = {
  id: unknown;
  report_id: unknown;
  page_index: unknown;
  width: unknown;
  height: unknown;
  rotation: unknown;
  crop: unknown;
  derived_path: unknown;
};

export type ReportWriteTransaction = <T>(work: () => Promise<T>) => Promise<T>;

export type LabReportRepository = {
  listReports(): Promise<readonly LabReport[]>;
  getReport(id: string): Promise<LabReport | null>;
  findReportByHash(sourceHash: string): Promise<LabReport | null>;
  createReport(input: CreateLabReportInput): Promise<LabReport>;
  updateReport(id: string, input: UpdateLabReportInput): Promise<LabReport>;
  requestReportDeletion(id: string): Promise<LabReport>;
  failReportDeletion(id: string, reason: string): Promise<LabReport>;
  completeReportDeletion(id: string): Promise<LabReport>;
  deleteReport(id: string): Promise<void>;
  reconcileInterruptedReports(): Promise<void>;
  listDeletionCandidates(): Promise<readonly LabReport[]>;
  countReportsReferencingPath(path: string, excludingId?: string): Promise<number>;
};

export type LabReportRepositoryOptions = {
  readonly database: SqliteDatabase;
  readonly initialize: () => Promise<void>;
  readonly withWrite: ReportWriteTransaction;
  readonly now: () => string;
  readonly idGenerator?: (prefix: string) => string;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${field} in local database`);
  return value;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value;
}

function reportPage(row: LabReportPageRow): LabReportPage {
  const pageIndex = row.page_index;
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Invalid Lab Report page index in local database');
  }
  const rotation = row.rotation;
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    throw new Error('Invalid Lab Report page rotation in local database');
  }
  return {
    id: requiredString(row.id, 'Lab Report page id'),
    reportId: requiredString(row.report_id, 'Lab Report page report id'),
    pageIndex,
    width: nullableFiniteNumber(row.width, 'Lab Report page width'),
    height: nullableFiniteNumber(row.height, 'Lab Report page height'),
    rotation,
    crop: nullableString(row.crop, 'Lab Report page crop'),
    derivedPath: nullableString(row.derived_path, 'Lab Report page derived path'),
  };
}

export function decodeLabReportRow(row: LabReportRow): Omit<LabReport, 'pages' | 'labRecordIds'> {
  if (row.source_type !== 'pdf' && row.source_type !== 'image') {
    throw new Error('Invalid Lab Report source type in local database');
  }
  if (
    row.import_state !== 'importing' &&
    row.import_state !== 'imported' &&
    row.import_state !== 'interrupted' &&
    row.import_state !== 'failed' &&
    row.import_state !== 'deleted'
  ) {
    throw new Error('Invalid Lab Report import state in local database');
  }
  if (row.encrypted !== 0 && row.encrypted !== 1) {
    throw new Error('Invalid Lab Report encryption state in local database');
  }
  if (
    row.deletion_state !== 'none' &&
    row.deletion_state !== 'requested' &&
    row.deletion_state !== 'failed' &&
    row.deletion_state !== 'complete'
  ) {
    throw new Error('Invalid Lab Report deletion state in local database');
  }
  const pageCount = nullableFiniteNumber(row.page_count, 'Lab Report page count');
  const byteSize = nullableFiniteNumber(row.byte_size, 'Lab Report byte size');
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 0)) {
    throw new Error('Invalid Lab Report page count in local database');
  }
  if (byteSize !== null && (!Number.isInteger(byteSize) || byteSize < 0)) {
    throw new Error('Invalid Lab Report byte size in local database');
  }
  return {
    id: requiredString(row.id, 'Lab Report id'),
    sourceType: row.source_type,
    originalFilename: requiredString(row.original_filename, 'Lab Report filename'),
    mimeType: requiredString(row.mime_type, 'Lab Report MIME type'),
    byteSize,
    sourceHash: nullableString(row.source_hash, 'Lab Report source hash'),
    originalPath: nullableString(row.original_path, 'Lab Report original path'),
    importState: row.import_state,
    failureReason: nullableString(row.failure_reason, 'Lab Report failure reason'),
    encrypted: row.encrypted === 1,
    pageCount,
    createdAt: requiredString(row.created_at, 'Lab Report created timestamp'),
    updatedAt: requiredString(row.updated_at, 'Lab Report updated timestamp'),
    importedAt: nullableString(row.imported_at, 'Lab Report imported timestamp'),
    deletionState: row.deletion_state,
    deletionRequestedAt: nullableString(
      row.deletion_requested_at,
      'Lab Report deletion requested timestamp',
    ),
    deletionError: nullableString(row.deletion_error, 'Lab Report deletion error'),
  };
}

export function createLabReportRepository(
  options: LabReportRepositoryOptions,
): LabReportRepository {
  const { database, initialize, withWrite, now } = options;
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const columns = `id, source_type, original_filename, mime_type, byte_size, source_hash,
    original_path, import_state, failure_reason, encrypted, page_count, created_at, updated_at,
    imported_at, deletion_state, deletion_requested_at, deletion_error`;

  async function pagesFor(reportId: string): Promise<readonly LabReportPage[]> {
    const rows = await database.getAllAsync<LabReportPageRow>(
      `SELECT id, report_id, page_index, width, height, rotation, crop, derived_path
       FROM lab_report_pages WHERE report_id = ? ORDER BY page_index ASC;`,
      reportId,
    );
    return rows.map(reportPage);
  }

  async function recordsFor(reportId: string): Promise<readonly string[]> {
    const rows = await database.getAllAsync<{ id: unknown }>(
      'SELECT id FROM lab_records WHERE lab_report_id = ? ORDER BY created_at ASC;',
      reportId,
    );
    return rows.map((row) => requiredString(row.id, 'Lab Record id'));
  }

  async function decode(row: LabReportRow): Promise<LabReport> {
    const report = decodeLabReportRow(row);
    return {
      ...report,
      pages: await pagesFor(report.id),
      labRecordIds: await recordsFor(report.id),
    };
  }

  async function listReports(): Promise<readonly LabReport[]> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${columns} FROM lab_reports ORDER BY updated_at DESC, created_at DESC;`,
    );
    return Promise.all(rows.map(decode));
  }

  async function getReport(id: string): Promise<LabReport | null> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${columns} FROM lab_reports WHERE id = ?;`,
      id,
    );
    return rows[0] === undefined ? null : decode(rows[0]);
  }

  async function findReportByHash(sourceHash: string): Promise<LabReport | null> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${columns} FROM lab_reports
       WHERE source_hash = ? AND original_path IS NOT NULL
         AND import_state <> 'deleted' AND deletion_state = 'none'
       ORDER BY updated_at DESC LIMIT 1;`,
      sourceHash,
    );
    return rows[0] === undefined ? null : decode(rows[0]);
  }

  async function writePages(
    reportId: string,
    pages: readonly CreateLabReportPageInput[],
  ): Promise<void> {
    await database.runAsync('DELETE FROM lab_report_pages WHERE report_id = ?;', reportId);
    for (const page of pages) {
      await database.runAsync(
        `INSERT INTO lab_report_pages (
          id, report_id, page_index, width, height, rotation, crop, derived_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        page.id ?? makeId('lab-report-page'),
        reportId,
        page.pageIndex,
        page.width ?? null,
        page.height ?? null,
        page.rotation ?? 0,
        page.crop ?? null,
        page.derivedPath ?? null,
      );
    }
  }

  async function createReport(input: CreateLabReportInput): Promise<LabReport> {
    await initialize();
    assertLabReportSourceType(input.sourceType);
    const importState = input.importState ?? 'importing';
    const deletionState = input.deletionState ?? 'none';
    assertLabReportImportState(importState);
    assertLabReportDeletionState(deletionState);
    if (input.originalFilename.trim().length === 0)
      throw new Error('Lab Report filename is required');
    if (input.mimeType.trim().length === 0) throw new Error('Lab Report MIME type is required');
    const reportId = input.id ?? makeId('lab-report');
    const createdAt = now();
    const pages = input.pages ?? [];
    pages.forEach(assertLabReportPage);
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO lab_reports (
          id, source_type, original_filename, mime_type, byte_size, source_hash, original_path,
          import_state, failure_reason, encrypted, page_count, created_at, updated_at, imported_at,
          deletion_state, deletion_requested_at, deletion_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        reportId,
        input.sourceType,
        input.originalFilename,
        input.mimeType,
        input.byteSize ?? null,
        input.sourceHash ?? null,
        input.originalPath ?? null,
        importState,
        input.failureReason ?? null,
        input.encrypted === true ? 1 : 0,
        input.pageCount ?? null,
        createdAt,
        createdAt,
        input.importedAt ?? null,
        deletionState,
        input.deletionRequestedAt ?? null,
        input.deletionError ?? null,
      );
      await writePages(reportId, pages);
    });
    const report = await getReport(reportId);
    if (report === null) throw new Error('Created Lab Report could not be read back');
    return report;
  }

  async function updateReport(id: string, input: UpdateLabReportInput): Promise<LabReport> {
    await initialize();
    const existing = await getReport(id);
    if (existing === null) throw new Error('Lab Report was not found');
    if (input.importState !== undefined) assertLabReportImportState(input.importState);
    if (input.deletionState !== undefined) assertLabReportDeletionState(input.deletionState);
    if (
      existing.sourceHash !== null &&
      input.sourceHash !== undefined &&
      input.sourceHash !== existing.sourceHash
    ) {
      throw new Error('Original Report hash is immutable');
    }
    if (
      existing.originalPath !== null &&
      input.originalPath !== undefined &&
      input.originalPath !== existing.originalPath &&
      input.importState !== 'deleted'
    ) {
      throw new Error('Original Report path is immutable');
    }
    const pages = input.pages;
    pages?.forEach(assertLabReportPage);
    const next = {
      sourceHash: input.sourceHash === undefined ? existing.sourceHash : input.sourceHash,
      originalPath: input.originalPath === undefined ? existing.originalPath : input.originalPath,
      importState: input.importState ?? existing.importState,
      failureReason:
        input.failureReason === undefined ? existing.failureReason : input.failureReason,
      encrypted: input.encrypted === undefined ? existing.encrypted : input.encrypted,
      pageCount: input.pageCount === undefined ? existing.pageCount : input.pageCount,
      importedAt: input.importedAt === undefined ? existing.importedAt : input.importedAt,
      deletionState: input.deletionState ?? existing.deletionState,
      deletionRequestedAt:
        input.deletionRequestedAt === undefined
          ? existing.deletionRequestedAt
          : input.deletionRequestedAt,
      deletionError:
        input.deletionError === undefined ? existing.deletionError : input.deletionError,
    };
    await withWrite(async () => {
      const result = await database.runAsync(
        `UPDATE lab_reports SET source_hash = ?, original_path = ?, import_state = ?,
          failure_reason = ?, encrypted = ?, page_count = ?, updated_at = ?, imported_at = ?,
          deletion_state = ?, deletion_requested_at = ?, deletion_error = ? WHERE id = ?;`,
        next.sourceHash,
        next.originalPath,
        next.importState,
        next.failureReason,
        next.encrypted ? 1 : 0,
        next.pageCount,
        now(),
        next.importedAt,
        next.deletionState,
        next.deletionRequestedAt,
        next.deletionError,
        id,
      );
      if (result.changes !== 1) throw new Error('Lab Report update did not complete');
      if (pages !== undefined) await writePages(id, pages);
    });
    const report = await getReport(id);
    if (report === null) throw new Error('Updated Lab Report could not be read back');
    return report;
  }

  async function requestReportDeletion(id: string): Promise<LabReport> {
    const existing = await getReport(id);
    if (existing === null) throw new Error('Lab Report was not found');
    if (existing.importState === 'deleted' || existing.deletionState === 'complete') {
      return existing;
    }
    return updateReport(id, {
      deletionState: 'requested',
      deletionRequestedAt: now(),
      deletionError: null,
    });
  }

  async function failReportDeletion(id: string, reason: string): Promise<LabReport> {
    return updateReport(id, { deletionState: 'failed', deletionError: reason });
  }

  async function completeReportDeletion(id: string): Promise<LabReport> {
    return updateReport(id, {
      importState: 'deleted',
      originalPath: null,
      deletionState: 'complete',
      deletionError: null,
      failureReason: 'user-deleted',
    });
  }

  async function deleteReport(id: string): Promise<void> {
    // Repository callers can only create the durable deletion intent. The service owns file
    // reference checks and completion, so a database-only caller cannot erase provenance first.
    await requestReportDeletion(id);
  }

  async function reconcileInterruptedReports(): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await database.runAsync(
        `UPDATE lab_reports SET import_state = 'interrupted', failure_reason = COALESCE(failure_reason,
          CASE WHEN original_path IS NULL THEN 'interrupted-no-protected-source' ELSE 'interrupted' END),
          updated_at = ? WHERE import_state = 'importing';`,
        now(),
      );
    });
  }

  async function listDeletionCandidates(): Promise<readonly LabReport[]> {
    const reports = await listReports();
    return reports.filter(
      (report) => report.deletionState === 'requested' || report.deletionState === 'failed',
    );
  }

  async function countReportsReferencingPath(path: string, excludingId?: string): Promise<number> {
    await initialize();
    const rows = await database.getAllAsync<{ count: unknown }>(
      `SELECT COUNT(*) AS count FROM lab_reports
       WHERE original_path = ? AND import_state <> 'deleted' AND (? IS NULL OR id <> ?);`,
      path,
      excludingId ?? null,
      excludingId ?? null,
    );
    const count = rows[0]?.count;
    if (typeof count !== 'number')
      throw new Error('Invalid Lab Report reference count in local database');
    return count;
  }

  return {
    listReports,
    getReport,
    findReportByHash,
    createReport,
    updateReport,
    requestReportDeletion,
    failReportDeletion,
    completeReportDeletion,
    deleteReport,
    reconcileInterruptedReports,
    listDeletionCandidates,
    countReportsReferencingPath,
  };
}
