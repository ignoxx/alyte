import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  createProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import { CURRENT_SCHEMA_VERSION, LOCAL_MIGRATIONS } from '../local-database/migrations';
import type {
  ProtectedCopy,
  ProtectedExportSource,
  ProtectedExportWorkspace,
} from '../labs/file-service';
import { createLocalExportService, type ExportDatabaseSession, type ExportFiles } from './service';
import { readExportSnapshot } from './snapshot-reader';

class NodeExportDatabase implements SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
  }

  async execAsync(source: string): Promise<void> {
    this.database.exec(source);
  }

  async runAsync(source: string, ...params: any[]) {
    const result = this.database.prepare(source).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getAllAsync<T>(source: string, ...params: any[]): Promise<readonly T[]> {
    return this.database.prepare(source).all(...params) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.database.exec('BEGIN');
    try {
      await task();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    this.database.close();
  }
}

const protection = {
  async protectDatabaseFiles(databasePath: string) {
    return { protectedPaths: [databasePath], missingSidecarPaths: [] };
  },
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-export-service-'));
  temporaryPaths.push(directory);
  return join(directory, 'alyte.sqlite');
}

async function currentDatabase(): Promise<NodeExportDatabase> {
  const database = new NodeExportDatabase(databasePath());
  const boundary = createProtectedDatabaseBoundary(database, {
    protection,
    now: () => '2026-08-25T00:00:00.000Z',
    migrations: LOCAL_MIGRATIONS,
  });
  await boundary.initialize();
  assert.equal(
    (
      await database.getAllAsync<{ version: number }>(
        'SELECT MAX(version) AS version FROM schema_migrations;',
      )
    )[0]?.version,
    CURRENT_SCHEMA_VERSION,
  );
  return database;
}

async function seedRepresentativeExportData(database: NodeExportDatabase): Promise<void> {
  await database.runAsync(
    `INSERT INTO lab_reports
      (id, source_type, original_filename, mime_type, byte_size, source_hash, original_path,
       import_state, encrypted, page_count, created_at, updated_at, imported_at)
     VALUES (?, 'pdf', ?, 'application/pdf', 128, ?, ?, 'imported', 1, 1, ?, ?, ?);`,
    'report-export-nonempty',
    'synthetic-laboratory.pdf',
    'a'.repeat(64),
    'protected://original-reports/synthetic-laboratory.pdf',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO lab_report_pages
      (id, report_id, page_index, width, height, rotation, crop, derived_path)
     VALUES (?, ?, 0, 612, 792, 0, NULL, ?);`,
    'page-export-nonempty',
    'report-export-nonempty',
    'protected://working-pages/synthetic-laboratory-page.png',
  );
  await database.runAsync(
    `INSERT INTO sanitized_report_derivatives
      (id, report_id, recipe_json, recipe_hash, artifact_path, artifact_hash, byte_size,
       verification_state, verification_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?, ?, 96, 'verified', '{}', ?, ?);`,
    'sanitized-export-nonempty',
    'report-export-nonempty',
    'b'.repeat(64),
    'protected://sanitized-reports/synthetic-laboratory.pdf',
    'c'.repeat(64),
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO lab_records
      (id, collection_date, date_state, specimen_type, laboratory_name, notes,
       created_at, updated_at, lab_report_id)
     VALUES (?, '2026-08-24', 'known', 'blood', 'Synthetic Laboratory', 'fixture', ?, ?, ?);`,
    'record-export-nonempty',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
    'report-export-nonempty',
  );
  await database.runAsync(
    `INSERT INTO measurements
      (id, lab_record_id, biomarker_id, specimen_type, original_label, original_value_string,
       original_value_json, original_unit, original_reference_interval, original_flag,
       current_label, current_value_string, current_value_json, current_unit,
       current_reference_interval, current_flag, provenance, review_state, created_at, updated_at,
       source_page_index, source_bbox_json, source_orientation, panel_label, original_state_json)
     VALUES (?, ?, 'ldl-cholesterol', 'blood', 'LDL-C', '140', '{"value":140}', 'mg/dL',
       '<100', 'H', 'LDL-C', '135', '{"value":135}', 'mg/dL', '<100', 'H', 'user-corrected',
       'confirmed', ?, ?, 0, '{"x":1}', 0, 'lipids', '{"value":140}');`,
    'measurement-export-nonempty',
    'record-export-nonempty',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO measurement_corrections
      (id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance)
     VALUES (?, ?, ?, 'fixture correction', '{"value":140}', '{"value":135}', 'extracted');`,
    'correction-export-nonempty',
    'measurement-export-nonempty',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO extraction_drafts
      (id, report_id, state, ocr_contract_version, parser_version, collection_date, date_state,
       created_at, updated_at, confirmed_at, source_artifact_kind, source_artifact_id,
       source_artifact_hash, provenance_state, pipeline_fingerprint_json, revision)
     VALUES (?, ?, 'confirmed', 'ocr-v1', 'parser-v1', '2026-08-24', 'known', ?, ?, ?,
       'original', ?, ?, 'current', '{}', 1);`,
    'draft-export-nonempty',
    'report-export-nonempty',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
    'report-export-nonempty',
    'a'.repeat(64),
  );
  await database.runAsync(
    `INSERT INTO extraction_draft_rows
      (id, draft_id, row_order, panel_label, source_text, source_label, source_value_string,
       source_unit, source_reference_interval, source_flag, source_page_index, source_bbox_json,
       source_orientation, proposed_label, proposed_value_json, proposed_unit,
       proposed_reference_interval, proposed_flag, proposed_biomarker_id, proposed_specimen_type,
       collection_date, date_state, review_reasons_json, review_state, source_value_json,
       date_context_json, decision, edit_state)
     VALUES (?, ?, 0, 'lipids', 'LDL-C 140 mg/dL', 'LDL-C', '140', 'mg/dL', '<100', 'H', 0,
       '{"x":1}', 0, 'LDL-C', '{"value":140}', 'mg/dL', '<100', 'H', 'ldl-cholesterol',
       'blood', '2026-08-24', 'known', '[]', 'ready', '{"value":140}', '{}', 'include', 'automatic');`,
    'draft-row-export-nonempty',
    'draft-export-nonempty',
  );
  await database.runAsync(
    `INSERT INTO intake_events
      (id, event_type, occurred_at, local_date, origin, provenance, review_state,
       analysis_inclusion, notes, source_media_path, source_media_hash, source_media_size,
       source_media_protection_json, created_at, updated_at)
     VALUES (?, 'food', ?, '2026-08-24', 'manual', 'user-entered', 'confirmed', 'included',
       'fixture intake', ?, ?, 64, '{}', ?, ?);`,
    'event-export-nonempty',
    '2026-08-24T12:00:00.000Z',
    'protected://intake-media/synthetic-intake.jpg',
    'd'.repeat(64),
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO intake_components
      (id, event_id, canonical_id, original_name, original_amount_json, current_name,
       current_amount_json, provenance, review_state, created_at, updated_at)
     VALUES (?, ?, 'food.synthetic', 'Synthetic food', '{"amount":1}', 'Synthetic food',
       '{"amount":1}', 'user-entered', 'confirmed', ?, ?);`,
    'component-export-nonempty',
    'event-export-nonempty',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO cloud_jobs
      (id, event_id, operation, media_path, state, consent_policy_version, created_at, updated_at)
     VALUES (?, ?, 'intake-image', ?, 'queued', 'consent-v1', ?, ?);`,
    'cloud-job-export-nonempty',
    'event-export-nonempty',
    'protected://intake-media/synthetic-intake.jpg',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO intake_capture_recovery
      (capture_id, event_id, media_path, media_hash, media_size, media_protection_json,
       event_json, cloud_mode, consent_policy_version, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 64, '{}', '{}', 'local-only', 'consent-v1', 'committed', ?, ?);`,
    'capture-export-nonempty',
    'event-export-nonempty',
    'protected://intake-media/synthetic-intake.jpg',
    'd'.repeat(64),
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO lab_combined_deletions
      (id, record_id, report_id, state, created_at, updated_at)
     VALUES (?, ?, ?, 'requested', ?, ?);`,
    'combined-export-nonempty',
    'record-export-nonempty',
    'report-export-nonempty',
    '2026-08-25T00:00:00.000Z',
    '2026-08-25T00:00:00.000Z',
  );
  await database.runAsync(
    `INSERT INTO app_preferences (key, value, updated_at) VALUES
      ('catalogue.version', 'catalogue-v1', '2026-08-25T00:00:00.000Z');`,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeFiles(options: {
  readonly missingPaths?: readonly string[];
  readonly sourceHashes?: Readonly<Record<string, string>>;
  readonly workspaceError?: Error;
}) {
  const removed: string[] = [];
  const written = new Map<string, string>();
  const missing = new Set(options.missingPaths ?? []);
  const sourceHashes = options.sourceHashes ?? {};
  const workspaceFor = (jobId: string): ProtectedExportWorkspace => ({
    stagingPath: `/protected/exports/${jobId}.partial`,
    portableStagingReference: `protected://exports/${jobId}.partial`,
    archivePartialPath: `/protected/exports/${jobId}.zip.partial`,
    archivePath: `/protected/exports/${jobId}.zip`,
    portableArchiveReference: `protected://exports/${jobId}.zip`,
  });
  const files: ExportFiles = {
    exportWorkspaceReferences(jobId) {
      return {
        portableStagingReference: `protected://exports/${jobId}.partial`,
        portableArchiveReference: `protected://exports/${jobId}.zip`,
      };
    },
    async createExportWorkspace(jobId) {
      if (options.workspaceError !== undefined) throw options.workspaceError;
      return workspaceFor(jobId);
    },
    async writeExportFile(_workspace, relativePath, contents) {
      written.set(relativePath, contents);
      return {
        path: `/protected/exports/${relativePath}`,
        relativePath,
        sourceHash: sha256(contents),
        byteSize: new TextEncoder().encode(contents).byteLength,
      };
    },
    async copyExportMedia(_workspace, source, relativePath) {
      return {
        path: `/protected/exports/${relativePath}`,
        relativePath,
        sourceHash: source.sourceHash,
        byteSize: source.byteSize,
      };
    },
    async inspectExportSource(path, _category): Promise<ProtectedExportSource | null> {
      if (missing.has(path)) return null;
      const sourceHash = sourceHashes[path] ?? sha256(path);
      return {
        path: `/protected/${path}`,
        portablePath: path,
        sourceHash,
        byteSize: 10,
      };
    },
    async protectExportArchive(path): Promise<ProtectedCopy> {
      return {
        path,
        sourceHash: sha256('synthetic-archive'),
        byteSize: 2048,
      };
    },
    async resolvePath(path) {
      return `file:///Documents/${path.replace('protected://', '')}`;
    },
    async removeExportArtifacts(workspace) {
      removed.push(workspace.portableStagingReference, workspace.portableArchiveReference);
    },
    async removeExportArtifactsByReference(staging, archive) {
      if (staging !== null) removed.push(staging);
      if (archive !== null) removed.push(archive);
    },
  };
  return { files, removed, written };
}

function fakeArchive(options: { readonly blockCreate?: boolean } = {}) {
  const created: string[][] = [];
  const cancelCalls: string[] = [];
  let signalStarted!: () => void;
  let releaseCreate!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const createReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const archive = {
    async createZip(input: { readonly entries: readonly { readonly path: string }[] }) {
      created.push(input.entries.map((entry) => entry.path));
      signalStarted();
      if (options.blockCreate === true) await createReleased;
      return {
        operationId: 'export-job-test',
        phase: 'verified' as const,
        entryCount: input.entries.length,
        bytes: 2048,
      };
    },
    async promoteZip(input: { readonly operationId: string }) {
      return {
        operationId: input.operationId,
        phase: 'promoted' as const,
        entryCount: 0,
        bytes: 2048,
      };
    },
    async cancelZip(input: { readonly operationId: string }) {
      cancelCalls.push(input.operationId);
      releaseCreate();
      return {
        operationId: input.operationId,
        phase: 'cancelled' as const,
        entryCount: 0,
        bytes: 0,
      };
    },
  };
  return { archive, created, started, cancelCalls };
}

function serviceFor(
  database: NodeExportDatabase,
  files: ExportFiles,
  archive: ReturnType<typeof fakeArchive>['archive'],
) {
  const session: ExportDatabaseSession = {
    database,
    close: async () => {},
    protect: async () => {},
  };
  return createLocalExportService({
    databaseFactory: async () => session,
    files,
    archive,
    now: () => '2026-08-25T00:00:00.000Z',
    idGenerator: () => 'export-job-test',
  });
}

describe('local export job orchestration', () => {
  test('manifest and every structured output reconcile to one non-empty export snapshot', async () => {
    const database = await currentDatabase();
    await seedRepresentativeExportData(database);
    const snapshot = await readExportSnapshot(database);
    const fileFake = fakeFiles({});
    const service = serviceFor(database, fileFake.files, fakeArchive().archive);

    const prepared = await service.prepare({ jobId: 'export-job-nonempty' });
    assert.deepEqual(
      prepared.manifest.tables,
      snapshot.tables.map((table) => ({ name: table.name, rows: table.rows.length })),
    );
    for (const table of snapshot.tables) {
      const countRows = await database.getAllAsync<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM "${table.name}";`,
      );
      const databaseCount = countRows[0]?.count;
      assert.equal(databaseCount, table.rows.length, table.name);

      const stem = table.name.replaceAll('_', '-');
      const output = prepared.manifest.outputs.find(
        (candidate) => candidate.path === `data/${stem}.json`,
      );
      assert.equal(output?.rows, databaseCount, `${table.name} manifest output`);
      const serialized = fileFake.written.get(`data/${stem}.json`);
      assert.notEqual(serialized, undefined, `${table.name} JSON output`);
      const decoded = JSON.parse(serialized ?? '{}') as { rows?: readonly unknown[] };
      assert.equal(decoded.rows?.length, databaseCount, `${table.name} JSON rows`);

      if (
        ['lab_records', 'measurements', 'intake_events', 'intake_components'].includes(table.name)
      ) {
        const csv = fileFake.written.get(`csv/${stem}.csv`);
        assert.notEqual(csv, undefined, `${table.name} CSV output`);
        assert.equal(
          csv?.trimEnd().split('\n').length,
          databaseCount + 1,
          `${table.name} CSV rows`,
        );
      }
    }
    const measurement = snapshot.tables.find((table) => table.name === 'measurements');
    assert.equal(measurement?.rows[0]?.provenance, 'user-corrected');
    const correction = snapshot.tables.find((table) => table.name === 'measurement_corrections');
    assert.equal(correction?.rows[0]?.previous_provenance, 'extracted');
    const draftRow = snapshot.tables.find((table) => table.name === 'extraction_draft_rows');
    assert.equal(draftRow?.rows[0]?.edit_state, 'automatic');
    await service.cancelShare(prepared.job.id);
    await database.closeAsync();
  });

  test('prepares a deterministic archive handoff and removes artifacts on completion', async () => {
    const database = await currentDatabase();
    const fileFake = fakeFiles({});
    const archiveFake = fakeArchive();
    const service = serviceFor(database, fileFake.files, archiveFake.archive);

    const prepared = await service.prepare({ jobId: 'export-job-test', locale: 'de-DE' });
    assert.equal(prepared.job.state, 'ready');
    assert.equal(prepared.manifest.locale, 'de-DE');
    assert.equal(prepared.manifest.media.selected, 0);
    assert.ok(prepared.manifest.outputs.every((output) => !output.path.startsWith('/')));
    assert.ok(archiveFake.created[0]?.includes('manifest.json'));
    assert.equal(
      await service.sharePath('export-job-test'),
      'file:///Documents/exports/export-job-test.zip',
    );

    const completed = await service.completeShare('export-job-test');
    assert.equal(completed.state, 'completed');
    assert.deepEqual(fileFake.removed, [
      'protected://exports/export-job-test.partial',
      'protected://exports/export-job-test.zip',
    ]);
    assert.equal(
      (
        await database.getAllAsync<{ state: string }>(
          'SELECT state FROM local_export_jobs WHERE id = ?',
          'export-job-test',
        )
      )[0]?.state,
      'completed',
    );
    await database.closeAsync();
  });

  test('honestly records missing selected media and fails stored-hash mismatches', async () => {
    const database = await currentDatabase();
    await database.runAsync(
      `INSERT INTO lab_reports
       (id, source_type, original_filename, mime_type, source_hash, original_path, import_state,
        encrypted, created_at, updated_at)
       VALUES (?, 'pdf', 'synthetic.pdf', 'application/pdf', ?, ?, 'imported', 1, ?, ?);`,
      'report-export',
      null,
      'protected://original-reports/synthetic.pdf',
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
    );
    const missingFake = fakeFiles({ missingPaths: ['protected://original-reports/synthetic.pdf'] });
    const missingArchive = fakeArchive();
    const missingService = serviceFor(database, missingFake.files, missingArchive.archive);
    const prepared = await missingService.prepare({
      jobId: 'export-job-missing',
      selection: { originalReportIds: ['report-export'] },
    });
    assert.equal(prepared.manifest.media.selected, 1);
    assert.equal(prepared.manifest.media.missing, 1);
    assert.equal(prepared.manifest.media.files[0]?.status, 'missing');
    await missingService.cancelShare('export-job-missing');

    await database.runAsync(
      'UPDATE lab_reports SET source_hash = ? WHERE id = ?;',
      '0'.repeat(64),
      'report-export',
    );
    const mismatchFake = fakeFiles({
      sourceHashes: { 'protected://original-reports/synthetic.pdf': '1'.repeat(64) },
    });
    const mismatchService = serviceFor(database, mismatchFake.files, fakeArchive().archive);
    await assert.rejects(
      mismatchService.prepare({
        jobId: 'export-job-mismatch',
        selection: { originalReportIds: ['report-export'] },
      }),
      /stored hash/i,
    );
    assert.equal(
      (
        await database.getAllAsync<{ state: string; failure_category: string }>(
          'SELECT state, failure_category FROM local_export_jobs WHERE id = ?',
          'export-job-mismatch',
        )
      )[0]?.failure_category,
      'stored-hash-mismatch',
    );
    await database.closeAsync();
  });

  test('relaunch reconciliation marks abandoned jobs failed after owned cleanup', async () => {
    const database = await currentDatabase();
    await database.runAsync(
      `INSERT INTO local_export_jobs
       (id, state, selection_json, portable_staging_reference, portable_archive_reference,
        created_at, updated_at)
       VALUES (?, 'staging', ?, ?, ?, ?, ?);`,
      'export-job-abandoned',
      '{}',
      'protected://exports/export-job-abandoned.partial',
      'protected://exports/export-job-abandoned.zip',
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
    );
    const fileFake = fakeFiles({});
    const service = serviceFor(database, fileFake.files, fakeArchive().archive);
    await service.reconcile();
    const job = await service.getJob('export-job-abandoned');
    assert.equal(job?.state, 'failed');
    assert.equal(job?.failureCategory, 'abandoned');
    assert.deepEqual(fileFake.removed, [
      'protected://exports/export-job-abandoned.partial',
      'protected://exports/export-job-abandoned.zip',
    ]);
    await database.closeAsync();
  });

  test('relaunch reconciliation cleans an abandoned ready archive', async () => {
    const database = await currentDatabase();
    await database.runAsync(
      `INSERT INTO local_export_jobs
       (id, state, selection_json, portable_staging_reference, portable_archive_reference,
        created_at, updated_at, ready_at)
       VALUES (?, 'ready', ?, ?, ?, ?, ?, ?);`,
      'export-job-ready-abandoned',
      '{}',
      'protected://exports/export-job-ready-abandoned.partial',
      'protected://exports/export-job-ready-abandoned.zip',
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
    );
    const fileFake = fakeFiles({});
    const service = serviceFor(database, fileFake.files, fakeArchive().archive);

    await service.startup();
    const job = await service.getJob('export-job-ready-abandoned');
    assert.equal(job?.state, 'failed');
    assert.equal(job?.failureCategory, 'abandoned');
    assert.deepEqual(fileFake.removed, [
      'protected://exports/export-job-ready-abandoned.partial',
      'protected://exports/export-job-ready-abandoned.zip',
    ]);
    await database.closeAsync();
  });

  test('reconciliation does not remove a ready archive after this process hands it to sharing', async () => {
    const database = await currentDatabase();
    const fileFake = fakeFiles({});
    const archiveFake = fakeArchive();
    const service = serviceFor(database, fileFake.files, archiveFake.archive);
    const prepared = await service.prepare({ jobId: 'export-job-active-share' });
    await service.sharePath(prepared.job.id);

    await service.reconcile();
    assert.deepEqual(fileFake.removed, []);
    assert.equal((await service.getJob(prepared.job.id))?.state, 'ready');

    await service.cancelShare(prepared.job.id);
    assert.deepEqual(fileFake.removed, [
      'protected://exports/export-job-active-share.partial',
      'protected://exports/export-job-active-share.zip',
    ]);
    await database.closeAsync();
  });

  test('leases a ready archive before resolving its path during concurrent reconciliation', async () => {
    const database = await currentDatabase();
    const fileFake = fakeFiles({});
    let resolveStarted!: () => void;
    const resolveBegan = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const files: ExportFiles = {
      ...fileFake.files,
      async resolvePath(path) {
        resolveStarted();
        await resolveGate;
        return `file:///Documents/${path.replace('protected://', '')}`;
      },
    };
    const service = serviceFor(database, files, fakeArchive().archive);
    const prepared = await service.prepare({ jobId: 'export-job-share-lease' });

    const sharing = service.sharePath(prepared.job.id);
    await resolveBegan;
    const reconciliation = service.reconcile();
    await reconciliation;
    assert.deepEqual(fileFake.removed, []);

    releaseResolve();
    assert.equal(await sharing, 'file:///Documents/exports/export-job-share-lease.zip');
    await service.cancelShare(prepared.job.id);
    assert.deepEqual(fileFake.removed, [
      'protected://exports/export-job-share-lease.partial',
      'protected://exports/export-job-share-lease.zip',
    ]);
    await database.closeAsync();
  });

  test('cancellation coordinates with in-flight archive work and publishes progress', async () => {
    const database = await currentDatabase();
    const fileFake = fakeFiles({});
    const archiveFake = fakeArchive({ blockCreate: true });
    const service = serviceFor(database, fileFake.files, archiveFake.archive);
    const operation = service.start({ jobId: 'export-job-cancel-race' });
    const phases: string[] = [];
    operation.subscribe((progress) => phases.push(progress.phase));
    await archiveFake.started;

    const cancelled = operation.cancel();
    await assert.rejects(operation.promise, /cancelled/i);
    const job = await cancelled;
    assert.equal(job.state, 'cancelled');
    assert.deepEqual(archiveFake.cancelCalls, ['export-job-cancel-race']);
    assert.ok(phases.includes('archiving'));
    assert.ok(phases.includes('cancelled'));
    await database.closeAsync();
  });

  test('persists deterministic cleanup references before workspace creation can fail', async () => {
    const database = await currentDatabase();
    const fileFake = fakeFiles({ workspaceError: new Error('synthetic protection failure') });
    const service = serviceFor(database, fileFake.files, fakeArchive().archive);
    await assert.rejects(
      service.prepare({ jobId: 'export-job-before-workspace' }),
      /protection failure/i,
    );
    const row = (
      await database.getAllAsync<{
        state: string;
        portable_staging_reference: string;
        portable_archive_reference: string;
      }>(
        `SELECT state, portable_staging_reference, portable_archive_reference
         FROM local_export_jobs WHERE id = ?;`,
        'export-job-before-workspace',
      )
    )[0];
    assert.equal(row?.state, 'failed');
    assert.equal(
      row?.portable_staging_reference,
      'protected://exports/export-job-before-workspace.partial',
    );
    assert.equal(
      row?.portable_archive_reference,
      'protected://exports/export-job-before-workspace.zip',
    );
    await database.closeAsync();
  });
});
