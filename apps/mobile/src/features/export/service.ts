import { catalogueManifest } from '@alyte/catalogue';
import { EXTRACTION_PARSER_VERSION, VISION_OCR_CONTRACT_VERSION } from '@alyte/domain';
import { createSortableOpaqueId } from '@alyte/domain';
import {
  createProtectedDatabaseBoundary,
  type ProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import { nativeDatabaseProtection, type DatabaseProtection } from '../local-database/protection';
import {
  createProtectedReportFileService,
  type ProtectedExportFile,
  type ProtectedExportWorkspace,
  type ProtectedReportFileService,
} from '../labs/file-service';
import {
  nativeZipArchive,
  type ZipArchiveAdapter,
  type ZipExpectedEntry,
} from '../labs/protection';
import {
  EXPORT_VERSION,
  SANITIZATION_VERSION,
  canonicalJson,
  exportTextOutputs,
  manifestJson,
  textByteLength,
  type ExportManifest,
  type ExportMediaCategory,
  type ExportMediaFile,
  type ExportOutputDescriptor,
  type ExportSelection,
  type ExportSnapshot,
  type ExportTableName,
} from './export-contract';
import { ExportSchemaIncompleteError, readExportSnapshot } from './snapshot-reader';

export type LocalExportJobState =
  'staging' | 'archiving' | 'ready' | 'failed' | 'cancelled' | 'completed';

export type LocalExportFailureCategory =
  | 'abandoned'
  | 'archive-failed'
  | 'cancelled'
  | 'database-failed'
  | 'invalid-selection'
  | 'media-invalid'
  | 'protection-failed'
  | 'schema-incomplete'
  | 'stored-hash-mismatch'
  | 'unknown';

export type LocalExportJob = {
  readonly id: string;
  readonly state: LocalExportJobState;
  readonly selection: ExportSelection;
  readonly portableStagingReference: string | null;
  readonly portableArchiveReference: string | null;
  readonly failureCategory: LocalExportFailureCategory | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly readyAt: string | null;
};

export type PreparedLocalExport = {
  readonly job: LocalExportJob;
  readonly archiveReference: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly manifest: ExportManifest;
};

export type ExportDatabase = SqliteDatabase;
export type ExportDatabaseSession = {
  readonly database: ExportDatabase;
  readonly close: () => Promise<void>;
};

export type ExportFiles = Pick<
  Required<ProtectedReportFileService>,
  | 'createExportWorkspace'
  | 'writeExportFile'
  | 'copyExportMedia'
  | 'inspectExportSource'
  | 'protectExportArchive'
  | 'removeExportArtifacts'
  | 'removeExportArtifactsByReference'
>;

export type LocalExportService = {
  prepare(input?: {
    readonly jobId?: string;
    readonly selection?: ExportSelection;
    readonly locale?: string;
  }): Promise<PreparedLocalExport>;
  /** Typed handoff boundary reserved for the later share lifecycle (#55). */
  prepareForShare(input?: {
    readonly jobId?: string;
    readonly selection?: ExportSelection;
    readonly locale?: string;
  }): Promise<PreparedLocalExport>;
  completeShare(jobId: string): Promise<LocalExportJob>;
  cancelShare(jobId: string): Promise<LocalExportJob>;
  getJob(jobId: string): Promise<LocalExportJob | null>;
  reconcile(): Promise<void>;
};

type ExportServiceOptions = {
  readonly databaseFactory: () => Promise<ExportDatabaseSession>;
  readonly files: ExportFiles;
  readonly archive: ZipArchiveAdapter;
  readonly appVersion?: string;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
};

type JobRow = {
  readonly id: unknown;
  readonly state: unknown;
  readonly selection_json: unknown;
  readonly portable_staging_reference: unknown;
  readonly portable_archive_reference: unknown;
  readonly failure_category: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly ready_at: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function decodeSelection(value: unknown): ExportSelection {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid export selection');
  const candidate = value as Record<string, unknown>;
  const list = (key: keyof ExportSelection): readonly string[] | undefined => {
    const raw = candidate[key];
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.some((entry) => typeof entry !== 'string' || entry.length === 0)
    ) {
      throw new Error('Invalid export selection IDs');
    }
    return [...new Set(raw)].sort();
  };
  const originalReportIds = list('originalReportIds');
  const sanitizedReportDerivativeIds = list('sanitizedReportDerivativeIds');
  const intakeImageEventIds = list('intakeImageEventIds');
  return {
    ...(originalReportIds === undefined ? {} : { originalReportIds }),
    ...(sanitizedReportDerivativeIds === undefined ? {} : { sanitizedReportDerivativeIds }),
    ...(intakeImageEventIds === undefined ? {} : { intakeImageEventIds }),
  };
}

function normalizedSelection(selection: ExportSelection = {}): ExportSelection {
  return decodeSelection({
    originalReportIds: selection.originalReportIds ?? [],
    sanitizedReportDerivativeIds: selection.sanitizedReportDerivativeIds ?? [],
    intakeImageEventIds: selection.intakeImageEventIds ?? [],
  });
}

function decodeJob(row: JobRow): LocalExportJob {
  const state = requiredString(row.state, 'export job state');
  if (!['staging', 'archiving', 'ready', 'failed', 'cancelled', 'completed'].includes(state)) {
    throw new Error('Invalid export job state');
  }
  const rawFailure = nullableString(row.failure_category, 'export failure category');
  const failures: readonly LocalExportFailureCategory[] = [
    'abandoned',
    'archive-failed',
    'cancelled',
    'database-failed',
    'invalid-selection',
    'media-invalid',
    'protection-failed',
    'schema-incomplete',
    'stored-hash-mismatch',
    'unknown',
  ];
  if (rawFailure !== null && !failures.includes(rawFailure as LocalExportFailureCategory)) {
    throw new Error('Invalid export failure category');
  }
  let selection: unknown;
  try {
    selection = JSON.parse(requiredString(row.selection_json, 'export selection')) as unknown;
  } catch (error) {
    throw new Error('Invalid export selection JSON', { cause: error });
  }
  return {
    id: requiredString(row.id, 'export job id'),
    state: state as LocalExportJobState,
    selection: decodeSelection(selection),
    portableStagingReference: nullableString(
      row.portable_staging_reference,
      'portable export staging reference',
    ),
    portableArchiveReference: nullableString(
      row.portable_archive_reference,
      'portable export archive reference',
    ),
    failureCategory: rawFailure as LocalExportFailureCategory | null,
    createdAt: requiredString(row.created_at, 'export job created timestamp'),
    updatedAt: requiredString(row.updated_at, 'export job updated timestamp'),
    readyAt: nullableString(row.ready_at, 'export job ready timestamp'),
  };
}

function failureCategory(error: unknown): LocalExportFailureCategory {
  if (error instanceof ExportSchemaIncompleteError) return 'schema-incomplete';
  const value = (error as { readonly failureCategory?: unknown })?.failureCategory;
  if (value === 'cancelled') return 'cancelled';
  if (value === 'checksum-mismatch') return 'stored-hash-mismatch';
  if (value === 'symlink-rejected' || value === 'path-escape' || value === 'invalid-input') {
    return 'media-invalid';
  }
  if (value === 'archive-failure' || value === 'entry-mismatch') return 'archive-failed';
  if (value === 'protection-failed') return 'protection-failed';
  if (error instanceof Error && error.message.includes('selection')) return 'invalid-selection';
  if (error instanceof Error && error.message.includes('protected')) return 'protection-failed';
  if (error instanceof Error && error.message.includes('database')) return 'database-failed';
  return 'unknown';
}

function rowId(
  table: ExportSnapshot['tables'][number],
  id: string,
): Readonly<Record<string, unknown>> {
  const idColumn = table.name === 'intake_capture_recovery' ? 'capture_id' : 'id';
  const row = table.rows.find((candidate) => candidate[idColumn] === id);
  if (row === undefined) throw new Error('The selected export record is not in the snapshot');
  return row;
}

function rowString(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : requiredString(value, key);
}

function storedHash(row: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const hash = requiredString(value, key);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`Invalid stored ${key}`);
  return hash;
}

function mediaArchiveId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]/gu, '-');
  if (safe.length === 0) throw new Error('Invalid selected media ID');
  return safe;
}

type SelectedMedia = {
  readonly category: ExportMediaCategory;
  readonly id: string;
  readonly path: string | null;
  readonly storedHash: string | null;
  readonly archivePath: string;
};

function selectedMedia(
  snapshot: ExportSnapshot,
  selection: ExportSelection,
): readonly SelectedMedia[] {
  const table = (name: ExportTableName) => {
    const found = snapshot.tables.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error('The export snapshot is incomplete');
    return found;
  };
  const reports = table('lab_reports');
  const sanitized = table('sanitized_report_derivatives');
  const intake = table('intake_events');
  const result: SelectedMedia[] = [];
  for (const id of selection.originalReportIds ?? []) {
    const row = rowId(reports, id);
    result.push({
      category: 'original-reports',
      id,
      path: rowString(row, 'original_path'),
      storedHash: storedHash(row, 'source_hash'),
      archivePath: `media/original-reports/${mediaArchiveId(id)}`,
    });
  }
  for (const id of selection.sanitizedReportDerivativeIds ?? []) {
    const row = rowId(sanitized, id);
    result.push({
      category: 'sanitized-reports',
      id,
      path: rowString(row, 'artifact_path'),
      storedHash: storedHash(row, 'artifact_hash'),
      archivePath: `media/sanitized-reports/${mediaArchiveId(id)}`,
    });
  }
  for (const id of selection.intakeImageEventIds ?? []) {
    const row = rowId(intake, id);
    result.push({
      category: 'intake-images',
      id,
      path: rowString(row, 'source_media_path'),
      storedHash: storedHash(row, 'source_media_hash'),
      archivePath: `media/intake-images/${mediaArchiveId(id)}`,
    });
  }
  return result;
}

function outputDescriptor(
  file: ProtectedExportFile,
  rows: number,
  fallbackBytes: number,
): ExportOutputDescriptor {
  if (file.sourceHash.length !== 64) throw new Error('Invalid export output hash');
  return {
    path: file.relativePath,
    rows,
    bytes: file.byteSize ?? fallbackBytes,
    sha256: file.sourceHash,
  };
}

function mediaCategorySelection(
  selection: ExportSelection,
): Readonly<Record<ExportMediaCategory, boolean>> {
  return {
    'original-reports': (selection.originalReportIds?.length ?? 0) > 0,
    'sanitized-reports': (selection.sanitizedReportDerivativeIds?.length ?? 0) > 0,
    'intake-images': (selection.intakeImageEventIds?.length ?? 0) > 0,
  };
}

function includedCategories(snapshot: ExportSnapshot): readonly string[] {
  return snapshot.tables.map((table) => table.name).sort();
}

async function writeTextOutput(
  files: ExportFiles,
  workspace: ProtectedExportWorkspace,
  output: { readonly path: string; readonly content: string; readonly rows: number },
): Promise<ExportOutputDescriptor> {
  const file = await files.writeExportFile(workspace, output.path, output.content);
  return outputDescriptor(file, output.rows, textByteLength(output.content));
}

async function selectedMediaFile(
  files: ExportFiles,
  workspace: ProtectedExportWorkspace,
  media: SelectedMedia,
): Promise<ExportMediaFile> {
  if (media.path === null) {
    return {
      category: media.category,
      id: media.id,
      sourcePath: null,
      archivePath: media.archivePath,
      status: 'missing',
      bytes: null,
      sha256: null,
    };
  }
  const source = await files.inspectExportSource(media.path, media.category);
  if (source === null) {
    return {
      category: media.category,
      id: media.id,
      sourcePath: sourcePathForManifest(media.path),
      archivePath: media.archivePath,
      status: 'missing',
      bytes: null,
      sha256: null,
    };
  }
  if (media.storedHash !== null && media.storedHash !== source.sourceHash) {
    throw Object.assign(new Error('Selected media hash does not match its stored hash'), {
      failureCategory: 'checksum-mismatch',
    });
  }
  const copied = await files.copyExportMedia(workspace, source, media.archivePath);
  return {
    category: media.category,
    id: media.id,
    sourcePath: source.portablePath,
    archivePath: media.archivePath,
    status: 'present',
    bytes: copied.byteSize ?? source.byteSize,
    sha256: copied.sourceHash,
  };
}

function sourcePathForManifest(path: string): string {
  if (path.startsWith('protected://')) return path;
  // The file owner accepts legacy container paths only to rebase them. Do not expose the
  // absolute path in the manifest if a missing artifact has one.
  return 'protected://missing';
}

async function readJob(database: ExportDatabase, id: string): Promise<LocalExportJob | null> {
  const rows = await database.getAllAsync<JobRow>(
    `SELECT id, state, selection_json, portable_staging_reference,
       portable_archive_reference, failure_category, created_at, updated_at, ready_at
     FROM local_export_jobs WHERE id = ?;`,
    id,
  );
  return rows[0] === undefined ? null : decodeJob(rows[0]);
}

async function writeJobState(
  database: ExportDatabase,
  input: {
    readonly id: string;
    readonly state: LocalExportJobState;
    readonly now: string;
    readonly staging?: string | null;
    readonly archive?: string | null;
    readonly failure?: LocalExportFailureCategory | null;
  },
): Promise<void> {
  const timestampColumn =
    input.state === 'staging'
      ? 'staging_started_at'
      : input.state === 'archiving'
        ? 'archiving_started_at'
        : input.state === 'ready'
          ? 'ready_at'
          : input.state === 'failed'
            ? 'failed_at'
            : input.state === 'cancelled'
              ? 'cancelled_at'
              : 'completed_at';
  await database.runAsync(
    `UPDATE local_export_jobs
     SET state = ?, portable_staging_reference = COALESCE(?, portable_staging_reference),
       portable_archive_reference = COALESCE(?, portable_archive_reference),
       failure_category = ?, updated_at = ?, ${timestampColumn} = ?
     WHERE id = ?;`,
    input.state,
    input.staging ?? null,
    input.archive ?? null,
    input.failure ?? null,
    input.now,
    input.now,
    input.id,
  );
}

export function createLocalExportService(options: ExportServiceOptions): LocalExportService {
  const now = options.now ?? (() => new Date().toISOString());
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const appVersion = options.appVersion ?? '0.1.0';

  async function prepare(
    input: {
      readonly jobId?: string;
      readonly selection?: ExportSelection;
      readonly locale?: string;
    } = {},
  ): Promise<PreparedLocalExport> {
    const session = await options.databaseFactory();
    const database = session.database;
    const id = input.jobId ?? makeId('export-job');
    const selection = normalizedSelection(input.selection);
    const createdAt = now();
    let workspace: ProtectedExportWorkspace | null = null;
    try {
      await database.runAsync(
        `INSERT INTO local_export_jobs
         (id, state, selection_json, created_at, updated_at, staging_started_at)
         VALUES (?, 'staging', ?, ?, ?, ?);`,
        id,
        canonicalJson(selection),
        createdAt,
        createdAt,
        createdAt,
      );
      workspace = await options.files.createExportWorkspace(id);
      await writeJobState(database, {
        id,
        state: 'staging',
        now: now(),
        staging: workspace.portableStagingReference,
      });

      const snapshot = await readExportSnapshot(database);
      const textOutputs = exportTextOutputs(snapshot);
      const outputDescriptors: ExportOutputDescriptor[] = [];
      for (const output of textOutputs) {
        outputDescriptors.push(await writeTextOutput(options.files, workspace, output));
      }

      const mediaFiles: ExportMediaFile[] = [];
      for (const media of selectedMedia(snapshot, selection)) {
        mediaFiles.push(await selectedMediaFile(options.files, workspace, media));
      }
      await writeJobState(database, { id, state: 'archiving', now: now() });

      const archiveEntries: ZipExpectedEntry[] = [
        ...outputDescriptors.map((output) => ({
          path: output.path,
          bytes: output.bytes,
          sha256: output.sha256,
        })),
        ...mediaFiles
          .filter(
            (media): media is ExportMediaFile & { readonly status: 'present' } =>
              media.status === 'present',
          )
          .map((media) => ({
            path: media.archivePath,
            bytes: media.bytes ?? 0,
            sha256: media.sha256 ?? '',
          })),
      ];
      const manifest: ExportManifest = {
        schemaVersion: 'alyte.export.manifest.v1',
        exportVersion: EXPORT_VERSION,
        appVersion,
        localSchemaVersion: snapshot.schemaVersion,
        catalogueVersion: catalogueManifest.version ?? null,
        ocrContractVersion: VISION_OCR_CONTRACT_VERSION,
        parserVersion: EXTRACTION_PARSER_VERSION,
        sanitizationVersion: SANITIZATION_VERSION,
        createdAt,
        locale: input.locale ?? 'en-US',
        included: {
          categories: includedCategories(snapshot),
          media: mediaCategorySelection(selection),
        },
        tables: snapshot.tables.map((table) => ({ name: table.name, rows: table.rows.length })),
        outputs: outputDescriptors,
        media: {
          selected: mediaFiles.length,
          present: mediaFiles.filter((media) => media.status === 'present').length,
          missing: mediaFiles.filter((media) => media.status === 'missing').length,
          files: mediaFiles,
        },
        // A manifest cannot contain a cryptographic hash of the ZIP that contains the manifest
        // without a self-referential fixed point. The prepare result carries the verified final
        // archive hash and size; this field is null until a future envelope can carry that hash.
        archive: null,
      };
      const manifestOutput = await writeTextOutput(options.files, workspace, {
        path: 'manifest.json',
        content: manifestJson(manifest),
        rows: 1,
      });
      archiveEntries.push({
        path: manifestOutput.path,
        bytes: manifestOutput.bytes,
        sha256: manifestOutput.sha256,
      });
      archiveEntries.sort((left, right) => left.path.localeCompare(right.path));
      const zipResult = await options.archive.createZip({
        operationId: id,
        stagingPath: workspace.stagingPath,
        partialArchivePath: workspace.archivePartialPath,
        entries: archiveEntries,
      });
      if (zipResult.entryCount !== archiveEntries.length)
        throw new Error('Archive entry count mismatch');
      await options.archive.promoteZip({
        operationId: id,
        partialArchivePath: workspace.archivePartialPath,
        archivePath: workspace.archivePath,
      });
      const archiveArtifact = await options.files.protectExportArchive(workspace.archivePath);
      if (archiveArtifact.byteSize === null) throw new Error('Export archive size was unavailable');
      await writeJobState(database, {
        id,
        state: 'ready',
        now: now(),
        archive: workspace.portableArchiveReference,
      });
      const job = await readJob(database, id);
      if (job === null) throw new Error('Prepared export job disappeared');
      return {
        job,
        archiveReference: workspace.portableArchiveReference,
        archiveSha256: archiveArtifact.sourceHash,
        archiveBytes: archiveArtifact.byteSize,
        manifest,
      };
    } catch (error) {
      if (workspace !== null) {
        try {
          await options.files.removeExportArtifacts(workspace);
        } catch {
          // The durable failure state remains authoritative; reconciliation retries cleanup.
        }
      }
      try {
        await writeJobState(database, {
          id,
          state: 'failed',
          now: now(),
          failure: failureCategory(error),
        });
      } catch {
        // A database failure cannot be made more observable by logging health content.
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  async function completeShare(jobId: string): Promise<LocalExportJob> {
    return transitionTerminal(jobId, 'completed');
  }

  async function cancelShare(jobId: string): Promise<LocalExportJob> {
    return transitionTerminal(jobId, 'cancelled');
  }

  async function transitionTerminal(
    jobId: string,
    state: 'completed' | 'cancelled',
  ): Promise<LocalExportJob> {
    const session = await options.databaseFactory();
    try {
      const job = await readJob(session.database, jobId);
      if (job === null) throw new Error('Export job was not found');
      if (job.state !== 'ready' && job.state !== 'staging' && job.state !== 'archiving') {
        return job;
      }
      await options.files.removeExportArtifactsByReference(
        job.portableStagingReference,
        job.portableArchiveReference,
      );
      await writeJobState(session.database, {
        id: jobId,
        state,
        now: now(),
        failure: state === 'cancelled' ? 'cancelled' : null,
      });
      const next = await readJob(session.database, jobId);
      if (next === null) throw new Error('Export job disappeared during completion');
      return next;
    } finally {
      await session.close();
    }
  }

  async function getJob(jobId: string): Promise<LocalExportJob | null> {
    const session = await options.databaseFactory();
    try {
      return await readJob(session.database, jobId);
    } finally {
      await session.close();
    }
  }

  async function reconcile(): Promise<void> {
    const session = await options.databaseFactory();
    try {
      const rows = await session.database.getAllAsync<JobRow>(
        `SELECT id, state, selection_json, portable_staging_reference,
           portable_archive_reference, failure_category, created_at, updated_at, ready_at
         FROM local_export_jobs WHERE state IN ('staging', 'archiving') ORDER BY created_at ASC;`,
      );
      for (const row of rows) {
        const job = decodeJob(row);
        try {
          await options.files.removeExportArtifactsByReference(
            job.portableStagingReference,
            job.portableArchiveReference,
          );
          await writeJobState(session.database, {
            id: job.id,
            state: 'failed',
            now: now(),
            failure: 'abandoned',
          });
        } catch {
          // Invalid/unowned references remain observable as failed without attempting an unsafe path.
          await writeJobState(session.database, {
            id: job.id,
            state: 'failed',
            now: now(),
            failure: 'protection-failed',
          });
        }
      }
    } finally {
      await session.close();
    }
  }

  return {
    prepare,
    prepareForShare: prepare,
    completeShare,
    cancelShare,
    getJob,
    reconcile,
  };
}

export async function openProtectedExportDatabase(
  options: { readonly databaseName?: string; readonly protection?: DatabaseProtection } = {},
): Promise<ExportDatabaseSession> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  const database = await openDatabaseAsync(options.databaseName ?? 'alyte-local.sqlite', {
    useNewConnection: true,
  });
  const boundary: ProtectedDatabaseBoundary = createProtectedDatabaseBoundary(database, {
    protection: options.protection ?? nativeDatabaseProtection,
  });
  try {
    await boundary.initialize();
    return { database, close: boundary.close };
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

export function createDefaultLocalExportService(
  options: {
    readonly protection?: DatabaseProtection;
  } = {},
): LocalExportService {
  const files = createProtectedReportFileService();
  return createLocalExportService({
    databaseFactory: () => openProtectedExportDatabase(options),
    files: files as ExportFiles,
    archive: nativeZipArchive,
  });
}
