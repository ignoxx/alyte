import {
  assertLabDateState,
  assertMeasurementValue,
  canonicalId,
  createSortableOpaqueId,
  formatMeasurementValue,
  type CorrectMeasurementInput,
  type CreateLabRecordInput,
  type CreateMeasurementInput,
  type LabRecord,
  type LabReport,
  type CreateLabReportInput,
  type UpdateLabReportInput,
  assertLabReportImportState,
  assertLabReportPage,
  assertLabReportSourceType,
  type LabReportPage,
  type Measurement,
  type MeasurementCorrection,
  type MeasurementCorrectionState,
  type MeasurementSnapshot,
  type MeasurementValue,
  type UpdateLabRecordInput,
} from '@alyte/domain';
import { nativeDatabaseProtection, type DatabaseProtection } from './protection';

export const LAB_DATABASE_NAME = 'alyte-local.sqlite';
export const CURRENT_SCHEMA_VERSION = 2;

export type SqliteRunResult = { readonly changes: number; readonly lastInsertRowId: number };

export interface SqliteDatabase {
  readonly databasePath: string;
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: readonly unknown[]): Promise<SqliteRunResult>;
  getAllAsync<T>(source: string, ...params: readonly unknown[]): Promise<readonly T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

type Migration = { readonly version: number; readonly sql: string };

export const LAB_MIGRATIONS: readonly Migration[] = [
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
];

type LabRecordRow = {
  id: unknown;
  lab_report_id: unknown;
  collection_date: unknown;
  date_state: unknown;
  specimen_type: unknown;
  laboratory_name: unknown;
  notes: unknown;
  created_at: unknown;
  updated_at: unknown;
};

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

type MeasurementRow = {
  id: unknown;
  lab_record_id: unknown;
  biomarker_id: unknown;
  specimen_type: unknown;
  original_label: unknown;
  original_value_string: unknown;
  original_value_json: unknown;
  original_unit: unknown;
  original_reference_interval: unknown;
  original_flag: unknown;
  current_label: unknown;
  current_value_string: unknown;
  current_value_json: unknown;
  current_unit: unknown;
  current_reference_interval: unknown;
  current_flag: unknown;
  provenance: unknown;
  review_state: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type CorrectionRow = {
  id: unknown;
  measurement_id: unknown;
  corrected_at: unknown;
  reason: unknown;
  previous_json: unknown;
  next_json: unknown;
  previous_provenance: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Invalid ${field} in local database`);
  }
  return value as T;
}

function storedValue(value: unknown): MeasurementValue {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Invalid measurement value in local database');
  }
  const candidate = value as Record<string, unknown>;
  const kind = enumValue(
    candidate.kind,
    ['numeric', 'bounded', 'categorical', 'free_text'] as const,
    'measurement value kind',
  );
  if (kind === 'numeric') {
    if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) {
      throw new Error('Invalid numeric measurement value in local database');
    }
    return { kind, value: candidate.value };
  }
  if (kind === 'bounded') {
    if (
      (candidate.comparator !== '<' && candidate.comparator !== '>') ||
      typeof candidate.value !== 'number' ||
      !Number.isFinite(candidate.value)
    ) {
      throw new Error('Invalid bounded measurement value in local database');
    }
    return { kind, comparator: candidate.comparator, value: candidate.value };
  }
  if (typeof candidate.value !== 'string' || candidate.value.length === 0) {
    throw new Error('Invalid text measurement value in local database');
  }
  return { kind, value: candidate.value };
}

function snapshotFromUnknown(value: unknown): MeasurementSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid measurement snapshot in local database');
  }
  const candidate = value as Record<string, unknown>;
  const storedMeasurementValue = storedValue(candidate.value);
  const snapshot: MeasurementSnapshot = {
    label: requiredString(candidate.label, 'measurement label'),
    value: storedMeasurementValue,
    // Numeric and bounded display strings are derived from the typed value so a stale
    // hand-edited column can never reintroduce a comparator/value contradiction after reopen.
    valueString:
      storedMeasurementValue.kind === 'numeric' || storedMeasurementValue.kind === 'bounded'
        ? formatMeasurementValue(storedMeasurementValue)
        : requiredString(candidate.valueString, 'measurement value string'),
    unit: nullableString(candidate.unit, 'measurement unit'),
    referenceInterval: nullableString(candidate.referenceInterval, 'reference interval'),
    flag: nullableString(candidate.flag, 'laboratory flag'),
  };
  assertMeasurementValue(snapshot.value);
  return snapshot;
}

function parseJson(value: unknown, field: string): unknown {
  const json = requiredString(value, field);
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON in local database`, { cause: error });
  }
}

const specimenTypes = ['blood', 'serum', 'plasma', 'urine', 'stool', 'saliva', 'unknown'] as const;
const provenances = ['user-entered', 'extracted', 'user-corrected'] as const;
const reviewStates = ['confirmed', 'needs-review'] as const;

export function decodeLabRecordRow(row: LabRecordRow): Omit<LabRecord, 'measurements'> {
  const dateState = enumValue(row.date_state, ['known', 'missing'] as const, 'lab date state');
  const collectionDate = nullableString(row.collection_date, 'collection date');
  if (dateState === 'known') {
    if (collectionDate === null) {
      throw new Error('Known lab date is missing its date value');
    }
    assertLabDateState({ kind: 'known', value: collectionDate });
  } else if (collectionDate !== null) {
    throw new Error('Date-missing lab record unexpectedly has a date value');
  }
  return {
    id: requiredString(row.id, 'lab record id'),
    labReportId: nullableString(row.lab_report_id, 'lab report id'),
    collectionDate:
      dateState === 'known'
        ? { kind: 'known', value: collectionDate as string }
        : { kind: 'missing' },
    specimenType: enumValue(row.specimen_type, specimenTypes, 'specimen type'),
    laboratoryName: nullableString(row.laboratory_name, 'laboratory name'),
    notes: nullableString(row.notes, 'lab record notes'),
    createdAt: requiredString(row.created_at, 'lab record created timestamp'),
    updatedAt: requiredString(row.updated_at, 'lab record updated timestamp'),
  };
}

function decodeLabReportPageRow(row: LabReportPageRow): LabReportPage {
  const reportId = requiredString(row.report_id, 'Lab Report page report id');
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
    reportId,
    pageIndex,
    width: nullableFiniteNumber(row.width, 'Lab Report page width'),
    height: nullableFiniteNumber(row.height, 'Lab Report page height'),
    rotation,
    crop: nullableString(row.crop, 'Lab Report page crop'),
    derivedPath: nullableString(row.derived_path, 'Lab Report page derived path'),
  };
}

export function decodeLabReportRow(row: LabReportRow): Omit<LabReport, 'pages' | 'labRecordIds'> {
  const sourceType = row.source_type;
  if (sourceType !== 'pdf' && sourceType !== 'image') {
    throw new Error('Invalid Lab Report source type in local database');
  }
  const importState = row.import_state;
  if (
    importState !== 'importing' &&
    importState !== 'imported' &&
    importState !== 'interrupted' &&
    importState !== 'failed' &&
    importState !== 'deleted'
  ) {
    throw new Error('Invalid Lab Report import state in local database');
  }
  const encrypted = row.encrypted;
  if (encrypted !== 0 && encrypted !== 1) {
    throw new Error('Invalid Lab Report encryption state in local database');
  }
  const pageCount = nullableFiniteNumber(row.page_count, 'Lab Report page count');
  if (pageCount !== null && (!Number.isInteger(pageCount) || pageCount < 0)) {
    throw new Error('Invalid Lab Report page count in local database');
  }
  const byteSize = nullableFiniteNumber(row.byte_size, 'Lab Report byte size');
  if (byteSize !== null && (!Number.isInteger(byteSize) || byteSize < 0)) {
    throw new Error('Invalid Lab Report byte size in local database');
  }
  return {
    id: requiredString(row.id, 'Lab Report id'),
    sourceType,
    originalFilename: requiredString(row.original_filename, 'Lab Report filename'),
    mimeType: requiredString(row.mime_type, 'Lab Report MIME type'),
    byteSize,
    sourceHash: nullableString(row.source_hash, 'Lab Report source hash'),
    originalPath: nullableString(row.original_path, 'Lab Report original path'),
    importState,
    failureReason: nullableString(row.failure_reason, 'Lab Report failure reason'),
    encrypted: encrypted === 1,
    pageCount,
    createdAt: requiredString(row.created_at, 'Lab Report created timestamp'),
    updatedAt: requiredString(row.updated_at, 'Lab Report updated timestamp'),
    importedAt: nullableString(row.imported_at, 'Lab Report imported timestamp'),
  };
}

export function decodeMeasurementRow(row: MeasurementRow): Omit<Measurement, 'corrections'> {
  const original = snapshotFromUnknown(
    parseJson(row.original_value_json, 'original measurement value'),
  );
  const current = snapshotFromUnknown(
    parseJson(row.current_value_json, 'current measurement value'),
  );
  return {
    id: requiredString(row.id, 'measurement id'),
    labRecordId: requiredString(row.lab_record_id, 'measurement lab record id'),
    biomarkerId:
      row.biomarker_id === null || row.biomarker_id === undefined
        ? null
        : canonicalId(requiredString(row.biomarker_id, 'biomarker id')),
    specimenType: enumValue(row.specimen_type, specimenTypes, 'measurement specimen type'),
    original: {
      ...original,
      label: requiredString(row.original_label, 'original measurement label'),
      valueString: requiredString(row.original_value_string, 'original measurement value string'),
      unit: nullableString(row.original_unit, 'original measurement unit'),
      referenceInterval: nullableString(
        row.original_reference_interval,
        'original reference interval',
      ),
      flag: nullableString(row.original_flag, 'original laboratory flag'),
    },
    current: {
      ...current,
      label: requiredString(row.current_label, 'current measurement label'),
      valueString:
        current.value.kind === 'numeric' || current.value.kind === 'bounded'
          ? formatMeasurementValue(current.value)
          : requiredString(row.current_value_string, 'current measurement value string'),
      unit: nullableString(row.current_unit, 'current measurement unit'),
      referenceInterval: nullableString(
        row.current_reference_interval,
        'current reference interval',
      ),
      flag: nullableString(row.current_flag, 'current laboratory flag'),
    },
    provenance: enumValue(row.provenance, provenances, 'measurement provenance'),
    reviewState: enumValue(row.review_state, reviewStates, 'measurement review state'),
  };
}

function decodeCorrectionRow(
  row: CorrectionRow,
  measurement: Omit<Measurement, 'corrections'>,
): MeasurementCorrection {
  const previousProvenance = enumValue(
    row.previous_provenance,
    provenances,
    'previous measurement provenance',
  );
  const previous = correctionStateFromUnknown(parseJson(row.previous_json, 'previous correction'), {
    biomarkerId: measurement.biomarkerId,
    specimenType: measurement.specimenType,
    reviewState: measurement.reviewState,
    provenance: previousProvenance,
  });
  const next = correctionStateFromUnknown(parseJson(row.next_json, 'next correction'), {
    biomarkerId: measurement.biomarkerId,
    specimenType: measurement.specimenType,
    reviewState: measurement.reviewState,
    provenance: 'user-corrected',
  });
  return {
    id: requiredString(row.id, 'measurement correction id'),
    measurementId: requiredString(row.measurement_id, 'correction measurement id'),
    correctedAt: requiredString(row.corrected_at, 'correction timestamp'),
    reason: nullableString(row.reason, 'correction reason'),
    previous,
    next,
    previousProvenance: previous.provenance,
  };
}

function correctionStateFromUnknown(
  value: unknown,
  fallback: Omit<MeasurementCorrectionState, 'snapshot'>,
): MeasurementCorrectionState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid correction state in local database');
  }
  const candidate = value as Record<string, unknown>;
  const biomarkerValue = candidate.biomarkerId;
  const snapshotValue = candidate.snapshot === undefined ? candidate : candidate.snapshot;
  return {
    biomarkerId:
      candidate.biomarkerId === undefined
        ? fallback.biomarkerId
        : biomarkerValue === null
          ? null
          : canonicalId(requiredString(biomarkerValue, 'correction biomarker id')),
    specimenType:
      candidate.specimenType === undefined
        ? fallback.specimenType
        : enumValue(candidate.specimenType, specimenTypes, 'correction specimen type'),
    snapshot: snapshotFromUnknown(snapshotValue),
    reviewState:
      candidate.reviewState === undefined
        ? fallback.reviewState
        : enumValue(candidate.reviewState, reviewStates, 'correction review state'),
    provenance:
      candidate.provenance === undefined
        ? fallback.provenance
        : enumValue(candidate.provenance, provenances, 'correction provenance'),
  };
}

function snapshotToJson(snapshot: MeasurementSnapshot): string {
  return JSON.stringify(snapshot);
}

function normalizeSnapshotInput(
  input: CreateMeasurementInput,
  current?: MeasurementSnapshot,
): MeasurementSnapshot {
  const label = input.label ?? current?.label;
  if (label === undefined || label.trim().length === 0) {
    throw new Error('Measurement label is required');
  }
  const value = input.value ?? current?.value;
  if (value === undefined) {
    throw new Error('Measurement value is required');
  }
  assertMeasurementValue(value);
  const valueString =
    value.kind === 'numeric' || value.kind === 'bounded'
      ? formatMeasurementValue(value)
      : value.value;
  return {
    label,
    value,
    valueString,
    unit: input.unit === undefined ? (current?.unit ?? null) : input.unit,
    referenceInterval:
      input.referenceInterval === undefined
        ? (current?.referenceInterval ?? null)
        : input.referenceInterval,
    flag: input.flag === undefined ? (current?.flag ?? null) : input.flag,
  };
}

function idFor(prefix: string): string {
  return createSortableOpaqueId(prefix);
}

function isoNow(): string {
  return new Date().toISOString();
}

export type LabRepository = {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listRecords(): Promise<readonly LabRecord[]>;
  getRecord(id: string): Promise<LabRecord | null>;
  createRecord(input: CreateLabRecordInput): Promise<LabRecord>;
  updateRecord(id: string, input: UpdateLabRecordInput): Promise<LabRecord>;
  correctMeasurement(id: string, input: CorrectMeasurementInput): Promise<Measurement>;
  deleteRecord(id: string): Promise<void>;
  listReports(): Promise<readonly LabReport[]>;
  getReport(id: string): Promise<LabReport | null>;
  findReportByHash(sourceHash: string): Promise<LabReport | null>;
  createReport(input: CreateLabReportInput): Promise<LabReport>;
  updateReport(id: string, input: UpdateLabReportInput): Promise<LabReport>;
  deleteReport(id: string): Promise<void>;
  reconcileInterruptedReports(): Promise<void>;
  countReportsReferencingPath(path: string, excludingId?: string): Promise<number>;
};

export type LabRepositoryOptions = {
  readonly protection?: DatabaseProtection;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
};

function asSnapshotInput(snapshot: MeasurementSnapshot): CreateMeasurementInput {
  return {
    label: snapshot.label,
    value: snapshot.value,
    valueString: snapshot.valueString,
    unit: snapshot.unit,
    referenceInterval: snapshot.referenceInterval,
    flag: snapshot.flag,
  };
}

export function createLabRepository(
  database: SqliteDatabase,
  options: LabRepositoryOptions = {},
): LabRepository {
  const protection = options.protection ?? nativeDatabaseProtection;
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? idFor;
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  async function ensureProtection(options: { readonly requireSidecars: boolean }): Promise<void> {
    await protection.protectDatabaseFiles(database.databasePath, options);
  }

  async function initializeOnce(): Promise<void> {
    if (initialized) {
      return;
    }
    await database.execAsync(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
    );
    await ensureProtection({ requireSidecars: false });
    await database.execAsync(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);',
    );
    // The first schema write is the point at which SQLite may create WAL/SHM sidecars.
    // Refuse to continue until those files are protected and verified as well.
    await ensureProtection({ requireSidecars: true });
    const currentRows = await database.getAllAsync<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations;',
    );
    const current = currentRows[0]?.version ?? 0;
    if (!Number.isInteger(current) || current < 0 || current > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported local schema version: ${String(current)}`);
    }
    for (const migration of LAB_MIGRATIONS) {
      if (migration.version <= current) {
        continue;
      }
      await database.withTransactionAsync(async () => {
        await database.execAsync(migration.sql);
        await database.runAsync(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
          migration.version,
          now(),
        );
        await ensureProtection({ requireSidecars: true });
      });
    }
    await ensureProtection({ requireSidecars: true });
    initialized = true;
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    initializationPromise ??= initializeOnce();
    try {
      await initializationPromise;
    } catch (error) {
      initializationPromise = null;
      throw error;
    }
  }

  async function withWrite<T>(work: () => Promise<T>): Promise<T> {
    const previous = writeQueue;
    let release!: () => void;
    writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let result!: T;
      await database.withTransactionAsync(async () => {
        await ensureProtection({ requireSidecars: true });
        result = await work();
        // Keep the transaction open until the native adapter has verified every SQLite sidecar.
        // A failure here rolls back the requested health-record mutation.
        await ensureProtection({ requireSidecars: true });
      });
      return result;
    } finally {
      release();
    }
  }

  async function listRecords(): Promise<readonly LabRecord[]> {
    await initialize();
    const rows = await database.getAllAsync<LabRecordRow>(
      "SELECT id, lab_report_id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at FROM lab_records ORDER BY COALESCE(collection_date, '9999-12-31') DESC, created_at DESC;",
    );
    const records: LabRecord[] = [];
    for (const row of rows) {
      const record = decodeLabRecordRow(row);
      const measurements = await measurementsForRecord(record.id);
      records.push({ ...record, measurements });
    }
    return records;
  }

  async function measurementsForRecord(recordId: string): Promise<readonly Measurement[]> {
    const rows = await database.getAllAsync<MeasurementRow>(
      `SELECT id, lab_record_id, biomarker_id, specimen_type,
        original_label, original_value_string, original_value_json, original_unit,
        original_reference_interval, original_flag, current_label, current_value_string,
        current_value_json, current_unit, current_reference_interval, current_flag,
        provenance, review_state, created_at, updated_at
       FROM measurements WHERE lab_record_id = ? ORDER BY created_at ASC;`,
      recordId,
    );
    return Promise.all(
      rows.map(async (row) => {
        const measurement = decodeMeasurementRow(row);
        const correctionRows = await database.getAllAsync<CorrectionRow>(
          `SELECT id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance
           FROM measurement_corrections WHERE measurement_id = ? ORDER BY corrected_at ASC;`,
          measurement.id,
        );
        return {
          ...measurement,
          corrections: correctionRows.map((correctionRow) =>
            decodeCorrectionRow(correctionRow, measurement),
          ),
        };
      }),
    );
  }

  async function getRecord(id: string): Promise<LabRecord | null> {
    await initialize();
    const rows = await database.getAllAsync<LabRecordRow>(
      'SELECT id, lab_report_id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at FROM lab_records WHERE id = ?;',
      id,
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const record = decodeLabRecordRow(row);
    return { ...record, measurements: await measurementsForRecord(id) };
  }

  async function createRecord(input: CreateLabRecordInput): Promise<LabRecord> {
    await initialize();
    assertLabDateState(input.collectionDate);
    const recordId = input.id ?? makeId('lab-record');
    const createdAt = now();
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO lab_records (id, lab_report_id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        recordId,
        input.labReportId ?? null,
        input.collectionDate.kind === 'known' ? input.collectionDate.value : null,
        input.collectionDate.kind,
        input.specimenType ?? 'unknown',
        input.laboratoryName ?? null,
        input.notes ?? null,
        createdAt,
        createdAt,
      );
      for (const measurementInput of input.measurements) {
        const measurementId = measurementInput.id ?? makeId('measurement');
        const snapshot = normalizeSnapshotInput(measurementInput);
        const provenance = measurementInput.provenance ?? 'user-entered';
        const reviewState = measurementInput.reviewState ?? 'confirmed';
        await database.runAsync(
          `INSERT INTO measurements (
            id, lab_record_id, biomarker_id, specimen_type, original_label, original_value_string,
            original_value_json, original_unit, original_reference_interval, original_flag,
            current_label, current_value_string, current_value_json, current_unit,
            current_reference_interval, current_flag, provenance, review_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          measurementId,
          recordId,
          measurementInput.biomarkerId ?? null,
          measurementInput.specimenType ?? input.specimenType ?? 'unknown',
          snapshot.label,
          snapshot.valueString,
          snapshotToJson(snapshot),
          snapshot.unit,
          snapshot.referenceInterval,
          snapshot.flag,
          snapshot.label,
          snapshot.valueString,
          snapshotToJson(snapshot),
          snapshot.unit,
          snapshot.referenceInterval,
          snapshot.flag,
          provenance,
          reviewState,
          createdAt,
          createdAt,
        );
      }
    });
    const record = await getRecord(recordId);
    if (record === null) {
      throw new Error('Created Lab Record could not be read back');
    }
    return record;
  }

  async function updateRecord(id: string, input: UpdateLabRecordInput): Promise<LabRecord> {
    await initialize();
    assertLabDateState(input.collectionDate);
    const existing = await getRecord(id);
    if (existing === null) {
      throw new Error('Lab Record was not found');
    }
    const labReportId = input.labReportId === undefined ? existing.labReportId : input.labReportId;
    await withWrite(async () => {
      const result = await database.runAsync(
        `UPDATE lab_records SET lab_report_id = ?, collection_date = ?, date_state = ?, specimen_type = ?, laboratory_name = ?, notes = ?, updated_at = ? WHERE id = ?;`,
        labReportId ?? null,
        input.collectionDate.kind === 'known' ? input.collectionDate.value : null,
        input.collectionDate.kind,
        input.specimenType,
        input.laboratoryName,
        input.notes,
        now(),
        id,
      );
      if (result.changes !== 1) {
        throw new Error('Lab Record was not found');
      }
    });
    const record = await getRecord(id);
    if (record === null) {
      throw new Error('Updated Lab Record could not be read back');
    }
    return record;
  }

  async function correctMeasurement(
    id: string,
    input: CorrectMeasurementInput,
  ): Promise<Measurement> {
    await initialize();
    let recordId: string | null = null;
    await withWrite(async () => {
      const rows = await database.getAllAsync<MeasurementRow>(
        `SELECT id, lab_record_id, biomarker_id, specimen_type,
          original_label, original_value_string, original_value_json, original_unit,
          original_reference_interval, original_flag, current_label, current_value_string,
          current_value_json, current_unit, current_reference_interval, current_flag,
          provenance, review_state, created_at, updated_at
         FROM measurements WHERE id = ?;`,
        id,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('Measurement was not found');
      }
      const existing = decodeMeasurementRow(row);
      recordId = existing.labRecordId;
      const nextInput: CreateMeasurementInput = {
        ...asSnapshotInput(existing.current),
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.biomarkerId === undefined ? {} : { biomarkerId: input.biomarkerId }),
        ...(input.specimenType === undefined ? {} : { specimenType: input.specimenType }),
        ...(input.reviewState === undefined ? {} : { reviewState: input.reviewState }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.referenceInterval === undefined
          ? {}
          : { referenceInterval: input.referenceInterval }),
        ...(input.flag === undefined ? {} : { flag: input.flag }),
      };
      const next = normalizeSnapshotInput(nextInput, existing.current);
      const nextBiomarkerId =
        input.biomarkerId === undefined ? existing.biomarkerId : input.biomarkerId;
      const nextSpecimenType = input.specimenType ?? existing.specimenType;
      const nextReviewState = input.reviewState ?? existing.reviewState;
      const nextProvenance = 'user-corrected' as const;
      const previousState: MeasurementCorrectionState = {
        biomarkerId: existing.biomarkerId,
        specimenType: existing.specimenType,
        snapshot: existing.current,
        reviewState: existing.reviewState,
        provenance: existing.provenance,
      };
      const nextState: MeasurementCorrectionState = {
        biomarkerId: nextBiomarkerId ?? null,
        specimenType: nextSpecimenType,
        snapshot: next,
        reviewState: nextReviewState,
        provenance: nextProvenance,
      };
      const correctedAt = now();
      await database.runAsync(
        `INSERT INTO measurement_corrections (
          id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        makeId('measurement-correction'),
        id,
        correctedAt,
        input.reason ?? null,
        JSON.stringify(previousState),
        JSON.stringify(nextState),
        existing.provenance,
      );
      const result = await database.runAsync(
        `UPDATE measurements SET biomarker_id = ?, specimen_type = ?, current_label = ?, current_value_string = ?, current_value_json = ?,
          current_unit = ?, current_reference_interval = ?, current_flag = ?, provenance = ?, review_state = ?,
          updated_at = ? WHERE id = ?;`,
        nextBiomarkerId,
        nextSpecimenType,
        next.label,
        next.valueString,
        snapshotToJson(next),
        next.unit,
        next.referenceInterval,
        next.flag,
        nextProvenance,
        nextReviewState,
        correctedAt,
        id,
      );
      if (result.changes !== 1) {
        throw new Error('Corrected Measurement could not be saved');
      }
    });
    if (recordId === null) {
      throw new Error('Corrected Measurement could not be associated with a Lab Record');
    }
    const readBack = await getRecord(recordId);
    const measurement = readBack?.measurements.find((candidate) => candidate.id === id);
    if (measurement === undefined) {
      throw new Error('Corrected Measurement could not be read back');
    }
    return measurement;
  }

  async function deleteRecord(id: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      const existingRows = await database.getAllAsync<{ id: string }>(
        'SELECT id FROM lab_records WHERE id = ?;',
        id,
      );
      if (existingRows.length === 0) {
        return;
      }
      await database.runAsync('DELETE FROM measurements WHERE lab_record_id = ?;', id);
      const result = await database.runAsync('DELETE FROM lab_records WHERE id = ?;', id);
      if (result.changes !== 1) {
        throw new Error('Lab Record deletion did not complete');
      }
      const orphanRows = await database.getAllAsync<{ id: string }>(
        'SELECT id FROM measurements WHERE lab_record_id = ?;',
        id,
      );
      if (orphanRows.length > 0) {
        throw new Error('Lab Record deletion left orphaned Measurements');
      }
      const orphanCorrectionRows = await database.getAllAsync<{ id: string }>(
        `SELECT corrections.id
         FROM measurement_corrections AS corrections
         LEFT JOIN measurements ON measurements.id = corrections.measurement_id
         WHERE measurements.id IS NULL;`,
      );
      if (orphanCorrectionRows.length > 0) {
        throw new Error('Lab Record deletion left orphaned correction history');
      }
    });
  }

  async function reportPages(reportId: string): Promise<readonly LabReportPage[]> {
    const rows = await database.getAllAsync<LabReportPageRow>(
      `SELECT id, report_id, page_index, width, height, rotation, crop, derived_path
       FROM lab_report_pages WHERE report_id = ? ORDER BY page_index ASC;`,
      reportId,
    );
    return rows.map(decodeLabReportPageRow);
  }

  async function reportRecordIds(reportId: string): Promise<readonly string[]> {
    const rows = await database.getAllAsync<{ id: unknown }>(
      'SELECT id FROM lab_records WHERE lab_report_id = ? ORDER BY created_at ASC;',
      reportId,
    );
    return rows.map((row) => requiredString(row.id, 'Lab Record id'));
  }

  async function decodeReport(row: LabReportRow): Promise<LabReport> {
    const report = decodeLabReportRow(row);
    return {
      ...report,
      pages: await reportPages(report.id),
      labRecordIds: await reportRecordIds(report.id),
    };
  }

  const reportColumns = `id, source_type, original_filename, mime_type, byte_size, source_hash,
    original_path, import_state, failure_reason, encrypted, page_count, created_at, updated_at,
    imported_at`;

  async function listReports(): Promise<readonly LabReport[]> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${reportColumns} FROM lab_reports ORDER BY updated_at DESC, created_at DESC;`,
    );
    return Promise.all(rows.map(decodeReport));
  }

  async function getReport(id: string): Promise<LabReport | null> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${reportColumns} FROM lab_reports WHERE id = ?;`,
      id,
    );
    const row = rows[0];
    return row === undefined ? null : decodeReport(row);
  }

  async function findReportByHash(sourceHash: string): Promise<LabReport | null> {
    await initialize();
    const rows = await database.getAllAsync<LabReportRow>(
      `SELECT ${reportColumns} FROM lab_reports
       WHERE source_hash = ? AND import_state <> 'deleted'
       ORDER BY updated_at DESC LIMIT 1;`,
      sourceHash,
    );
    const row = rows[0];
    return row === undefined ? null : decodeReport(row);
  }

  async function createReport(input: CreateLabReportInput): Promise<LabReport> {
    await initialize();
    assertLabReportSourceType(input.sourceType);
    const importState = input.importState ?? 'importing';
    assertLabReportImportState(importState);
    if (input.originalFilename.trim().length === 0) {
      throw new Error('Lab Report filename is required');
    }
    if (input.mimeType.trim().length === 0) {
      throw new Error('Lab Report MIME type is required');
    }
    const reportId = input.id ?? makeId('lab-report');
    const createdAt = now();
    const pages = input.pages ?? [];
    pages.forEach(assertLabReportPage);
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO lab_reports (
          id, source_type, original_filename, mime_type, byte_size, source_hash, original_path,
          import_state, failure_reason, encrypted, page_count, created_at, updated_at, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
      );
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
    });
    const report = await getReport(reportId);
    if (report === null) {
      throw new Error('Created Lab Report could not be read back');
    }
    return report;
  }

  async function updateReport(id: string, input: UpdateLabReportInput): Promise<LabReport> {
    await initialize();
    const existing = await getReport(id);
    if (existing === null) {
      throw new Error('Lab Report was not found');
    }
    if (input.importState !== undefined) {
      assertLabReportImportState(input.importState);
    }
    const nextHash = input.sourceHash === undefined ? existing.sourceHash : input.sourceHash;
    if (
      existing.sourceHash !== null &&
      input.sourceHash !== undefined &&
      input.sourceHash !== existing.sourceHash
    ) {
      throw new Error('Original Report hash is immutable');
    }
    const nextPath = input.originalPath === undefined ? existing.originalPath : input.originalPath;
    if (
      existing.originalPath !== null &&
      input.originalPath !== undefined &&
      input.originalPath !== existing.originalPath &&
      input.importState !== 'deleted'
    ) {
      throw new Error('Original Report path is immutable');
    }
    const nextState = input.importState ?? existing.importState;
    const nextFailure =
      input.failureReason === undefined ? existing.failureReason : input.failureReason;
    const nextEncrypted = input.encrypted === undefined ? existing.encrypted : input.encrypted;
    const nextPageCount = input.pageCount === undefined ? existing.pageCount : input.pageCount;
    const nextImportedAt = input.importedAt === undefined ? existing.importedAt : input.importedAt;
    const pages = input.pages;
    if (pages !== undefined) {
      pages.forEach(assertLabReportPage);
    }
    await withWrite(async () => {
      const result = await database.runAsync(
        `UPDATE lab_reports SET source_hash = ?, original_path = ?, import_state = ?,
          failure_reason = ?, encrypted = ?, page_count = ?, updated_at = ?, imported_at = ?
         WHERE id = ?;`,
        nextHash,
        nextPath,
        nextState,
        nextFailure,
        nextEncrypted ? 1 : 0,
        nextPageCount,
        now(),
        nextImportedAt,
        id,
      );
      if (result.changes !== 1) {
        throw new Error('Lab Report update did not complete');
      }
      if (pages !== undefined) {
        await database.runAsync('DELETE FROM lab_report_pages WHERE report_id = ?;', id);
        for (const page of pages) {
          await database.runAsync(
            `INSERT INTO lab_report_pages (
              id, report_id, page_index, width, height, rotation, crop, derived_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
            page.id ?? makeId('lab-report-page'),
            id,
            page.pageIndex,
            page.width ?? null,
            page.height ?? null,
            page.rotation ?? 0,
            page.crop ?? null,
            page.derivedPath ?? null,
          );
        }
      }
    });
    const report = await getReport(id);
    if (report === null) {
      throw new Error('Updated Lab Report could not be read back');
    }
    return report;
  }

  async function deleteReport(id: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      const result = await database.runAsync(
        `UPDATE lab_reports SET import_state = 'deleted', original_path = NULL,
          updated_at = ?, failure_reason = NULL WHERE id = ?;`,
        now(),
        id,
      );
      if (result.changes !== 1) {
        throw new Error('Lab Report was not found');
      }
    });
  }

  async function reconcileInterruptedReports(): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await database.runAsync(
        `UPDATE lab_reports SET import_state = 'interrupted', failure_reason = 'interrupted',
          updated_at = ? WHERE import_state = 'importing';`,
        now(),
      );
    });
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
    if (typeof count !== 'number') {
      throw new Error('Invalid Lab Report reference count in local database');
    }
    return count;
  }

  return {
    initialize,
    close: () => database.closeAsync(),
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    correctMeasurement,
    deleteRecord,
    listReports,
    getReport,
    findReportByHash,
    createReport,
    updateReport,
    deleteReport,
    reconcileInterruptedReports,
    countReportsReferencingPath,
  };
}

export async function openProtectedLabDatabase(
  options: {
    readonly databaseName?: string;
    readonly protection?: DatabaseProtection;
  } = {},
): Promise<LabRepository> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  const database = await openDatabaseAsync(options.databaseName ?? LAB_DATABASE_NAME, {
    useNewConnection: true,
  });
  const repository =
    options.protection === undefined
      ? createLabRepository(database)
      : createLabRepository(database, { protection: options.protection });
  try {
    await repository.initialize();
    return repository;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}
