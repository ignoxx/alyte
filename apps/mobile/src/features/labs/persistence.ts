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
  type MeasurementCorrectionState,
  type MeasurementSnapshot,
  type MeasurementValue,
  type UpdateLabRecordInput,
} from '@alyte/domain';
import {
  createProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import { nativeDatabaseProtection, type DatabaseProtection } from './protection';
import { createLabReportRepository, type LabReportRepository } from './report-persistence';

export const LAB_DATABASE_NAME = 'alyte-local.sqlite';
export {
  CURRENT_SCHEMA_VERSION,
  LOCAL_MIGRATIONS as LAB_MIGRATIONS,
} from '../local-database/migrations';
export type { Migration } from '../local-database/migrations';
export type { SqliteDatabase, SqliteRunResult } from '../local-database/persistence';

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

export type LabRepository = {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listRecords(): Promise<readonly LabRecord[]>;
  getRecord(id: string): Promise<LabRecord | null>;
  createRecord(input: CreateLabRecordInput): Promise<LabRecord>;
  updateRecord(id: string, input: UpdateLabRecordInput): Promise<LabRecord>;
  correctMeasurement(id: string, input: CorrectMeasurementInput): Promise<Measurement>;
  deleteRecord(id: string): Promise<void>;
} & LabReportRepository;

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
  const boundary = createProtectedDatabaseBoundary(database, {
    protection,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
  });
  const { initialize, close, withWrite, now, makeId } = boundary;

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

  const reportRepository = createLabReportRepository({
    database,
    initialize,
    withWrite,
    now,
    idGenerator: makeId,
  });

  return {
    initialize,
    close,
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    correctMeasurement,
    deleteRecord,
    ...reportRepository,
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
