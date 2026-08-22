export type MigrationDatabase = {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string, ...params: readonly unknown[]): Promise<readonly T[]>;
};

type SqlMigration = {
  readonly version: number;
  readonly sql: string;
};

type CallbackMigration = {
  readonly version: number;
  /**
   * A migration can inspect the existing shape before executing its forward changes.
   * This is needed for SQLite additions that have to bridge an amended, already-applied schema.
   */
  readonly apply: (database: MigrationDatabase) => Promise<void>;
};

export type Migration = SqlMigration | CallbackMigration;

export const CURRENT_SCHEMA_VERSION = 6;

const INTAKE_CAPTURE_RECOVERY_DDL = `
  CREATE TABLE IF NOT EXISTS intake_capture_recovery (
    capture_id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT,
    media_path TEXT NOT NULL,
    media_hash TEXT,
    media_size INTEGER,
    media_protection_json TEXT,
    event_json TEXT NOT NULL,
    cloud_mode TEXT NOT NULL CHECK (cloud_mode IN ('local-only', 'consented-cloud')),
    consent_policy_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('capturing', 'staged', 'committed', 'failed')),
    failure_category TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS intake_capture_recovery_state_idx
    ON intake_capture_recovery(state, updated_at ASC);
  CREATE INDEX IF NOT EXISTS intake_capture_recovery_event_id_idx
    ON intake_capture_recovery(event_id);
`;

/** The single forward-only schema history shared by the local feature repositories. */
export const LOCAL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS lab_records (
        id TEXT PRIMARY KEY NOT NULL,
        collection_date TEXT,
        date_state TEXT NOT NULL CHECK (date_state IN ('known', 'missing')),
        specimen_type TEXT NOT NULL,
        laboratory_name TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS measurements (
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

      CREATE TABLE IF NOT EXISTS measurement_corrections (
        id TEXT PRIMARY KEY NOT NULL,
        measurement_id TEXT NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
        corrected_at TEXT NOT NULL,
        reason TEXT,
        previous_json TEXT NOT NULL,
        next_json TEXT NOT NULL,
        previous_provenance TEXT NOT NULL CHECK (previous_provenance IN ('user-entered', 'extracted', 'user-corrected'))
      );

      CREATE INDEX IF NOT EXISTS measurements_lab_record_id_idx ON measurements(lab_record_id);
      CREATE INDEX IF NOT EXISTS measurement_corrections_measurement_id_idx ON measurement_corrections(measurement_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS lab_reports (
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
        imported_at TEXT
      );

      CREATE TABLE IF NOT EXISTS lab_report_pages (
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

      ALTER TABLE lab_records ADD COLUMN lab_report_id TEXT REFERENCES lab_reports(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS lab_reports_updated_at_idx ON lab_reports(updated_at DESC);
      CREATE INDEX IF NOT EXISTS lab_reports_source_hash_idx ON lab_reports(source_hash);
      CREATE INDEX IF NOT EXISTS lab_report_pages_report_id_idx ON lab_report_pages(report_id);
      CREATE INDEX IF NOT EXISTS lab_records_lab_report_id_idx ON lab_records(lab_report_id);
      CREATE UNIQUE INDEX IF NOT EXISTS lab_reports_active_source_hash_uq
        ON lab_reports(source_hash)
        WHERE source_hash IS NOT NULL AND import_state <> 'deleted';
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE lab_reports ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'none'
        CHECK (deletion_state IN ('none', 'requested', 'failed', 'complete'));
      ALTER TABLE lab_reports ADD COLUMN deletion_requested_at TEXT;
      ALTER TABLE lab_reports ADD COLUMN deletion_error TEXT;
      CREATE INDEX IF NOT EXISTS lab_reports_deletion_state_idx ON lab_reports(deletion_state);
      DROP INDEX IF EXISTS lab_reports_active_source_hash_uq;
      CREATE UNIQUE INDEX lab_reports_active_source_hash_uq
        ON lab_reports(source_hash)
        WHERE source_hash IS NOT NULL AND original_path IS NOT NULL
          AND import_state <> 'deleted' AND deletion_state = 'none';
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS sanitized_report_derivatives (
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

      CREATE INDEX IF NOT EXISTS sanitized_report_derivatives_report_id_idx
        ON sanitized_report_derivatives(report_id);
      CREATE INDEX IF NOT EXISTS sanitized_report_derivatives_state_idx
        ON sanitized_report_derivatives(verification_state);

      CREATE TABLE IF NOT EXISTS intake_events (
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
        source_media_hash TEXT,
        source_media_size INTEGER,
        source_media_protection_json TEXT,
        copied_from_event_id TEXT REFERENCES intake_events(id) ON DELETE SET NULL,
        log_again_undoable INTEGER NOT NULL DEFAULT 0 CHECK (log_again_undoable IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intake_components (
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

      CREATE INDEX IF NOT EXISTS intake_events_local_date_idx
        ON intake_events(local_date, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS intake_components_event_id_idx
        ON intake_components(event_id, created_at ASC);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS cloud_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES intake_events(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('intake-image')),
        media_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'uploading', 'submitted', 'processing', 'ready', 'applied',
          'failed', 'expired', 'cancelled'
        )),
        consent_policy_version TEXT NOT NULL,
        failure_category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        cancelled_at TEXT,
        UNIQUE(event_id, operation)
      );

      CREATE INDEX IF NOT EXISTS cloud_jobs_state_idx
        ON cloud_jobs(state, updated_at ASC);
      CREATE INDEX IF NOT EXISTS cloud_jobs_event_id_idx
        ON cloud_jobs(event_id);

      CREATE TABLE IF NOT EXISTS app_preferences (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ${INTAKE_CAPTURE_RECOVERY_DDL}
    `,
  },
  {
    version: 6,
    apply: async (database) => {
      await database.execAsync(INTAKE_CAPTURE_RECOVERY_DDL);
      const columns = await database.getAllAsync<{ name: string }>(
        'PRAGMA table_info(intake_events);',
      );
      const existingColumns = new Set(columns.map((column) => column.name));
      const additions = [
        ['source_media_hash', 'TEXT'],
        ['source_media_size', 'INTEGER'],
        ['source_media_protection_json', 'TEXT'],
      ] as const;
      for (const [name, type] of additions) {
        if (!existingColumns.has(name)) {
          await database.execAsync(`ALTER TABLE intake_events ADD COLUMN ${name} ${type};`);
        }
      }
    },
  },
];
