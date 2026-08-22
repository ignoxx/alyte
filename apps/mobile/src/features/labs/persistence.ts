import {
  assertLabDateState,
  assertMeasurementValue,
  canonicalId,
  formatMeasurementValue,
  type CorrectMeasurementInput,
  type CreateLabRecordInput,
  type CreateMeasurementInput,
  type LabRecord,
  type Measurement,
  type MeasurementCorrection,
  type MeasurementSnapshot,
  type MeasurementValue,
  type UpdateLabRecordInput,
} from '@alyte/domain';
import { nativeDatabaseProtection, type DatabaseProtection } from './protection';

export const LAB_DATABASE_NAME = 'alyte-local.sqlite';
export const CURRENT_SCHEMA_VERSION = 1;

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
];

type LabRecordRow = {
  id: unknown;
  collection_date: unknown;
  date_state: unknown;
  specimen_type: unknown;
  laboratory_name: unknown;
  notes: unknown;
  created_at: unknown;
  updated_at: unknown;
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
  const snapshot: MeasurementSnapshot = {
    label: requiredString(candidate.label, 'measurement label'),
    value: storedValue(candidate.value),
    valueString: requiredString(candidate.valueString, 'measurement value string'),
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
      valueString: requiredString(row.current_value_string, 'current measurement value string'),
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

function decodeCorrectionRow(row: CorrectionRow): MeasurementCorrection {
  return {
    id: requiredString(row.id, 'measurement correction id'),
    measurementId: requiredString(row.measurement_id, 'correction measurement id'),
    correctedAt: requiredString(row.corrected_at, 'correction timestamp'),
    reason: nullableString(row.reason, 'correction reason'),
    previous: snapshotFromUnknown(parseJson(row.previous_json, 'previous correction')),
    next: snapshotFromUnknown(parseJson(row.next_json, 'next correction')),
    previousProvenance: enumValue(
      row.previous_provenance,
      provenances,
      'previous measurement provenance',
    ),
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
  const valueString = input.valueString ?? current?.valueString ?? formatMeasurementValue(value);
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
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return uuid;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  let writeQueue: Promise<void> = Promise.resolve();

  async function ensureProtection(): Promise<void> {
    await protection.protectDatabaseFiles(database.databasePath);
  }

  async function initialize(): Promise<void> {
    if (initialized) {
      return;
    }
    await database.execAsync(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
    );
    await ensureProtection();
    await database.execAsync(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);',
    );
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
      });
      await ensureProtection();
    }
    await ensureProtection();
    initialized = true;
  }

  async function withWrite<T>(work: () => Promise<T>): Promise<T> {
    const previous = writeQueue;
    let release!: () => void;
    writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await ensureProtection();
      const result = await work();
      await ensureProtection();
      return result;
    } finally {
      release();
    }
  }

  async function listRecords(): Promise<readonly LabRecord[]> {
    await initialize();
    const rows = await database.getAllAsync<LabRecordRow>(
      "SELECT id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at FROM lab_records ORDER BY COALESCE(collection_date, '9999-12-31') DESC, created_at DESC;",
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
        return { ...measurement, corrections: correctionRows.map(decodeCorrectionRow) };
      }),
    );
  }

  async function getRecord(id: string): Promise<LabRecord | null> {
    await initialize();
    const rows = await database.getAllAsync<LabRecordRow>(
      'SELECT id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at FROM lab_records WHERE id = ?;',
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
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          `INSERT INTO lab_records (id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          recordId,
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
    await withWrite(async () => {
      await database.withTransactionAsync(async () => {
        const result = await database.runAsync(
          `UPDATE lab_records SET collection_date = ?, date_state = ?, specimen_type = ?, laboratory_name = ?, notes = ?, updated_at = ? WHERE id = ?;`,
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
    return withWrite(async () => {
      let corrected: Measurement | null = null;
      await database.withTransactionAsync(async () => {
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
        const nextInput: CreateMeasurementInput = {
          ...asSnapshotInput(existing.current),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.value === undefined ? {} : { value: input.value }),
          ...(input.valueString === undefined ? {} : { valueString: input.valueString }),
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.referenceInterval === undefined
            ? {}
            : { referenceInterval: input.referenceInterval }),
          ...(input.flag === undefined ? {} : { flag: input.flag }),
        };
        const next = normalizeSnapshotInput(nextInput, existing.current);
        const correctedAt = now();
        await database.runAsync(
          `INSERT INTO measurement_corrections (
            id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
          makeId('measurement-correction'),
          id,
          correctedAt,
          input.reason ?? null,
          JSON.stringify(existing.current),
          JSON.stringify(next),
          existing.provenance,
        );
        await database.runAsync(
          `UPDATE measurements SET current_label = ?, current_value_string = ?, current_value_json = ?,
            current_unit = ?, current_reference_interval = ?, current_flag = ?, provenance = 'user-corrected',
            updated_at = ? WHERE id = ?;`,
          next.label,
          next.valueString,
          snapshotToJson(next),
          next.unit,
          next.referenceInterval,
          next.flag,
          correctedAt,
          id,
        );
        corrected = {
          ...existing,
          current: next,
          provenance: 'user-corrected',
          corrections: [],
        };
      });
      if (corrected === null) {
        throw new Error('Corrected Measurement could not be read back');
      }
      const recordRows = await database.getAllAsync<{ lab_record_id: string }>(
        'SELECT lab_record_id FROM measurements WHERE id = ?;',
        id,
      );
      const recordId = recordRows[0]?.lab_record_id;
      if (recordId === undefined) {
        throw new Error('Corrected Measurement could not be associated with a Lab Record');
      }
      const readBack = await getRecord(recordId);
      const measurement = readBack?.measurements.find((candidate) => candidate.id === id);
      if (measurement === undefined) {
        throw new Error('Corrected Measurement could not be read back');
      }
      return measurement;
    });
  }

  async function deleteRecord(id: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await database.withTransactionAsync(async () => {
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
      });
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

  return {
    initialize,
    close: () => database.closeAsync(),
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    correctMeasurement,
    deleteRecord,
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
