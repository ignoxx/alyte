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
  type ProtectedExportWorkspaceReferences,
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
  | 'cleanup-pending'
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

export type LocalExportProgress = {
  readonly operationId: string;
  readonly phase: 'staging' | 'archiving' | 'promoting' | 'ready' | 'cancelled' | 'failed';
  readonly completedEntries: number;
  readonly totalEntries: number;
  readonly completedBytes: number;
  readonly totalBytes: number;
};

export type LocalExportOperation = {
  readonly operationId: string;
  readonly promise: Promise<PreparedLocalExport>;
  readonly subscribe: (listener: (progress: LocalExportProgress) => void) => () => void;
  readonly cancel: () => Promise<LocalExportJob>;
};

export type ExportDatabase = SqliteDatabase;
export type ExportDatabaseSession = {
  readonly database: ExportDatabase;
  readonly close: () => Promise<void>;
};

export type ExportFiles = Pick<
  Required<ProtectedReportFileService>,
  | 'createExportWorkspace'
  | 'exportWorkspaceReferences'
  | 'writeExportFile'
  | 'copyExportMedia'
  | 'inspectExportSource'
  | 'protectExportArchive'
  | 'removeExportArtifacts'
  | 'removeExportArtifactsByReference'
> &
  Pick<ProtectedReportFileService, 'resolvePath'>;

export type LocalExportService = {
  start(input?: {
    readonly jobId?: string;
    readonly selection?: ExportSelection;
    readonly locale?: string;
  }): LocalExportOperation;
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
  /** Resolve a protected portable reference only for the system share controller. */
  sharePath(jobId: string): Promise<string>;
  startup(): Promise<void>;
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

class ExportCancelledError extends Error {
  override readonly name = 'ExportCancelledError';
  readonly failureCategory = 'cancelled' as const;

  constructor() {
    super('The export was cancelled');
  }
}

class ExportCleanupPendingError extends Error {
  override readonly name = 'ExportCleanupPendingError';
  readonly failureCategory = 'cleanup-pending' as const;

  constructor() {
    super('Export cleanup is pending and will be retried');
  }
}

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
    'cleanup-pending',
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
  if (error instanceof ExportCleanupPendingError) return 'cleanup-pending';
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
    readonly expectedState?: LocalExportJobState;
  },
): Promise<number> {
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
  const expectedClause = input.expectedState === undefined ? '' : ' AND state = ?';
  const result = await database.runAsync(
    `UPDATE local_export_jobs
     SET state = ?, portable_staging_reference = COALESCE(?, portable_staging_reference),
       portable_archive_reference = COALESCE(?, portable_archive_reference),
       failure_category = ?, updated_at = ?, ${timestampColumn} = ?
     WHERE id = ?${expectedClause};`,
    input.state,
    input.staging ?? null,
    input.archive ?? null,
    input.failure ?? null,
    input.now,
    input.now,
    input.id,
    ...(input.expectedState === undefined ? [] : [input.expectedState]),
  );
  return result.changes;
}

export function createLocalExportService(options: ExportServiceOptions): LocalExportService {
  const now = options.now ?? (() => new Date().toISOString());
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const appVersion = options.appVersion ?? '0.1.0';

  type OperationContext = {
    readonly operationId: string;
    readonly listeners: Set<(progress: LocalExportProgress) => void>;
    readonly jobCreated: Promise<void>;
    readonly resolveJobCreated: () => void;
    readonly rejectJobCreated: (error: unknown) => void;
    promise?: Promise<PreparedLocalExport>;
    progress: LocalExportProgress;
    workspace: ProtectedExportWorkspace | null;
    archiveInFlight: boolean;
    cancelRequested: boolean;
  };

  const activeOperations = new Map<string, OperationContext>();
  let startupPromise: Promise<void> | null = null;
  let startupFailure: Error | null = null;

  function progressFor(
    operationId: string,
    phase: LocalExportProgress['phase'],
    completedEntries = 0,
    totalEntries = 0,
    completedBytes = 0,
    totalBytes = 0,
  ): LocalExportProgress {
    return {
      operationId,
      phase,
      completedEntries,
      totalEntries,
      completedBytes,
      totalBytes,
    };
  }

  function publish(context: OperationContext, progress: LocalExportProgress): void {
    context.progress = progress;
    for (const listener of context.listeners) {
      try {
        listener(progress);
      } catch {
        // Progress observers are advisory; an observer cannot interrupt protected export work.
      }
    }
  }

  function ensureNotCancelled(context: OperationContext): void {
    if (context.cancelRequested) throw new ExportCancelledError();
  }

  async function cleanupReferences(
    stagingReference: string | null,
    archiveReference: string | null,
  ): Promise<void> {
    await options.files.removeExportArtifactsByReference(stagingReference, archiveReference);
  }

  async function reconcileJobs(): Promise<void> {
    const session = await options.databaseFactory();
    try {
      const rows = await session.database.getAllAsync<JobRow>(
        `SELECT id, state, selection_json, portable_staging_reference,
           portable_archive_reference, failure_category, created_at, updated_at, ready_at
         FROM local_export_jobs
         WHERE state IN ('staging', 'archiving')
            OR (state = 'failed' AND failure_category = 'cleanup-pending')
         ORDER BY created_at ASC;`,
      );
      for (const row of rows) {
        const job = decodeJob(row);
        try {
          await cleanupReferences(job.portableStagingReference, job.portableArchiveReference);
          await writeJobState(session.database, {
            id: job.id,
            state: 'failed',
            now: now(),
            failure: 'abandoned',
          });
        } catch {
          // Keep the failure retryable without putting health data, paths, or native details in
          // an error/log payload. The next protected startup retries this same owned reference.
          await writeJobState(session.database, {
            id: job.id,
            state: 'failed',
            now: now(),
            failure: 'cleanup-pending',
          });
        }
      }
    } finally {
      await session.close();
    }
  }

  async function startup(): Promise<void> {
    if (startupFailure !== null) throw startupFailure;
    if (startupPromise === null) {
      startupPromise = reconcileJobs().catch(() => {
        startupFailure = new Error('Export startup reconciliation failed; retry is available');
        throw startupFailure;
      });
    }
    return startupPromise;
  }

  async function ensureStarted(): Promise<void> {
    await startup();
  }

  async function prepareOperation(
    context: OperationContext,
    input: {
      readonly selection?: ExportSelection;
      readonly locale?: string;
    },
  ): Promise<PreparedLocalExport> {
    const session = await options.databaseFactory();
    const database = session.database;
    const id = context.operationId;
    const selection = normalizedSelection(input.selection);
    const createdAt = now();
    let inserted = false;
    let jobReferences: ProtectedExportWorkspaceReferences;
    let totalEntries = 0;
    let completedEntries = 0;
    let completedBytes = 0;
    let totalBytes = 0;

    try {
      await ensureStarted();
      // The only persisted paths are deterministic protected:// references. This insert is the
      // first export mutation and makes every subsequent filesystem kill point relaunch-visible.
      jobReferences = options.files.exportWorkspaceReferences(id);
      await database.runAsync(
        `INSERT INTO local_export_jobs
         (id, state, selection_json, portable_staging_reference, portable_archive_reference,
          created_at, updated_at, staging_started_at)
         VALUES (?, 'staging', ?, ?, ?, ?, ?, ?);`,
        id,
        canonicalJson(selection),
        jobReferences.portableStagingReference,
        jobReferences.portableArchiveReference,
        createdAt,
        createdAt,
        createdAt,
      );
      inserted = true;
      context.resolveJobCreated();

      context.workspace = await options.files.createExportWorkspace(id);
      if (
        context.workspace.portableStagingReference !== jobReferences.portableStagingReference ||
        context.workspace.portableArchiveReference !== jobReferences.portableArchiveReference
      ) {
        throw new Error('Export workspace reference changed');
      }
      publish(context, progressFor(id, 'staging'));
      ensureNotCancelled(context);

      const snapshot = await readExportSnapshot(database);
      const textOutputs = exportTextOutputs(snapshot);
      const selected = selectedMedia(snapshot, selection);
      totalEntries = textOutputs.length + selected.length + 1;
      totalBytes = textOutputs.reduce((sum, output) => sum + textByteLength(output.content), 0);

      const outputDescriptors: ExportOutputDescriptor[] = [];
      for (const output of textOutputs) {
        ensureNotCancelled(context);
        const descriptor = await writeTextOutput(options.files, context.workspace, output);
        outputDescriptors.push(descriptor);
        completedEntries += 1;
        completedBytes += descriptor.bytes;
        publish(
          context,
          progressFor(id, 'staging', completedEntries, totalEntries, completedBytes, totalBytes),
        );
      }

      const mediaFiles: ExportMediaFile[] = [];
      for (const media of selected) {
        ensureNotCancelled(context);
        const selectedFile = await selectedMediaFile(options.files, context.workspace, media);
        mediaFiles.push(selectedFile);
        completedEntries += 1;
        completedBytes += selectedFile.bytes ?? 0;
        totalBytes += selectedFile.bytes ?? 0;
        publish(
          context,
          progressFor(id, 'staging', completedEntries, totalEntries, completedBytes, totalBytes),
        );
      }

      await writeJobState(database, { id, state: 'archiving', now: now() });
      publish(
        context,
        progressFor(id, 'archiving', completedEntries, totalEntries, completedBytes, totalBytes),
      );
      ensureNotCancelled(context);

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
        archive: null,
      };
      const manifestOutput = await writeTextOutput(options.files, context.workspace, {
        path: 'manifest.json',
        content: manifestJson(manifest),
        rows: 1,
      });
      archiveEntries.push({
        path: manifestOutput.path,
        bytes: manifestOutput.bytes,
        sha256: manifestOutput.sha256,
      });
      completedEntries += 1;
      completedBytes += manifestOutput.bytes;
      totalBytes += manifestOutput.bytes;
      publish(
        context,
        progressFor(id, 'archiving', completedEntries, totalEntries, completedBytes, totalBytes),
      );
      archiveEntries.sort((left, right) => left.path.localeCompare(right.path));

      context.archiveInFlight = true;
      let zipResult;
      try {
        zipResult = await options.archive.createZip({
          operationId: id,
          stagingPath: context.workspace.stagingPath,
          partialArchivePath: context.workspace.archivePartialPath,
          entries: archiveEntries,
        });
      } finally {
        context.archiveInFlight = false;
      }
      ensureNotCancelled(context);
      if (zipResult.entryCount !== archiveEntries.length)
        throw new Error('Archive entry count mismatch');
      publish(
        context,
        progressFor(id, 'promoting', totalEntries, totalEntries, completedBytes, totalBytes),
      );
      await options.archive.promoteZip({
        operationId: id,
        partialArchivePath: context.workspace.archivePartialPath,
        archivePath: context.workspace.archivePath,
      });
      ensureNotCancelled(context);
      const archiveArtifact = await options.files.protectExportArchive(
        context.workspace.archivePath,
      );
      if (archiveArtifact.byteSize === null) throw new Error('Export archive size was unavailable');
      const readyChanges = await writeJobState(database, {
        id,
        state: 'ready',
        now: now(),
        archive: context.workspace.portableArchiveReference,
        expectedState: 'archiving',
      });
      if (readyChanges !== 1) throw new ExportCancelledError();
      publish(
        context,
        progressFor(id, 'ready', totalEntries, totalEntries, completedBytes, totalBytes),
      );
      const job = await readJob(database, id);
      if (job === null) throw new Error('Prepared export job disappeared');
      return {
        job,
        archiveReference: context.workspace.portableArchiveReference,
        archiveSha256: archiveArtifact.sourceHash,
        archiveBytes: archiveArtifact.byteSize,
        manifest,
      };
    } catch (error) {
      if (!inserted) context.rejectJobCreated(error);
      let cleanupFailed = false;
      if (inserted) {
        try {
          await cleanupReferences(
            jobReferences!.portableStagingReference,
            jobReferences!.portableArchiveReference,
          );
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed) {
          await writeJobState(database, {
            id,
            state: 'failed',
            now: now(),
            failure: 'cleanup-pending',
          });
          publish(context, progressFor(id, 'failed'));
          throw new ExportCleanupPendingError();
        }
        const cancelled =
          context.cancelRequested ||
          error instanceof ExportCancelledError ||
          failureCategory(error) === 'cancelled';
        await writeJobState(database, {
          id,
          state: cancelled ? 'cancelled' : 'failed',
          now: now(),
          failure: cancelled ? 'cancelled' : failureCategory(error),
        });
        publish(context, progressFor(id, cancelled ? 'cancelled' : 'failed'));
        if (cancelled && !(error instanceof ExportCancelledError)) throw new ExportCancelledError();
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  function start(
    input: {
      readonly jobId?: string;
      readonly selection?: ExportSelection;
      readonly locale?: string;
    } = {},
  ): LocalExportOperation {
    const operationId = input.jobId ?? makeId('export-job');
    let resolveJobCreated!: () => void;
    let rejectJobCreated!: (error: unknown) => void;
    const jobCreated = new Promise<void>((resolve, reject) => {
      resolveJobCreated = resolve;
      rejectJobCreated = reject;
    });
    const context: OperationContext = {
      operationId,
      listeners: new Set(),
      jobCreated,
      resolveJobCreated,
      rejectJobCreated,
      progress: progressFor(operationId, 'staging'),
      workspace: null,
      archiveInFlight: false,
      cancelRequested: false,
    };
    activeOperations.set(operationId, context);
    const promise = prepareOperation(context, input).finally(() => {
      activeOperations.delete(operationId);
    });
    context.promise = promise;
    return {
      operationId,
      promise,
      subscribe(listener) {
        context.listeners.add(listener);
        listener(context.progress);
        return () => context.listeners.delete(listener);
      },
      cancel: () => cancelShare(operationId),
    };
  }

  async function prepare(
    input: {
      readonly jobId?: string;
      readonly selection?: ExportSelection;
      readonly locale?: string;
    } = {},
  ): Promise<PreparedLocalExport> {
    return start(input).promise;
  }

  async function completeShare(jobId: string): Promise<LocalExportJob> {
    return transitionTerminal(jobId, 'completed');
  }

  async function cancelShare(jobId: string): Promise<LocalExportJob> {
    const active = activeOperations.get(jobId);
    if (active !== undefined) {
      active.cancelRequested = true;
      if (active.archiveInFlight && active.workspace !== null) {
        try {
          await options.archive.cancelZip({
            operationId: jobId,
            partialArchivePath: active.workspace.archivePartialPath,
          });
        } catch {
          // The operation still reaches a durable failed/cancelled state and reconciliation owns
          // any partial cleanup. Native errors never cross this boundary with paths or content.
        }
      }
      await active.jobCreated.catch(() => undefined);
      await active.promise?.catch(() => undefined);
      const finished = await getJob(jobId);
      // A cancellation arriving just after the ready CAS must still consume the ready handoff;
      // returning it here would leave a shareable archive alive after the caller cancelled.
      if (finished !== null && finished.state !== 'ready') return finished;
      if (finished?.state === 'ready') return transitionTerminal(jobId, 'cancelled');
    }
    return transitionTerminal(jobId, 'cancelled');
  }

  async function transitionTerminal(
    jobId: string,
    state: 'completed' | 'cancelled',
  ): Promise<LocalExportJob> {
    await ensureStarted();
    const session = await options.databaseFactory();
    try {
      const job = await readJob(session.database, jobId);
      if (job === null) throw new Error('Export job was not found');
      if (state === 'completed' && job.state !== 'ready') return job;
      if (state === 'cancelled' && !['ready', 'staging', 'archiving'].includes(job.state))
        return job;
      try {
        await cleanupReferences(job.portableStagingReference, job.portableArchiveReference);
      } catch {
        await writeJobState(session.database, {
          id: jobId,
          state: 'failed',
          now: now(),
          failure: 'cleanup-pending',
        });
        throw new ExportCleanupPendingError();
      }
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

  async function sharePath(jobId: string): Promise<string> {
    const job = await getJob(jobId);
    if (job === null || job.state !== 'ready' || job.portableArchiveReference === null) {
      throw new Error('The Full Export is not ready to share');
    }
    if (options.files.resolvePath === undefined) return job.portableArchiveReference;
    return options.files.resolvePath(job.portableArchiveReference);
  }

  async function reconcile(): Promise<void> {
    startupPromise = null;
    startupFailure = null;
    await startup();
  }

  return {
    start,
    prepare,
    prepareForShare: prepare,
    completeShare,
    cancelShare,
    getJob,
    sharePath,
    startup,
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
