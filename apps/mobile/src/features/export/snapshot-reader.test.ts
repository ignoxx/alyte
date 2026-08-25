import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { LOCAL_MIGRATIONS } from '../local-database/migrations';
import {
  createProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import {
  readExportSnapshot,
  ExportSchemaIncompleteError,
  assertExportSchemaComplete,
} from './snapshot-reader';

class NodeSqliteDatabase implements SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
  }

  async execAsync(source: string): Promise<void> {
    this.database.exec(source);
  }
  async runAsync(source: string, ...params: readonly any[]) {
    const result = this.database.prepare(source).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }
  async getAllAsync<T>(source: string, ...params: readonly any[]): Promise<readonly T[]> {
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

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function databaseFixture(): Promise<NodeSqliteDatabase> {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-export-snapshot-'));
  paths.push(directory);
  const database = new NodeSqliteDatabase(join(directory, 'alyte.sqlite'));
  const boundary = createProtectedDatabaseBoundary(database, {
    migrations: LOCAL_MIGRATIONS,
    protection: {
      async protectDatabaseFiles(databasePath) {
        return { protectedPaths: [databasePath], missingSidecarPaths: [] };
      },
    },
    now: () => '2026-08-25T00:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-test`,
  });
  await boundary.initialize();
  return database;
}

describe('export snapshot completeness and consistency', () => {
  test('reads every v11 user table in one pinned read transaction and filters preferences', async () => {
    const database = await databaseFixture();
    await database.runAsync(
      `INSERT INTO app_preferences (key, value, updated_at) VALUES
       ('catalogue.version', '0.2.0', '2026-08-25T00:00:00.000Z'),
       ('app.onboarding-completed', 'true', '2026-08-25T00:00:00.000Z'),
       ('labs.sanitization-draft.report-1', '{"secret":"omit"}', '2026-08-25T00:00:00.000Z');`,
    );
    const snapshot = await readExportSnapshot(database);
    assert.equal(snapshot.schemaVersion, 11);
    assert.deepEqual(
      snapshot.tables.map((table) => table.name),
      [
        'lab_reports',
        'lab_report_pages',
        'sanitized_report_derivatives',
        'lab_records',
        'measurements',
        'measurement_corrections',
        'extraction_drafts',
        'extraction_draft_rows',
        'intake_events',
        'intake_components',
        'cloud_jobs',
        'intake_capture_recovery',
        'lab_combined_deletions',
        'app_preferences',
      ],
    );
    const preferences = snapshot.tables.find((table) => table.name === 'app_preferences');
    assert.deepEqual(preferences?.rows, [
      { key: 'catalogue.version', value: '0.2.0', updated_at: '2026-08-25T00:00:00.000Z' },
    ]);
    await database.closeAsync();
  });

  test('fails closed for a future table and an unlisted future column', async () => {
    const database = await databaseFixture();
    await database.execAsync('CREATE TABLE future_saved_insights (id TEXT PRIMARY KEY NOT NULL);');
    await assert.rejects(
      () => readExportSnapshot(database),
      (error: unknown) => {
        assert.ok(error instanceof ExportSchemaIncompleteError);
        assert.deepEqual(error.unexpectedTables, ['future_saved_insights']);
        return true;
      },
    );
    await database.execAsync(
      'DROP TABLE future_saved_insights; ALTER TABLE measurements ADD COLUMN future_value TEXT;',
    );
    await assert.rejects(
      () => assertExportSchemaComplete(database),
      (error: unknown) => {
        assert.ok(error instanceof ExportSchemaIncompleteError);
        assert.equal(error.columnMismatches.length, 1);
        assert.match(error.columnMismatches[0]!, /measurements/);
        return true;
      },
    );
    await database.closeAsync();
  });
});
