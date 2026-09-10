import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import {
  createProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import { LOCAL_MIGRATIONS } from '../local-database/migrations';
import { createLocalControlsService } from './service';
import {
  SHOWCASE_BOOTSTRAP_COMPLETE,
  SHOWCASE_BOOTSTRAP_PREFERENCE,
} from '../../services/showcase-seed';

class NodeDatabase implements SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.databasePath = path;
    this.database = new DatabaseSync(path);
  }

  async execAsync(source: string) {
    this.database.exec(source);
  }

  async runAsync(source: string, ...params: any[]) {
    const result = this.database.prepare(source).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getAllAsync<T>(source: string, ...params: any[]) {
    return this.database.prepare(source).all(...params) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>) {
    this.database.exec('BEGIN');
    try {
      await task();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async closeAsync() {
    this.database.close();
  }
}

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-local-controls-'));
  paths.push(directory);
  const database = new NodeDatabase(join(directory, 'alyte.sqlite'));
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
  await database.execAsync('PRAGMA foreign_keys = ON;');
  return database;
}

function filesFixture(options: { readonly failPath?: string } = {}) {
  let failPath = options.failPath;
  const removed: string[] = [];
  const owned = new Set([
    'protected://original-reports/report.pdf',
    'protected://working-pages/report-page.png',
    'protected://intake-media/event.jpg',
    'protected://intake-media/orphan-recovery.jpg',
    'protected://exports/job.zip',
    'protected://exports/orphan.zip',
  ]);
  return {
    removed,
    files: {
      async remove(path: string) {
        if (path === failPath) throw new Error('synthetic file failure');
        removed.push(path);
        owned.delete(path);
      },
      async exists(path: string) {
        return owned.has(path);
      },
      async listOwnedFiles() {
        return [...owned];
      },
      async removeOwnedFile(path: string) {
        if (path === failPath) throw new Error('synthetic file failure');
        removed.push(path);
        owned.delete(path);
      },
      setFailPath(path: string | undefined) {
        failPath = path;
      },
    },
  };
}

function assertNoSqliteStorageTokens(database: NodeDatabase, tokens: readonly string[]): void {
  for (const path of [
    database.databasePath,
    `${database.databasePath}-wal`,
    `${database.databasePath}-shm`,
  ]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const token of tokens) {
      assert.equal(bytes.includes(Buffer.from(token)), false, `${path}: ${token}`);
    }
  }
}

async function seedHealth(database: NodeDatabase) {
  await database.runAsync(
    `INSERT INTO lab_reports
       (id, source_type, original_filename, mime_type, source_hash, original_path, import_state,
        encrypted, created_at, updated_at)
     VALUES ('report-1', 'pdf', 'report.pdf', 'application/pdf', 'hash',
       'protected://original-reports/report.pdf', 'imported', 1, '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO lab_records
      (id, collection_date, date_state, specimen_type, created_at, updated_at, lab_report_id)
     VALUES ('record-1', '2026-08-25', 'known', 'blood', '2026-08-25', '2026-08-25', 'report-1');`,
  );
  await database.runAsync(
    `INSERT INTO intake_events
      (id, event_type, occurred_at, local_date, origin, provenance, review_state,
       analysis_inclusion, source_media_path, created_at, updated_at)
     VALUES ('event-1', 'food', '2026-08-25T12:00:00Z', '2026-08-25', 'manual',
       'user-entered', 'confirmed', 'included', 'protected://intake-media/event.jpg',
       '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO intake_capture_recovery
      (capture_id, event_id, media_path, event_json, cloud_mode, consent_policy_version,
       state, created_at, updated_at)
     VALUES ('capture-1', 'event-1', 'protected://intake-media/event.jpg', '{}', 'local-only',
       'v1', 'staged', '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO local_export_jobs
      (id, state, selection_json, portable_archive_reference, created_at, updated_at)
     VALUES ('job-1', 'ready', '{}', 'protected://exports/job.zip', '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO app_preferences (key, value, updated_at) VALUES
      ('app.onboarding-completed', 'true', '2026-08-25'),
      ('model.pack.state', 'ready', '2026-08-25'),
      ('${SHOWCASE_BOOTSTRAP_PREFERENCE}', '${SHOWCASE_BOOTSTRAP_COMPLETE}', '2026-08-25'),
      ('labs.sanitization-draft.report-1', '{}', '2026-08-25');`,
  );
}

function serviceFor(
  database: NodeDatabase,
  files: ReturnType<typeof filesFixture>,
  protect: (requireSidecars?: boolean) => Promise<void> = async () => {},
  resetPreservedPreferenceKeys: readonly string[] = [],
) {
  return createLocalControlsService({
    databaseFactory: async () => ({ database, close: async () => {}, protect }),
    files: files.files,
    now: () => '2026-08-25T00:00:00.000Z',
    idGenerator: (() => {
      let index = 0;
      return () => `deletion-${++index}`;
    })(),
    resetPreservedPreferenceKeys,
  });
}

test('builds a count-only snapshot, binds execution to a plan hash, and preserves control preferences', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO lab_combined_deletions
      (id, record_id, report_id, state, created_at, updated_at)
     VALUES ('combined-1', 'record-1', 'report-1', 'requested', '2026-08-25', '2026-08-25');`,
  );
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);

  const summary = await service.summary();
  assert.equal(summary.counts.reports, 1);
  assert.equal(summary.counts.records, 1);
  assert.equal(summary.counts.intakeEvents, 1);
  assert.equal(summary.counts.intakeImages, 1);
  assert.equal(
    (await database.getAllAsync<{ secure_delete: number }>('PRAGMA secure_delete;'))[0]
      ?.secure_delete,
    1,
  );
  const plan = await service.preview('all-health');
  assert.match(plan.planHash, /^plan-[0-9a-f]{16}$/);
  assert.equal(plan.willRemain.reports, 0);
  const result = await service.execute(plan);
  assert.deepEqual(result.state, 'completed');
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);
  assert.equal((await database.getAllAsync('SELECT id FROM intake_events')).length, 0);
  assert.deepEqual(
    (
      await database.getAllAsync<{ key: string; value: string }>(
        'SELECT key, value FROM app_preferences ORDER BY key',
      )
    ).map((row) => ({ key: row.key, value: row.value })),
    [
      { key: 'app.onboarding-completed', value: 'true' },
      { key: SHOWCASE_BOOTSTRAP_PREFERENCE, value: SHOWCASE_BOOTSTRAP_COMPLETE },
      { key: 'model.pack.state', value: 'ready' },
    ],
  );
  assert.equal(
    (
      await database.getAllAsync<{ state: string }>('SELECT state FROM local_deletion_operations')
    )[0]?.state,
    'completed',
  );
  assert.equal((await database.getAllAsync('SELECT id FROM local_deletion_operations')).length, 1);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_combined_deletions')).length, 0);
  assert.ok(fileFixture.removed.includes('protected://original-reports/report.pdf'));
  assert.ok(fileFixture.removed.includes('protected://intake-media/event.jpg'));
  assert.ok(fileFixture.removed.includes('protected://exports/orphan.zip'));
  assertNoSqliteStorageTokens(database, [
    'report-1',
    'record-1',
    'event-1',
    'capture-1',
    'protected://original-reports/report.pdf',
    'protected://intake-media/event.jpg',
  ]);
  await database.closeAsync();
});

test('reset-app removes local health data and settings while retaining only a redacted operation marker', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);

  const plan = await service.preview('reset-app');
  assert.equal(plan.scope, 'reset-app');
  assert.equal(plan.counts.reports, 1);
  assert.equal(plan.counts.records, 1);
  assert.equal(plan.counts.intakeEvents, 1);

  const result = await service.execute(plan);
  assert.equal(result.state, 'completed');
  for (const table of [
    'lab_reports',
    'lab_records',
    'measurements',
    'intake_events',
    'app_preferences',
  ]) {
    assert.equal((await database.getAllAsync(`SELECT * FROM ${table};`)).length, 0, table);
  }
  assert.ok(fileFixture.removed.includes('protected://original-reports/report.pdf'));
  assert.ok(fileFixture.removed.includes('protected://intake-media/event.jpg'));
  assert.ok(fileFixture.removed.includes('protected://exports/orphan.zip'));
  const markers = await database.getAllAsync<{
    scope: string;
    state: string;
    plan_hash: string;
    plan_json: string;
  }>('SELECT scope, state, plan_hash, plan_json FROM local_deletion_operations;');
  assert.deepEqual(
    markers.map((row) => ({ ...row })),
    [
      {
        scope: 'reset-app',
        state: 'completed',
        plan_hash: 'plan-redacted',
        plan_json: '{"redacted":true,"scope":"reset-app"}',
      },
    ],
  );
  await database.closeAsync();
});

test('reset-app remains retryable when an owned orphan cannot be removed after the data commit', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const fileFixture = filesFixture({ failPath: 'protected://exports/orphan.zip' });
  const service = serviceFor(database, fileFixture);

  const failed = await service.execute(await service.preview('reset-app'));
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failureCategories, ['orphan-cleanup-failed']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);
  assert.equal((await database.getAllAsync('SELECT id FROM intake_events')).length, 0);
  assert.equal(
    (
      await database.getAllAsync<{
        state: string;
        plan_json: string;
        failure_categories_json: string;
      }>(
        'SELECT state, plan_json, failure_categories_json FROM local_deletion_operations WHERE id = ?;',
        failed.operationId,
      )
    )[0]?.state,
    'completed',
  );

  fileFixture.files.setFailPath(undefined);
  const retried = await service.retry(failed.operationId);
  assert.equal(retried.state, 'completed');
  assert.deepEqual(retried.failureCategories, []);
  assert.ok(fileFixture.removed.includes('protected://exports/orphan.zip'));
  await database.closeAsync();
});

test('development reset can retain only its invisible showcase guard', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const service = serviceFor(database, filesFixture(), async () => {}, [
    SHOWCASE_BOOTSTRAP_PREFERENCE,
  ]);

  assert.equal((await service.execute(await service.preview('reset-app'))).state, 'completed');
  assert.deepEqual(
    (
      await database.getAllAsync<{ key: string; value: string }>(
        'SELECT key, value FROM app_preferences ORDER BY key;',
      )
    ).map((row) => ({ ...row })),
    [
      {
        key: SHOWCASE_BOOTSTRAP_PREFERENCE,
        value: SHOWCASE_BOOTSTRAP_COMPLETE,
      },
    ],
  );
  await database.closeAsync();
});

test('scrubs the retained all-health completion marker of health IDs and paths', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const service = serviceFor(database, filesFixture());

  const result = await service.execute(await service.preview('all-health'));
  assert.equal(result.state, 'completed');
  const row = (
    await database.getAllAsync<{ plan_json: string; plan_hash: string }>(
      'SELECT plan_json, plan_hash FROM local_deletion_operations WHERE id = ?;',
      result.operationId,
    )
  )[0];
  assert.equal(row?.plan_json, '{"redacted":true,"scope":"all-health"}');
  assert.equal(row?.plan_hash, 'plan-redacted');
  assert.equal(row?.plan_json.includes('report-1'), false);
  assert.equal(row?.plan_json.includes('protected://'), false);
  await database.closeAsync();
});

test('all-health deletion checkpoints and vacuums after its committed database delete', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const checkpoints: unknown[] = [];
  const protectionCalls: (boolean | undefined)[] = [];
  let vacuumSeen = false;
  const originalExec = database.execAsync.bind(database);
  database.execAsync = async (source: string) => {
    if (/VACUUM/iu.test(source)) vacuumSeen = true;
    await originalExec(source);
  };
  const originalGetAll = database.getAllAsync.bind(database);
  database.getAllAsync = async <T>(source: string, ...params: any[]) => {
    const result = await originalGetAll<T>(source, ...params);
    if (/PRAGMA wal_checkpoint\(TRUNCATE\)/iu.test(source)) checkpoints.push(result[0]);
    return result;
  };
  const service = serviceFor(database, filesFixture(), async (requireSidecars) => {
    protectionCalls.push(requireSidecars);
  });

  assert.equal((await service.execute(await service.preview('all-health'))).state, 'completed');
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(
    checkpoints.map((row) => (row as { busy: number }).busy),
    [0, 0],
  );
  assert.equal(vacuumSeen, true);
  assert.deepEqual(protectionCalls, [true]);
  await database.closeAsync();
});

test('report deletion includes owned combined rows and compacts the selected scope', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO extraction_drafts
      (id, report_id, state, ocr_contract_version, parser_version, date_state, created_at, updated_at)
     VALUES ('draft-report-scrub', 'report-1', 'confirmed', 'ocr-v1', 'parser-v1', 'missing',
       '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO lab_combined_deletions
      (id, record_id, report_id, state, created_at, updated_at)
     VALUES ('combined-report', 'record-1', 'report-1', 'requested', '2026-08-25', '2026-08-25');`,
  );
  const service = serviceFor(database, filesFixture());
  const plan = await service.preview('reports');

  assert.equal(plan.counts.combinedDeletions, 1);
  assert.equal(plan.willRemain.combinedDeletions, 0);
  assert.equal((await service.execute(plan)).state, 'completed');
  assert.equal((await database.getAllAsync('SELECT id FROM lab_combined_deletions')).length, 0);
  assertNoSqliteStorageTokens(database, [
    'report-1',
    'draft-report-scrub',
    'protected://original-reports/report.pdf',
  ]);
  await database.closeAsync();
});

test('reports preview counts only combined rows owned by active selected reports', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO lab_reports
       (id, source_type, original_filename, mime_type, source_hash, original_path, import_state,
        encrypted, created_at, updated_at)
     VALUES ('report-soft-deleted', 'pdf', 'old-report.pdf', 'application/pdf', NULL,
       'protected://original-reports/old-report.pdf', 'deleted', 1, '2026-08-25', '2026-08-25');`,
  );
  await database.runAsync(
    `INSERT INTO lab_combined_deletions
      (id, record_id, report_id, state, created_at, updated_at)
     VALUES
       ('combined-active-report', 'record-1', 'report-1', 'requested', '2026-08-25', '2026-08-25'),
       ('combined-soft-deleted-report', 'record-1', 'report-soft-deleted', 'requested',
        '2026-08-25', '2026-08-25');`,
  );
  const service = serviceFor(database, filesFixture());
  const plan = await service.preview('reports');

  assert.deepEqual(plan.targetIds.reportIds, ['report-1']);
  assert.equal(plan.counts.combinedDeletions, 2);
  assert.equal(plan.willRemain.combinedDeletions, 1);
  assert.equal((await service.execute(plan)).state, 'completed');
  assert.deepEqual(
    (
      await database.getAllAsync<{ id: string }>(
        'SELECT id FROM lab_combined_deletions ORDER BY id ASC;',
      )
    ).map((row) => row.id),
    ['combined-soft-deleted-report'],
  );
  assert.deepEqual(
    (await database.getAllAsync<{ id: string }>('SELECT id FROM lab_reports ORDER BY id ASC;')).map(
      (row) => row.id,
    ),
    ['report-soft-deleted'],
  );
  await database.closeAsync();
});

test('reports deletion exposes compaction failure for retry without reusing its deleted plan', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  let failCompaction = true;
  const originalExec = database.execAsync.bind(database);
  database.execAsync = async (source: string) => {
    if (failCompaction && /VACUUM/iu.test(source)) throw new Error('synthetic vacuum failure');
    await originalExec(source);
  };
  const service = serviceFor(database, filesFixture());
  const plan = await service.preview('reports');
  const failed = await service.execute(plan);

  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failureCategories, ['database-hygiene-pending']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);
  const marker = (
    await database.getAllAsync<{ state: string; plan_json: string; plan_hash: string }>(
      'SELECT state, plan_json, plan_hash FROM local_deletion_operations WHERE id = ?;',
      failed.operationId,
    )
  )[0];
  assert.equal(marker?.state, 'completed');
  assert.equal(marker?.plan_json, '{"redacted":true,"scope":"reports"}');
  assert.equal(marker?.plan_hash, 'plan-redacted');
  assert.equal(marker?.plan_json.includes('report-1'), false);

  failCompaction = false;
  const retried = await service.retry(failed.operationId);
  assert.equal(retried.state, 'completed');
  assert.deepEqual(retried.failureCategories, []);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);
  await database.closeAsync();
});

test('post-vacuum database protection failure remains a hygiene-only retry', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  let failProtection = true;
  const service = serviceFor(database, filesFixture(), async () => {
    if (failProtection) throw new Error('synthetic protection failure');
  });

  const failed = await service.execute(await service.preview('reports'));
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failureCategories, ['database-hygiene-pending']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);

  failProtection = false;
  assert.equal((await service.retry(failed.operationId)).state, 'completed');
  await database.closeAsync();
});

test('relaunch clears a committed redacted hygiene marker without replaying its original plan', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  let failCompaction = true;
  const originalExec = database.execAsync.bind(database);
  database.execAsync = async (source: string) => {
    if (failCompaction && /VACUUM/iu.test(source)) throw new Error('synthetic vacuum failure');
    await originalExec(source);
  };
  const firstService = serviceFor(database, filesFixture());
  const failed = await firstService.execute(await firstService.preview('reports'));
  assert.equal(failed.state, 'failed');

  const pending = (
    await database.getAllAsync<{
      state: string;
      plan_json: string;
      failure_categories_json: string;
    }>(
      'SELECT state, plan_json, failure_categories_json FROM local_deletion_operations WHERE id = ?;',
      failed.operationId,
    )
  )[0];
  assert.equal(pending?.state, 'completed');
  assert.equal(pending?.plan_json, '{"redacted":true,"scope":"reports"}');
  assert.deepEqual(JSON.parse(pending?.failure_categories_json ?? 'null'), [
    'database-hygiene-pending',
  ]);

  failCompaction = false;
  await serviceFor(database, filesFixture()).reconcile();
  const cleared = (
    await database.getAllAsync<{
      state: string;
      plan_json: string;
      failure_categories_json: string;
    }>(
      'SELECT state, plan_json, failure_categories_json FROM local_deletion_operations WHERE id = ?;',
      failed.operationId,
    )
  )[0];
  assert.equal(cleared?.state, 'completed');
  assert.equal(cleared?.plan_json, '{"redacted":true,"scope":"reports"}');
  assert.deepEqual(JSON.parse(cleared?.failure_categories_json ?? 'null'), []);
  await database.closeAsync();
});

test('a busy checkpoint is a pending hygiene failure and later retry clears it', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const originalGetAll = database.getAllAsync.bind(database);
  let checkpointCalls = 0;
  database.getAllAsync = async <T>(source: string, ...params: any[]) => {
    if (/PRAGMA wal_checkpoint\(TRUNCATE\)/iu.test(source)) {
      checkpointCalls += 1;
      if (checkpointCalls === 1) return [{ busy: 1 }] as T[];
    }
    return originalGetAll<T>(source, ...params);
  };
  const service = serviceFor(database, filesFixture());
  const failed = await service.execute(await service.preview('all-health'));

  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failureCategories, ['database-hygiene-pending']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 0);
  const retried = await service.retry(failed.operationId);
  assert.equal(retried.state, 'completed');
  assert.deepEqual(retried.failureCategories, []);
  assert.equal(checkpointCalls, 3);
  await database.closeAsync();
});

test('rejects a stale preview without deleting newly added records', async () => {
  const database = await databaseFixture();
  const service = serviceFor(database, filesFixture());
  const plan = await service.preview('records');
  await database.runAsync(
    `INSERT INTO lab_records (id, date_state, specimen_type, created_at, updated_at)
     VALUES ('record-new', 'missing', 'unknown', '2026-08-25', '2026-08-25');`,
  );
  const result = await service.execute(plan);
  assert.deepEqual(result.failureCategories, ['stale-preview']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_records')).length, 1);
  await database.closeAsync();
});

test('retains a retryable failed operation when a protected file cannot be removed', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const fileFixture = filesFixture({ failPath: 'protected://original-reports/report.pdf' });
  const service = serviceFor(database, fileFixture);
  const plan = await service.preview('reports');
  const failed = await service.execute(plan);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failureCategories, ['file-failed']);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_reports')).length, 1);
  await database.closeAsync();
});

test('retry resumes the durable failed operation identity and completes after the file recovers', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const fileFixture = filesFixture({ failPath: 'protected://original-reports/report.pdf' });
  const service = serviceFor(database, fileFixture);
  const failed = await service.execute(await service.preview('reports'));
  assert.equal(failed.state, 'failed');
  fileFixture.files.setFailPath(undefined);
  const retried = await service.retry(failed.operationId);
  assert.equal(retried.state, 'completed');
  assert.equal(retried.operationId, failed.operationId);
  assert.equal((await database.getAllAsync('SELECT id FROM local_deletion_operations')).length, 1);
  await database.closeAsync();
});

test('startup reconciliation removes owned orphans while preserving referenced files', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);
  await service.reconcile();
  assert.ok(fileFixture.removed.includes('protected://exports/orphan.zip'));
  assert.equal(fileFixture.removed.includes('protected://original-reports/report.pdf'), false);
  await database.closeAsync();
});

test('reference-counts shared media and removes report working pages', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO lab_report_pages
      (id, report_id, page_index, derived_path)
     VALUES ('page-1', 'report-1', 0, 'protected://working-pages/report-page.png');`,
  );
  // A cloud job may still need the same bytes while the report row is being deleted. The file
  // must survive until the last referencing family is removed.
  await database.runAsync(
    `INSERT INTO cloud_jobs
      (id, event_id, operation, media_path, state, consent_policy_version, created_at, updated_at)
     VALUES ('cloud-1', 'event-1', 'intake-image', 'protected://original-reports/report.pdf',
       'queued', 'v1', '2026-08-25', '2026-08-25');`,
  );
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);
  const result = await service.execute(await service.preview('reports'));

  assert.equal(result.state, 'completed');
  assert.equal(fileFixture.removed.includes('protected://original-reports/report.pdf'), false);
  assert.equal(fileFixture.removed.includes('protected://working-pages/report-page.png'), true);
  assert.equal((await database.getAllAsync('SELECT id FROM lab_report_pages')).length, 0);
  assert.equal((await database.getAllAsync('SELECT id FROM cloud_jobs')).length, 1);
  await database.closeAsync();
});

test('media deletion removes bytes and jobs while retaining structured report/event rows', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO lab_report_pages (id, report_id, page_index, derived_path)
     VALUES ('page-media', 'report-1', 0, 'protected://working-pages/report-page.png');`,
  );
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);
  const plan = await service.preview('media');

  assert.equal(plan.willRemain.reports, 1);
  assert.equal(plan.willRemain.intakeEvents, 1);
  assert.equal(plan.willRemain.cloudJobs, 0);
  assert.equal(plan.willRemain.captureRecoveries, 0);
  assert.equal((await service.execute(plan)).state, 'completed');
  const report = (
    await database.getAllAsync<{ original_path: string | null; import_state: string }>(
      'SELECT original_path, import_state FROM lab_reports WHERE id = ?;',
      'report-1',
    )
  )[0];
  const event = (
    await database.getAllAsync<{ source_media_path: string | null }>(
      'SELECT source_media_path FROM intake_events WHERE id = ?;',
      'event-1',
    )
  )[0];
  assert.equal(report?.original_path, null);
  assert.equal(report?.import_state, 'imported');
  assert.equal(
    (
      await database.getAllAsync<{ derived_path: string | null }>(
        'SELECT derived_path FROM lab_report_pages WHERE id = ?;',
        'page-media',
      )
    )[0]?.derived_path,
    null,
  );
  assert.equal(event?.source_media_path, null);
  assert.equal((await database.getAllAsync('SELECT id FROM cloud_jobs')).length, 0);
  assert.equal(
    (await database.getAllAsync('SELECT capture_id FROM intake_capture_recovery')).length,
    0,
  );
  await database.closeAsync();
});

test('events deletion cleans a capture recovery that crashed before event commit', async () => {
  const database = await databaseFixture();
  await seedHealth(database);
  await database.runAsync(
    `INSERT INTO intake_capture_recovery
      (capture_id, event_id, media_path, event_json, cloud_mode, consent_policy_version,
       state, created_at, updated_at)
     VALUES ('capture-orphan', NULL, 'protected://intake-media/orphan-recovery.jpg', '{}',
       'local-only', 'v1', 'capturing', '2026-08-25', '2026-08-25');`,
  );
  const fileFixture = filesFixture();
  const service = serviceFor(database, fileFixture);
  assert.equal((await service.execute(await service.preview('events'))).state, 'completed');
  assert.equal(fileFixture.removed.includes('protected://intake-media/orphan-recovery.jpg'), true);
  assert.equal(
    (await database.getAllAsync('SELECT capture_id FROM intake_capture_recovery')).length,
    0,
  );
  await database.closeAsync();
});
