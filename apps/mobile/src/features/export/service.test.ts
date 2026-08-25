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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fakeFiles(options: {
  readonly missingPaths?: readonly string[];
  readonly sourceHashes?: Readonly<Record<string, string>>;
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
    async createExportWorkspace(jobId) {
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

function fakeArchive() {
  const created: string[][] = [];
  const archive = {
    async createZip(input: { readonly entries: readonly { readonly path: string }[] }) {
      created.push(input.entries.map((entry) => entry.path));
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
      return {
        operationId: input.operationId,
        phase: 'cancelled' as const,
        entryCount: 0,
        bytes: 0,
      };
    },
  };
  return { archive, created };
}

function serviceFor(
  database: NodeExportDatabase,
  files: ExportFiles,
  archive: ReturnType<typeof fakeArchive>['archive'],
) {
  const session: ExportDatabaseSession = { database, close: async () => {} };
  return createLocalExportService({
    databaseFactory: async () => session,
    files,
    archive,
    now: () => '2026-08-25T00:00:00.000Z',
    idGenerator: () => 'export-job-test',
  });
}

describe('local export job orchestration', () => {
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
});
