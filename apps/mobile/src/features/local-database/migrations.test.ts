import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createIntakeRepository } from '../intake/persistence';
import { createLabRepository } from '../labs/persistence';
import type { DatabaseProtection, ProtectionOptions } from './protection';
import { createProtectedDatabaseBoundary, type SqliteDatabase } from './persistence';
import { CURRENT_SCHEMA_VERSION, LOCAL_MIGRATIONS } from './migrations';

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

const protection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath, options: ProtectionOptions = {}) {
    return {
      protectedPaths:
        options.requireSidecars === true
          ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
          : [databasePath],
      missingSidecarPaths:
        options.requireSidecars === true ? [] : [`${databasePath}-wal`, `${databasePath}-shm`],
    };
  },
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-migrations-'));
  temporaryPaths.push(directory);
  return join(directory, 'alyte.sqlite');
}

function createBoundary(database: SqliteDatabase, migrations = LOCAL_MIGRATIONS) {
  return createProtectedDatabaseBoundary(database, {
    protection,
    now: () => '2026-08-22T10:00:00.000Z',
    migrations,
  });
}

/** The schema emitted by the released v5 before ticket #11's amended v5 was published. */
const OLD_V5_FIXTURE_SQL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);

  CREATE TABLE lab_records (
    id TEXT PRIMARY KEY NOT NULL,
    collection_date TEXT,
    date_state TEXT NOT NULL CHECK (date_state IN ('known', 'missing')),
    specimen_type TEXT NOT NULL,
    laboratory_name TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lab_report_id TEXT REFERENCES lab_reports(id) ON DELETE SET NULL
  );
  CREATE TABLE measurements (
    id TEXT PRIMARY KEY NOT NULL,
    lab_record_id TEXT NOT NULL REFERENCES lab_records(id) ON DELETE CASCADE,
    biomarker_id TEXT,
    specimen_type TEXT NOT NULL,
    original_label TEXT NOT NULL,
    original_value_string TEXT NOT NULL,
    original_value_json TEXT NOT NULL,
    original_unit TEXT,
    original_reference_interval TEXT,
    original_flag TEXT,
    current_label TEXT NOT NULL,
    current_value_string TEXT NOT NULL,
    current_value_json TEXT NOT NULL,
    current_unit TEXT,
    current_reference_interval TEXT,
    current_flag TEXT,
    provenance TEXT NOT NULL CHECK (provenance IN ('user-entered', 'extracted', 'user-corrected')),
    review_state TEXT NOT NULL CHECK (review_state IN ('confirmed', 'needs-review')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE measurement_corrections (
    id TEXT PRIMARY KEY NOT NULL,
    measurement_id TEXT NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
    corrected_at TEXT NOT NULL,
    reason TEXT,
    previous_json TEXT NOT NULL,
    next_json TEXT NOT NULL,
    previous_provenance TEXT NOT NULL CHECK (previous_provenance IN ('user-entered', 'extracted', 'user-corrected'))
  );
  CREATE TABLE lab_reports (
    id TEXT PRIMARY KEY NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'image')),
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER,
    source_hash TEXT,
    original_path TEXT,
    import_state TEXT NOT NULL CHECK (import_state IN ('importing', 'imported', 'interrupted', 'failed', 'deleted')),
    failure_reason TEXT,
    encrypted INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
    page_count INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    imported_at TEXT,
    deletion_state TEXT NOT NULL DEFAULT 'none' CHECK (deletion_state IN ('none', 'requested', 'failed', 'complete')),
    deletion_requested_at TEXT,
    deletion_error TEXT
  );
  CREATE TABLE lab_report_pages (
    id TEXT PRIMARY KEY NOT NULL,
    report_id TEXT NOT NULL REFERENCES lab_reports(id) ON DELETE CASCADE,
    page_index INTEGER NOT NULL,
    width REAL,
    height REAL,
    rotation REAL NOT NULL DEFAULT 0,
    crop TEXT,
    derived_path TEXT,
    UNIQUE(report_id, page_index)
  );
  CREATE TABLE sanitized_report_derivatives (
    id TEXT PRIMARY KEY NOT NULL,
    report_id TEXT NOT NULL REFERENCES lab_reports(id) ON DELETE CASCADE,
    recipe_json TEXT NOT NULL,
    recipe_hash TEXT NOT NULL,
    artifact_path TEXT,
    artifact_hash TEXT,
    byte_size INTEGER,
    verification_state TEXT NOT NULL CHECK (verification_state IN ('pending', 'verified', 'failed', 'deleted')),
    verification_json TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE(report_id)
  );
  CREATE TABLE intake_events (
    id TEXT PRIMARY KEY NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('food', 'drink', 'supplement', 'medication', 'other')),
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'snap', 'cloud-recognized')),
    provenance TEXT NOT NULL CHECK (provenance IN ('user-entered', 'extracted', 'estimated', 'user-corrected')),
    review_state TEXT NOT NULL CHECK (review_state IN ('confirmed', 'needs-review')),
    analysis_inclusion TEXT NOT NULL CHECK (analysis_inclusion IN ('included', 'excluded')),
    notes TEXT,
    source_media_path TEXT,
    copied_from_event_id TEXT REFERENCES intake_events(id) ON DELETE SET NULL,
    log_again_undoable INTEGER NOT NULL DEFAULT 0 CHECK (log_again_undoable IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE intake_components (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL REFERENCES intake_events(id) ON DELETE CASCADE,
    canonical_id TEXT,
    original_name TEXT NOT NULL,
    original_amount_json TEXT NOT NULL,
    current_name TEXT NOT NULL,
    current_amount_json TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('user-entered', 'extracted', 'estimated', 'user-corrected')),
    review_state TEXT NOT NULL CHECK (review_state IN ('confirmed', 'needs-review')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE cloud_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL REFERENCES intake_events(id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('intake-image')),
    media_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'uploading', 'submitted', 'processing', 'ready', 'applied', 'failed', 'expired', 'cancelled')),
    consent_policy_version TEXT NOT NULL,
    failure_category TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    submitted_at TEXT,
    cancelled_at TEXT,
    UNIQUE(event_id, operation)
  );
  CREATE TABLE app_preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  INSERT INTO lab_reports (
    id, source_type, original_filename, mime_type, byte_size, source_hash, original_path,
    import_state, encrypted, page_count, created_at, updated_at, imported_at
  ) VALUES (
    'report-old-v5', 'pdf', 'synthetic.pdf', 'application/pdf', 128, 'hash-report',
    'protected://reports/synthetic.pdf', 'imported', 1, 1,
    '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z'
  );
  INSERT INTO lab_records (
    id, collection_date, date_state, specimen_type, laboratory_name, notes,
    created_at, updated_at, lab_report_id
  ) VALUES (
    'record-old-v5', '2026-08-20', 'known', 'blood', 'Synthetic Lab', 'preserve me',
    '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z', 'report-old-v5'
  );
  INSERT INTO measurements (
    id, lab_record_id, biomarker_id, specimen_type, original_label, original_value_string,
    original_value_json, original_unit, current_label, current_value_string, current_value_json,
    current_unit, provenance, review_state, created_at, updated_at
  ) VALUES (
    'measurement-old-v5', 'record-old-v5', 'biomarker.ldl_c', 'blood', 'LDL-C', '3.2',
    '{"label":"LDL-C","value":{"kind":"numeric","value":3.2},"valueString":"3.2","unit":"mmol/L","referenceInterval":null,"flag":null}',
    'mmol/L', 'LDL-C', '3.2',
    '{"label":"LDL-C","value":{"kind":"numeric","value":3.2},"valueString":"3.2","unit":"mmol/L","referenceInterval":null,"flag":null}',
    'mmol/L', 'user-entered', 'confirmed',
    '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z'
  );
  INSERT INTO intake_events (
    id, event_type, occurred_at, local_date, origin, provenance, review_state,
    analysis_inclusion, notes, source_media_path, created_at, updated_at
  ) VALUES (
    'event-old-v5', 'food', '2026-08-22T08:00:00.000Z', '2026-08-22', 'manual',
    'user-entered', 'confirmed', 'included', 'preserve event', 'protected://intake/old.jpg',
    '2026-08-22T08:00:00.000Z', '2026-08-22T08:00:00.000Z'
  );
  INSERT INTO intake_components (
    id, event_id, original_name, original_amount_json, current_name, current_amount_json,
    provenance, review_state, created_at, updated_at
  ) VALUES (
    'component-old-v5', 'event-old-v5', 'Breakfast',
    '{"name":"Breakfast","amount":{"kind":"unknown","reason":"not-provided"},"canonicalId":null}',
    'Breakfast',
    '{"name":"Breakfast","amount":{"kind":"unknown","reason":"not-provided"},"canonicalId":null}',
    'user-entered', 'confirmed', '2026-08-22T08:00:00.000Z', '2026-08-22T08:00:00.000Z'
  );
  INSERT INTO cloud_jobs (
    id, event_id, operation, media_path, state, consent_policy_version, created_at, updated_at
  ) VALUES (
    'job-old-v5', 'event-old-v5', 'intake-image', 'protected://intake/old.jpg', 'queued',
    '2026-08-01', '2026-08-22T08:00:00.000Z', '2026-08-22T08:00:00.000Z'
  );
  INSERT INTO app_preferences (key, value, updated_at)
  VALUES ('cloud_mode', 'local-only', '2026-08-22T08:00:00.000Z');
  INSERT INTO schema_migrations (version, applied_at)
  VALUES
    (1, '2026-08-22T00:00:00.000Z'),
    (2, '2026-08-22T00:00:00.000Z'),
    (3, '2026-08-22T00:00:00.000Z'),
    (4, '2026-08-22T00:00:00.000Z'),
    (5, '2026-08-22T00:00:00.000Z');
`;

async function createReleasedV4Fixture(database: SqliteDatabase): Promise<void> {
  // The released v4 and old v5 share the same lab/intake base. Remove the v5 additions so this
  // fixture retains the exact pre-v5 shape while keeping representative v4 rows populated.
  await database.execAsync(OLD_V5_FIXTURE_SQL);
  await database.execAsync(`
    DROP TABLE app_preferences;
    DROP TABLE cloud_jobs;
    DELETE FROM schema_migrations WHERE version = 5;
  `);
}

const FROZEN_V1_LABS_SQL = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
  CREATE TABLE lab_records (
    id TEXT PRIMARY KEY NOT NULL, collection_date TEXT,
    date_state TEXT NOT NULL CHECK (date_state IN ('known', 'missing')),
    specimen_type TEXT NOT NULL, laboratory_name TEXT, notes TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE measurements (
    id TEXT PRIMARY KEY NOT NULL,
    lab_record_id TEXT NOT NULL REFERENCES lab_records(id) ON DELETE CASCADE,
    biomarker_id TEXT, specimen_type TEXT NOT NULL,
    original_label TEXT NOT NULL, original_value_string TEXT NOT NULL,
    original_value_json TEXT NOT NULL, original_unit TEXT,
    original_reference_interval TEXT, original_flag TEXT,
    current_label TEXT NOT NULL, current_value_string TEXT NOT NULL,
    current_value_json TEXT NOT NULL, current_unit TEXT,
    current_reference_interval TEXT, current_flag TEXT,
    provenance TEXT NOT NULL CHECK (provenance IN ('user-entered', 'extracted', 'user-corrected')),
    review_state TEXT NOT NULL CHECK (review_state IN ('confirmed', 'needs-review')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE measurement_corrections (
    id TEXT PRIMARY KEY NOT NULL,
    measurement_id TEXT NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
    corrected_at TEXT NOT NULL, reason TEXT, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
    previous_provenance TEXT NOT NULL CHECK (previous_provenance IN ('user-entered', 'extracted', 'user-corrected'))
  );
  CREATE INDEX measurements_lab_record_id_idx ON measurements(lab_record_id);
  CREATE INDEX measurement_corrections_measurement_id_idx ON measurement_corrections(measurement_id);
  INSERT INTO lab_records VALUES ('record-frozen', '2026-08-20', 'known', 'blood', 'Synthetic Lab', NULL, '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
  INSERT INTO measurements VALUES (
    'measurement-frozen', 'record-frozen', 'biomarker.ldl_c', 'blood', 'LDL-C', '3.2',
    '{"label":"LDL-C","value":{"kind":"numeric","value":3.2},"valueString":"3.2","unit":"mmol/L","referenceInterval":"<3.0","flag":"H"}',
    'mmol/L', '<3.0', 'H', 'LDL-C', '3.4',
    '{"label":"LDL-C","value":{"kind":"numeric","value":3.4},"valueString":"3.4","unit":"mmol/L","referenceInterval":"<3.0","flag":"H"}',
    'mmol/L', '<3.0', 'H', 'user-corrected', 'confirmed', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
  );
  INSERT INTO measurement_corrections VALUES (
    'correction-frozen', 'measurement-frozen', '2026-08-21T00:00:00.000Z', 'Synthetic correction',
    '{"biomarkerId":"biomarker.ldl_c","specimenType":"blood","snapshot":{"label":"LDL-C","value":{"kind":"numeric","value":3.2},"valueString":"3.2","unit":"mmol/L","referenceInterval":"<3.0","flag":"H"},"reviewState":"confirmed","provenance":"user-entered","source":null}',
    '{"biomarkerId":"biomarker.ldl_c","specimenType":"blood","snapshot":{"label":"LDL-C","value":{"kind":"numeric","value":3.4},"valueString":"3.4","unit":"mmol/L","referenceInterval":"<3.0","flag":"H"},"reviewState":"confirmed","provenance":"user-corrected","source":null}',
    'user-entered'
  );
  INSERT INTO schema_migrations VALUES (1, '2026-08-20T00:00:00.000Z');
`;

async function createFrozenLabsFixture(database: SqliteDatabase, version: number): Promise<void> {
  if (version >= 4) {
    await database.execAsync(OLD_V5_FIXTURE_SQL);
    if (version === 4) {
      await database.execAsync(
        'DROP TABLE app_preferences; DROP TABLE cloud_jobs; DELETE FROM schema_migrations WHERE version = 5;',
      );
    }
  } else {
    await database.execAsync(FROZEN_V1_LABS_SQL);
    if (version >= 2) {
      await database.execAsync(`
        CREATE TABLE lab_reports (
          id TEXT PRIMARY KEY NOT NULL, source_type TEXT NOT NULL, original_filename TEXT NOT NULL,
          mime_type TEXT NOT NULL, byte_size INTEGER, source_hash TEXT, original_path TEXT,
          import_state TEXT NOT NULL, failure_reason TEXT, encrypted INTEGER NOT NULL,
          page_count INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, imported_at TEXT
        );
        CREATE TABLE lab_report_pages (
          id TEXT PRIMARY KEY NOT NULL, report_id TEXT NOT NULL REFERENCES lab_reports(id) ON DELETE CASCADE,
          page_index INTEGER NOT NULL, width REAL, height REAL, rotation REAL NOT NULL DEFAULT 0,
          crop TEXT, derived_path TEXT, UNIQUE(report_id, page_index)
        );
        ALTER TABLE lab_records ADD COLUMN lab_report_id TEXT REFERENCES lab_reports(id) ON DELETE SET NULL;
        INSERT INTO lab_reports VALUES ('report-frozen', 'pdf', 'synthetic.pdf', 'application/pdf', 128, 'hash-frozen', 'protected://original-reports/synthetic.pdf', 'imported', NULL, 0, 1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
        UPDATE lab_records SET lab_report_id = 'report-frozen' WHERE id = 'record-frozen';
        INSERT INTO schema_migrations VALUES (2, '2026-08-20T00:00:00.000Z');
      `);
    }
    if (version >= 3) {
      await database.execAsync(`
        ALTER TABLE lab_reports ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'none';
        ALTER TABLE lab_reports ADD COLUMN deletion_requested_at TEXT;
        ALTER TABLE lab_reports ADD COLUMN deletion_error TEXT;
        INSERT INTO schema_migrations VALUES (3, '2026-08-20T00:00:00.000Z');
      `);
    }
  }
  if (version >= 6) {
    await database.execAsync(`
      CREATE TABLE intake_capture_recovery (
        capture_id TEXT PRIMARY KEY NOT NULL, event_id TEXT, media_path TEXT NOT NULL,
        media_hash TEXT, media_size INTEGER, media_protection_json TEXT, event_json TEXT NOT NULL,
        cloud_mode TEXT NOT NULL, consent_policy_version TEXT NOT NULL, state TEXT NOT NULL,
        failure_category TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      ALTER TABLE intake_events ADD COLUMN source_media_hash TEXT;
      ALTER TABLE intake_events ADD COLUMN source_media_size INTEGER;
      ALTER TABLE intake_events ADD COLUMN source_media_protection_json TEXT;
      INSERT INTO schema_migrations VALUES (6, '2026-08-20T00:00:00.000Z');
    `);
  }
  if (version >= 7) {
    await database.execAsync(`
      CREATE TABLE extraction_drafts (
        id TEXT PRIMARY KEY NOT NULL, report_id TEXT NOT NULL REFERENCES lab_reports(id) ON DELETE CASCADE,
        state TEXT NOT NULL, ocr_contract_version TEXT NOT NULL, parser_version TEXT NOT NULL,
        collection_date TEXT, date_state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        confirmed_at TEXT, UNIQUE(report_id)
      );
      CREATE TABLE extraction_draft_rows (
        id TEXT PRIMARY KEY NOT NULL, draft_id TEXT NOT NULL REFERENCES extraction_drafts(id) ON DELETE CASCADE,
        row_order INTEGER NOT NULL, panel_label TEXT, source_text TEXT NOT NULL, source_label TEXT NOT NULL,
        source_value_string TEXT NOT NULL, source_unit TEXT, source_reference_interval TEXT, source_flag TEXT,
        source_page_index INTEGER NOT NULL, source_bbox_json TEXT NOT NULL, source_orientation INTEGER NOT NULL,
        proposed_label TEXT NOT NULL, proposed_value_json TEXT NOT NULL, proposed_unit TEXT,
        proposed_reference_interval TEXT, proposed_flag TEXT, proposed_biomarker_id TEXT,
        proposed_specimen_type TEXT NOT NULL, collection_date TEXT, date_state TEXT NOT NULL,
        review_reasons_json TEXT NOT NULL, review_state TEXT NOT NULL,
        UNIQUE(draft_id, row_order)
      );
      ALTER TABLE measurements ADD COLUMN source_page_index INTEGER;
      ALTER TABLE measurements ADD COLUMN source_bbox_json TEXT;
      ALTER TABLE measurements ADD COLUMN source_orientation INTEGER;
      UPDATE measurements SET source_page_index = 0,
        source_bbox_json = '{"x":0.1,"y":0.2,"width":0.3,"height":0.04,"observationIds":["frozen-source"],"observations":[],"semantic":null}',
        source_orientation = 0 WHERE id = 'measurement-old-v5';
      INSERT INTO schema_migrations VALUES (7, '2026-08-20T00:00:00.000Z');
    `);
  }
  if (version >= 8) {
    await database.execAsync(`
      ALTER TABLE extraction_draft_rows ADD COLUMN source_value_json TEXT;
      ALTER TABLE extraction_draft_rows ADD COLUMN date_context_json TEXT;
      ALTER TABLE extraction_draft_rows ADD COLUMN decision TEXT NOT NULL DEFAULT 'unresolved';
      INSERT INTO schema_migrations VALUES (8, '2026-08-20T00:00:00.000Z');
    `);
  }
}

describe('local schema forward migrations', () => {
  test('direct v11 to v12 invalidates legacy Sanitized drafts without reinterpreting them as Original', async () => {
    const database = new NodeSqliteDatabase(temporaryDatabase());
    await createFrozenLabsFixture(database, 8);
    const v11 = createBoundary(
      database,
      LOCAL_MIGRATIONS.filter((migration) => migration.version <= 11),
    );
    await v11.initialize();
    await database.runAsync(
      `INSERT INTO extraction_drafts
         (id, report_id, state, ocr_contract_version, parser_version, collection_date, date_state,
          created_at, updated_at, confirmed_at)
       VALUES ('legacy-draft', 'report-old-v5', 'draft', 'alyte.vision-ocr.v1', 'alyte.extraction.v1',
         NULL, 'missing', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z', NULL);`,
    );
    await database.runAsync(
      `INSERT INTO extraction_draft_rows
         (id, draft_id, row_order, panel_label, source_text, source_label, source_value_string,
          source_value_json, source_unit, source_reference_interval, source_flag, source_page_index,
          source_bbox_json, source_orientation, proposed_label, proposed_value_json, proposed_unit,
          proposed_reference_interval, proposed_flag, proposed_biomarker_id, proposed_specimen_type,
          collection_date, date_state, date_context_json, review_reasons_json, review_state, decision)
       VALUES ('legacy-row', 'legacy-draft', 0, NULL, 'LDL-C 3.2 mmol/L', 'LDL-C', '3.2',
         '{"kind":"numeric","value":3.2}', 'mmol/L', NULL, NULL, 0,
         '{"x":0.1,"y":0.2,"width":0.5,"height":0.04,"artifact":null}', 0, 'LDL-C',
         '{"kind":"numeric","value":3.2}', 'mmol/L', NULL, NULL, 'biomarker.ldl_c', 'blood',
         NULL, 'missing', NULL, '[]', 'ready', 'unresolved');`,
    );

    await createBoundary(database).initialize();
    const draftRow = await database.getAllAsync<{
      state: string;
      provenance_state: string;
      failure_reason: string;
    }>(
      'SELECT state, provenance_state, failure_reason FROM extraction_drafts WHERE id = ?;',
      'legacy-draft',
    );
    assert.deepEqual(
      { ...draftRow[0] },
      {
        state: 'failed',
        provenance_state: 'legacy-sanitized',
        failure_reason: 'legacy-sanitized-provenance',
      },
    );
    const operation = await database.getAllAsync<{
      state: string;
      error: string;
    }>('SELECT state, error FROM extraction_operations WHERE report_id = ?;', 'report-old-v5');
    assert.deepEqual(
      { ...operation[0] },
      {
        state: 'interrupted',
        error: 'legacy-sanitized-provenance',
      },
    );
    const rows = await database.getAllAsync<{ id: string }>(
      'SELECT id FROM extraction_draft_rows WHERE draft_id = ?;',
      'legacy-draft',
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ['legacy-row'],
    );
    await database.closeAsync();
  });

  for (let releasedVersion = 1; releasedVersion <= 8; releasedVersion += 1) {
    test(`upgrades released v${releasedVersion} to v11`, async () => {
      const database = new NodeSqliteDatabase(temporaryDatabase());
      await createFrozenLabsFixture(database, releasedVersion);
      await createBoundary(database).initialize();
      const version = await database.getAllAsync<{ version: number }>(
        'SELECT MAX(version) AS version FROM schema_migrations;',
      );
      assert.equal(version[0]?.version, CURRENT_SCHEMA_VERSION);
      const columns = await database.getAllAsync<{ name: string }>(
        'PRAGMA table_info(measurements);',
      );
      assert.ok(columns.some((column) => column.name === 'panel_label'));
      assert.ok(columns.some((column) => column.name === 'original_state_json'));
      const repository = createLabRepository(database, { protection });
      const record = await repository.getRecord(
        releasedVersion >= 4 ? 'record-old-v5' : 'record-frozen',
      );
      assert.notEqual(record, null);
      assert.equal(record?.measurements[0]?.panelLabel, null);
      assert.equal(record?.measurements[0]?.originalState.snapshot.valueString, '3.2');
      assert.equal(record?.measurements[0]?.corrections.length, releasedVersion >= 4 ? 0 : 1);
      if (releasedVersion >= 7) assert.equal(record?.measurements[0]?.source?.boundingBox.x, 0.1);
      assert.equal(
        (
          await database.getAllAsync(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lab_combined_deletions';",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await database.getAllAsync(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_export_jobs';",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await database.getAllAsync(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_deletion_operations';",
          )
        ).length,
        1,
      );
      await database.closeAsync();
    });
  }

  test('upgrades the released v9 schema to v11 without changing user records', async () => {
    const database = new NodeSqliteDatabase(temporaryDatabase());
    await createFrozenLabsFixture(database, 8);
    await createBoundary(database, LOCAL_MIGRATIONS.slice(0, 9)).initialize();

    const releasedVersion = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(releasedVersion[0]?.version, 9);
    assert.equal(
      (
        await database.getAllAsync(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_export_jobs';",
        )
      ).length,
      0,
    );

    await createBoundary(database).initialize();
    const currentVersion = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(currentVersion[0]?.version, CURRENT_SCHEMA_VERSION);
    assert.equal(
      (
        await database.getAllAsync(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_export_jobs';",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await database.getAllAsync(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_deletion_operations';",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await database.getAllAsync<{ id: string }>(
          'SELECT id FROM lab_records WHERE id = ?',
          'record-old-v5',
        )
      )[0]?.id,
      'record-old-v5',
    );
    await database.closeAsync();
  });

  test('upgrades the released v10 export schema to v11 with a durable deletion table', async () => {
    const database = new NodeSqliteDatabase(temporaryDatabase());
    await createFrozenLabsFixture(database, 8);
    await createBoundary(database, LOCAL_MIGRATIONS.slice(0, 10)).initialize();
    const releasedVersion = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(releasedVersion[0]?.version, 10);
    await createBoundary(database).initialize();
    const currentVersion = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(currentVersion[0]?.version, CURRENT_SCHEMA_VERSION);
    const columns = await database.getAllAsync<{ name: string }>(
      'PRAGMA table_info(local_deletion_operations);',
    );
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        'id',
        'scope',
        'plan_hash',
        'plan_json',
        'state',
        'failure_categories_json',
        'requested_at',
        'started_at',
        'completed_at',
        'updated_at',
      ],
    );
    await database.closeAsync();
  });

  test('upgrades populated released v4 data through v6 and repositories can read it', async () => {
    const database = new NodeSqliteDatabase(temporaryDatabase());
    await createReleasedV4Fixture(database);
    const releasedVersion = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(releasedVersion[0]?.version, 4);
    const releasedIntakeColumns = await database.getAllAsync<{ name: string }>(
      'PRAGMA table_info(intake_events);',
    );
    assert.equal(
      releasedIntakeColumns.some((column) => column.name === 'source_media_hash'),
      false,
    );
    assert.equal(
      (
        await database.getAllAsync(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cloud_jobs', 'app_preferences', 'intake_capture_recovery');",
        )
      ).length,
      0,
    );

    const boundary = createBoundary(database);
    await boundary.initialize();
    const versionRows = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(versionRows[0]?.version, CURRENT_SCHEMA_VERSION);
    assert.equal(
      (await database.getAllAsync('SELECT id FROM cloud_jobs')).length,
      0,
      'v5 creates an empty cloud job table when upgrading a true v4 database',
    );
    assert.equal(
      (await database.getAllAsync('SELECT key FROM app_preferences')).length,
      0,
      'v5 creates an empty preferences table when upgrading a true v4 database',
    );
    assert.equal(
      (
        await database.getAllAsync<{ original_filename: string }>(
          'SELECT original_filename FROM lab_reports WHERE id = ?',
          'report-old-v5',
        )
      )[0]?.original_filename,
      'synthetic.pdf',
    );
    const labRepository = createLabRepository(database, { protection });
    const record = await labRepository.getRecord('record-old-v5');
    assert.equal(record?.labReportId, 'report-old-v5');
    assert.equal(record?.measurements[0]?.id, 'measurement-old-v5');
    assert.equal(record?.measurements[0]?.current.valueString, '3.2');

    const intakeRepository = createIntakeRepository(database, { protection });
    const event = await intakeRepository.getEvent('event-old-v5');
    assert.equal(event?.sourceMediaPath, 'protected://intake/old.jpg');
    assert.equal(event?.sourceMediaHash, null);
    assert.equal(event?.components[0]?.id, 'component-old-v5');
    assert.equal(event?.components[0]?.name, 'Breakfast');
    await boundary.close();
  });

  test('upgrades the released old-v5 shape without losing records', async () => {
    const database = new NodeSqliteDatabase(temporaryDatabase());
    await database.execAsync(OLD_V5_FIXTURE_SQL);

    const boundary = createBoundary(database);
    await boundary.initialize();

    const versionRows = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(versionRows[0]?.version, CURRENT_SCHEMA_VERSION);
    const columns = await database.getAllAsync<{ name: string }>(
      'PRAGMA table_info(intake_events);',
    );
    assert.deepEqual(
      columns.map((column) => column.name).filter((name) => name.startsWith('source_media_')),
      [
        'source_media_path',
        'source_media_hash',
        'source_media_size',
        'source_media_protection_json',
      ],
    );
    const tables = await database.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cloud_jobs', 'app_preferences', 'intake_capture_recovery');",
    );
    assert.deepEqual(tables.map((table) => table.name).sort(), [
      'app_preferences',
      'cloud_jobs',
      'intake_capture_recovery',
    ]);
    assert.equal(
      (await database.getAllAsync('SELECT id FROM lab_reports WHERE id = ?', 'report-old-v5'))
        .length,
      1,
    );
    assert.equal(
      (await database.getAllAsync('SELECT id FROM lab_records WHERE id = ?', 'record-old-v5'))
        .length,
      1,
    );
    assert.equal(
      (await database.getAllAsync('SELECT id FROM measurements WHERE id = ?', 'measurement-old-v5'))
        .length,
      1,
    );
    assert.equal(
      (await database.getAllAsync('SELECT id FROM intake_events WHERE id = ?', 'event-old-v5'))
        .length,
      1,
    );
    assert.equal(
      (
        await database.getAllAsync(
          'SELECT id FROM intake_components WHERE id = ?',
          'component-old-v5',
        )
      ).length,
      1,
    );
    assert.equal(
      (await database.getAllAsync('SELECT id FROM cloud_jobs WHERE id = ?', 'job-old-v5')).length,
      1,
    );
    assert.equal(
      (
        await database.getAllAsync<{ value: string }>(
          'SELECT value FROM app_preferences WHERE key = ?',
          'cloud_mode',
        )
      )[0]?.value,
      'local-only',
    );
    await boundary.close();
  });

  test('builds a clean current schema from zero and can initialize it again', async () => {
    const databasePath = temporaryDatabase();
    const firstDatabase = new NodeSqliteDatabase(databasePath);
    const firstBoundary = createBoundary(firstDatabase);
    await firstBoundary.initialize();

    const versionRows = await firstDatabase.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations;',
    );
    assert.equal(versionRows[0]?.version, CURRENT_SCHEMA_VERSION);
    const requiredTables = await firstDatabase.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lab_reports', 'lab_records', 'measurements', 'intake_events', 'intake_components', 'cloud_jobs', 'app_preferences', 'intake_capture_recovery', 'extraction_drafts', 'extraction_draft_rows', 'extraction_operations', 'lab_combined_deletions', 'local_export_jobs', 'local_deletion_operations');",
    );
    assert.deepEqual(requiredTables.map((table) => table.name).sort(), [
      'app_preferences',
      'cloud_jobs',
      'extraction_draft_rows',
      'extraction_drafts',
      'extraction_operations',
      'intake_capture_recovery',
      'intake_components',
      'intake_events',
      'lab_combined_deletions',
      'lab_records',
      'lab_reports',
      'local_deletion_operations',
      'local_export_jobs',
      'measurements',
    ]);
    const measurementColumns = await firstDatabase.getAllAsync<{ name: string }>(
      'PRAGMA table_info(measurements);',
    );
    assert.deepEqual(
      measurementColumns.map((column) => column.name).filter((name) => name.startsWith('source_')),
      ['source_page_index', 'source_bbox_json', 'source_orientation'],
    );
    const extractionColumns = await firstDatabase.getAllAsync<{ name: string }>(
      'PRAGMA table_info(extraction_draft_rows);',
    );
    for (const name of ['source_value_json', 'date_context_json', 'decision']) {
      assert.ok(extractionColumns.some((column) => column.name === name));
    }
    const columns = await firstDatabase.getAllAsync<{ name: string }>(
      'PRAGMA table_info(intake_events);',
    );
    for (const name of ['source_media_hash', 'source_media_size', 'source_media_protection_json']) {
      assert.ok(columns.some((column) => column.name === name));
    }
    await firstBoundary.close();

    const secondDatabase = new NodeSqliteDatabase(databasePath);
    const secondBoundary = createBoundary(secondDatabase);
    await assert.doesNotReject(secondBoundary.initialize());
    await secondBoundary.close();
  });
});
