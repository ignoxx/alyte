import {
  assertLabReportDeletionState,
  assertLabReportImportState,
  assertLabReportPage,
  assertLabReportSourceType,
  createSanitizationRecipe,
  createSortableOpaqueId,
  type CreateLabReportInput,
  type CreateLabReportPageInput,
  type CreateSanitizedReportInput,
  type LabReport,
  type LabReportPage,
  type SanitizedReport,
  type SanitizedReportVerification,
  type UpdateLabReportInput,
  type UpdateSanitizedReportInput,
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

type SanitizedReportRow = {
  id: unknown;
  report_id: unknown;
  recipe_json: unknown;
  recipe_hash: unknown;
  artifact_path: unknown;
  artifact_hash: unknown;
  byte_size: unknown;
  verification_state: unknown;
  verification_json: unknown;
  failure_reason: unknown;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
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
  getSanitizedReport(reportId: string): Promise<SanitizedReport | null>;
  saveSanitizedReport(input: CreateSanitizedReportInput): Promise<SanitizedReport>;
  updateSanitizedReport(id: string, input: UpdateSanitizedReportInput): Promise<SanitizedReport>;
  deleteSanitizedReport(id: string): Promise<void>;
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

function jsonObject<T>(value: unknown, field: string): T | null {
  if (value === null || value === undefined) return null;
  const serialized = requiredString(value, field);
  try {
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON in local database`, { cause: error });
  }
}

function decodeSanitizedReportRow(row: SanitizedReportRow): SanitizedReport {
  const verificationState = row.verification_state;
  if (
    verificationState !== 'pending' &&
    verificationState !== 'verified' &&
    verificationState !== 'failed' &&
    verificationState !== 'deleted'
  ) {
    throw new Error('Invalid Sanitized Report verification state in local database');
  }
  const rawRecipe = jsonObject<SanitizedReport['recipe']>(row.recipe_json, 'sanitized recipe');
  if (rawRecipe === null || rawRecipe.schemaVersion !== 1) {
    throw new Error('Sanitized Report recipe is missing or unsupported');
  }
  const recipe = createSanitizationRecipe(rawRecipe.reportId, rawRecipe.pages);
  if (recipe.reportId !== requiredString(row.report_id, 'Sanitized Report report id')) {
    throw new Error('Sanitized Report recipe and report ids do not match');
  }
  const verification = jsonObject<SanitizedReportVerification>(
    row.verification_json,
    'sanitized verification',
  );
  return {
    id: requiredString(row.id, 'Sanitized Report id'),
    reportId: recipe.reportId,
    recipe,
    recipeHash: requiredString(row.recipe_hash, 'Sanitized Report recipe hash'),
    artifactPath: nullableString(row.artifact_path, 'Sanitized Report artifact path'),
    artifactHash: nullableString(row.artifact_hash, 'Sanitized Report artifact hash'),
    byteSize: nullableFiniteNumber(row.byte_size, 'Sanitized Report byte size'),
    verificationState,
    verification,
    failureReason: nullableString(row.failure_reason, 'Sanitized Report failure reason'),
    createdAt: requiredString(row.created_at, 'Sanitized Report created timestamp'),
    updatedAt: requiredString(row.updated_at, 'Sanitized Report updated timestamp'),
    deletedAt: nullableString(row.deleted_at, 'Sanitized Report deleted timestamp'),
  };
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

  const sanitizedColumns = `id, report_id, recipe_json, recipe_hash, artifact_path, artifact_hash,
    byte_size, verification_state, verification_json, failure_reason, created_at, updated_at, deleted_at`;

  async function getSanitizedReport(reportId: string): Promise<SanitizedReport | null> {
    await initialize();
    const rows = await database.getAllAsync<SanitizedReportRow>(
      `SELECT ${sanitizedColumns} FROM sanitized_report_derivatives WHERE report_id = ?;`,
      reportId,
    );
    const row = rows[0];
    return row === undefined ? null : decodeSanitizedReportRow(row);
  }

  async function saveSanitizedReport(input: CreateSanitizedReportInput): Promise<SanitizedReport> {
    await initialize();
    const report = await getReport(input.reportId);
    if (report === null) throw new Error('Lab Report was not found');
    const id = input.id ?? makeId('sanitized-report');
    const createdAt = now();
    const state = input.verificationState ?? 'pending';
    const verification = input.verification ?? null;
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO sanitized_report_derivatives (
          id, report_id, recipe_json, recipe_hash, artifact_path, artifact_hash, byte_size,
          verification_state, verification_json, failure_reason, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(report_id) DO UPDATE SET
          id = excluded.id,
          recipe_json = excluded.recipe_json,
          recipe_hash = excluded.recipe_hash,
          artifact_path = excluded.artifact_path,
          artifact_hash = excluded.artifact_hash,
          byte_size = excluded.byte_size,
          verification_state = excluded.verification_state,
          verification_json = excluded.verification_json,
          failure_reason = excluded.failure_reason,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at;`,
        id,
        input.reportId,
        JSON.stringify(input.recipe),
        input.recipeHash,
        input.artifactPath ?? null,
        input.artifactHash ?? null,
        input.byteSize ?? null,
        state,
        verification === null ? null : JSON.stringify(verification),
        input.failureReason ?? null,
        createdAt,
        createdAt,
        input.deletedAt ?? null,
      );
    });
    const saved = await getSanitizedReport(input.reportId);
    if (saved === null) throw new Error('Sanitized Report could not be read back');
    return saved;
  }

  async function updateSanitizedReport(
    id: string,
    input: UpdateSanitizedReportInput,
  ): Promise<SanitizedReport> {
    await initialize();
    const rows = await database.getAllAsync<SanitizedReportRow>(
      `SELECT ${sanitizedColumns} FROM sanitized_report_derivatives WHERE id = ?;`,
      id,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('Sanitized Report was not found');
    const existing = decodeSanitizedReportRow(row);
    const next = {
      recipe: input.recipe ?? existing.recipe,
      recipeHash: input.recipeHash ?? existing.recipeHash,
      artifactPath: input.artifactPath === undefined ? existing.artifactPath : input.artifactPath,
      artifactHash: input.artifactHash === undefined ? existing.artifactHash : input.artifactHash,
      byteSize: input.byteSize === undefined ? existing.byteSize : input.byteSize,
      verificationState: input.verificationState ?? existing.verificationState,
      verification: input.verification === undefined ? existing.verification : input.verification,
      failureReason:
        input.failureReason === undefined ? existing.failureReason : input.failureReason,
      deletedAt: input.deletedAt === undefined ? existing.deletedAt : input.deletedAt,
    };
    await withWrite(async () => {
      const result = await database.runAsync(
        `UPDATE sanitized_report_derivatives SET recipe_json = ?, recipe_hash = ?, artifact_path = ?,
          artifact_hash = ?, byte_size = ?, verification_state = ?, verification_json = ?,
          failure_reason = ?, updated_at = ?, deleted_at = ? WHERE id = ?;`,
        JSON.stringify(next.recipe),
        next.recipeHash,
        next.artifactPath,
        next.artifactHash,
        next.byteSize,
        next.verificationState,
        next.verification === null ? null : JSON.stringify(next.verification),
        next.failureReason,
        now(),
        next.deletedAt,
        id,
      );
      if (result.changes !== 1) throw new Error('Sanitized Report update did not complete');
    });
    const saved = await getSanitizedReport(existing.reportId);
    if (saved === null) throw new Error('Updated Sanitized Report could not be read back');
    return saved;
  }

  async function deleteSanitizedReport(id: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      const result = await database.runAsync(
        'DELETE FROM sanitized_report_derivatives WHERE id = ?;',
        id,
      );
      if (result.changes !== 1) return;
    });
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
    getSanitizedReport,
    saveSanitizedReport,
    updateSanitizedReport,
    deleteSanitizedReport,
  };
}
