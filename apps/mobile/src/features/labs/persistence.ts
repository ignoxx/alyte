import {
  assertLabDateState,
  assertMeasurementValue,
  assertIntakeAmount,
  assertIntakeLocalDate,
  amountForInput,
  canonicalId,
  createSortableOpaqueId,
  formatMeasurementValue,
  formatIntakeLocalDate,
  type CorrectMeasurementInput,
  type CreateLabRecordInput,
  type CreateMeasurementInput,
  type CreateIntakeComponentInput,
  type CreateIntakeEventInput,
  type IntakeAmount,
  type IntakeChange,
  type IntakeChangeListener,
  type IntakeComponent,
  type IntakeComponentSnapshot,
  type IntakeEvent,
  type AnalysisInclusion,
  type UpdateIntakeEventInput,
  type LabRecord,
  type Measurement,
  type MeasurementCorrection,
  type MeasurementCorrectionState,
  type MeasurementSnapshot,
  type MeasurementValue,
  type UpdateLabRecordInput,
} from '@alyte/domain';
import { nativeDatabaseProtection, type DatabaseProtection } from './protection';
import { createLabReportRepository, type LabReportRepository } from './report-persistence';

export const LAB_DATABASE_NAME = 'alyte-local.sqlite';
export const CURRENT_SCHEMA_VERSION = 4;

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

type IntakeEventRow = {
  id: unknown;
  event_type: unknown;
  occurred_at: unknown;
  local_date: unknown;
  origin: unknown;
  provenance: unknown;
  review_state: unknown;
  analysis_inclusion: unknown;
  notes: unknown;
  source_media_path: unknown;
  copied_from_event_id: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type IntakeComponentRow = {
  id: unknown;
  event_id: unknown;
  canonical_id: unknown;
  original_name: unknown;
  original_amount_json: unknown;
  current_name: unknown;
  current_amount_json: unknown;
  provenance: unknown;
  review_state: unknown;
  created_at: unknown;
  updated_at: unknown;
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
const intakeEventTypes = ['food', 'drink', 'supplement', 'medication', 'other'] as const;
const intakeOrigins = ['manual', 'snap', 'cloud-recognized'] as const;
const intakeProvenances = ['user-entered', 'extracted', 'estimated', 'user-corrected'] as const;
const intakeReviewStates = ['confirmed', 'needs-review'] as const;
const analysisInclusions = ['included', 'excluded'] as const;

function intakeAmountFromUnknown(value: unknown): IntakeAmount {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid intake amount in local database');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'unknown') {
    const reason = enumValue(
      candidate.reason,
      ['not-provided', 'not-confirmed', 'not-applicable'] as const,
      'intake amount unknown reason',
    );
    return { kind: 'unknown', reason };
  }
  if (
    candidate.kind !== 'known' ||
    typeof candidate.value !== 'number' ||
    !Number.isFinite(candidate.value) ||
    candidate.value < 0 ||
    typeof candidate.unit !== 'string' ||
    candidate.unit.trim().length === 0
  ) {
    throw new Error('Invalid known intake amount in local database');
  }
  const amount = { kind: 'known' as const, value: candidate.value, unit: candidate.unit };
  assertIntakeAmount(amount);
  return amount;
}

function intakeSnapshotFromUnknown(value: unknown): IntakeComponentSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid intake component snapshot in local database');
  }
  const candidate = value as Record<string, unknown>;
  const name = requiredString(candidate.name, 'intake component name');
  if (candidate.canonicalId !== null && candidate.canonicalId !== undefined) {
    canonicalId(requiredString(candidate.canonicalId, 'intake component canonical id'));
  }
  return {
    name,
    amount: intakeAmountFromUnknown(candidate.amount),
    canonicalId:
      candidate.canonicalId === null || candidate.canonicalId === undefined
        ? null
        : canonicalId(requiredString(candidate.canonicalId, 'intake component canonical id')),
  };
}

function decodeIntakeEventRow(row: IntakeEventRow): Omit<IntakeEvent, 'components'> {
  const occurredAt = requiredString(row.occurred_at, 'intake event occurred timestamp');
  if (Number.isNaN(new Date(occurredAt).getTime())) {
    throw new Error('Invalid intake event occurred timestamp in local database');
  }
  const localDate = requiredString(row.local_date, 'intake event local date');
  assertIntakeLocalDate(localDate);
  return {
    id: requiredString(row.id, 'intake event id'),
    eventType: enumValue(row.event_type, intakeEventTypes, 'intake event type'),
    occurredAt,
    localDate,
    origin: enumValue(row.origin, intakeOrigins, 'intake event origin'),
    provenance: enumValue(row.provenance, intakeProvenances, 'intake event provenance'),
    reviewState: enumValue(row.review_state, intakeReviewStates, 'intake event review state'),
    analysisInclusion: enumValue(
      row.analysis_inclusion,
      analysisInclusions,
      'intake event analysis inclusion',
    ),
    notes: nullableString(row.notes, 'intake event notes'),
    sourceMediaPath: nullableString(row.source_media_path, 'intake source media path'),
    copiedFromEventId: nullableString(row.copied_from_event_id, 'intake copied event id'),
    createdAt: requiredString(row.created_at, 'intake event created timestamp'),
    updatedAt: requiredString(row.updated_at, 'intake event updated timestamp'),
  };
}

function decodeIntakeComponentRow(row: IntakeComponentRow): IntakeComponent {
  const original = intakeSnapshotFromUnknown(
    parseJson(row.original_amount_json, 'original intake component'),
  );
  const current = intakeSnapshotFromUnknown(
    parseJson(row.current_amount_json, 'current intake component'),
  );
  return {
    ...current,
    id: requiredString(row.id, 'intake component id'),
    eventId: requiredString(row.event_id, 'intake component event id'),
    original,
    provenance: enumValue(row.provenance, intakeProvenances, 'intake component provenance'),
    reviewState: enumValue(row.review_state, intakeReviewStates, 'intake component review state'),
    quantity: current.amount,
  };
}

function intakeSnapshotToJson(snapshot: IntakeComponentSnapshot): string {
  return JSON.stringify(snapshot);
}

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
  listIntakeEvents(): Promise<readonly IntakeEvent[]>;
  listIntakeEventsForDay(localDate: string): Promise<readonly IntakeEvent[]>;
  getIntakeEvent(id: string): Promise<IntakeEvent | null>;
  createIntakeEvent(input: CreateIntakeEventInput): Promise<IntakeEvent>;
  updateIntakeEvent(id: string, input: UpdateIntakeEventInput): Promise<IntakeEvent>;
  logAgainEvent(id: string, occurredAt?: string): Promise<IntakeEvent>;
  undoLogAgain(id: string): Promise<void>;
  setAnalysisInclusion(id: string, inclusion: AnalysisInclusion): Promise<IntakeEvent>;
  deleteIntakeEvent(
    id: string,
  ): Promise<{ readonly deleted: boolean; readonly sourceMediaPath: string | null }>;
  subscribeToIntakeChanges(listener: IntakeChangeListener): () => void;
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
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? idFor;
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  const intakeListeners = new Set<IntakeChangeListener>();

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

  function emitIntakeChange(change: IntakeChange): void {
    for (const listener of intakeListeners) {
      try {
        listener(change);
      } catch {
        // Change listeners refresh derived views. A stale view must never roll back a durable write.
      }
    }
  }

  async function intakeComponentsForEvent(eventId: string): Promise<readonly IntakeComponent[]> {
    const rows = await database.getAllAsync<IntakeComponentRow>(
      `SELECT id, event_id, canonical_id, original_name, original_amount_json,
        current_name, current_amount_json, provenance, review_state, created_at, updated_at
       FROM intake_components WHERE event_id = ? ORDER BY created_at ASC, id ASC;`,
      eventId,
    );
    return rows.map(decodeIntakeComponentRow);
  }

  async function readIntakeEvent(id: string): Promise<IntakeEvent | null> {
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events WHERE id = ?;`,
      id,
    );
    const row = rows[0];
    if (row === undefined) return null;
    const event = decodeIntakeEventRow(row);
    return { ...event, components: await intakeComponentsForEvent(id) };
  }

  function intakeOccurredAt(input: CreateIntakeEventInput, fallback?: string): string {
    const occurredAt = input.occurredAt ?? fallback ?? now();
    const parsed = new Date(occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Intake event occurred timestamp must be valid');
    }
    return parsed.toISOString();
  }

  function intakeLocalDate(
    input: CreateIntakeEventInput,
    occurredAt: string,
    fallback?: string,
  ): string {
    const localDate = input.localDate ?? fallback ?? formatIntakeLocalDate(new Date(occurredAt));
    assertIntakeLocalDate(localDate);
    return localDate;
  }

  function snapshotForIntakeComponent(
    input: CreateIntakeComponentInput,
    fallback?: IntakeComponentSnapshot,
  ): IntakeComponentSnapshot {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('Intake component name is required');
    const amount =
      input.amount === undefined && input.quantity === undefined && fallback !== undefined
        ? fallback.amount
        : amountForInput(input);
    const canonical =
      input.canonicalId === undefined
        ? (fallback?.canonicalId ?? null)
        : (input.canonicalId ?? null);
    return { name, amount, canonicalId: canonical };
  }

  function sameIntakeSnapshot(
    left: IntakeComponentSnapshot,
    right: IntakeComponentSnapshot,
  ): boolean {
    return (
      left.name === right.name &&
      JSON.stringify(left.amount) === JSON.stringify(right.amount) &&
      left.canonicalId === right.canonicalId
    );
  }

  async function persistIntakeEvent(
    input: CreateIntakeEventInput,
    changeKind: 'created' | 'logged-again' = 'created',
    logAgainUndoable = false,
  ): Promise<IntakeEvent> {
    if (input.components.length === 0) {
      throw new Error('An Intake Event needs at least one Intake Component');
    }
    const eventId = input.id ?? makeId('intake-event');
    const occurredAt = intakeOccurredAt(input);
    const localDate = intakeLocalDate(input, occurredAt);
    const createdAt = now();
    const origin = input.origin ?? 'manual';
    const provenance = input.provenance ?? 'user-entered';
    const reviewState = input.reviewState ?? 'confirmed';
    const analysisInclusion = input.analysisInclusion ?? 'included';
    const componentRows = input.components.map((component) => ({
      id: component.id ?? makeId('intake-component'),
      snapshot: snapshotForIntakeComponent(component),
      provenance: component.provenance ?? provenance,
      reviewState: component.reviewState ?? reviewState,
    }));
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO intake_events (
          id, event_type, occurred_at, local_date, origin, provenance, review_state,
          analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at,
          log_again_undoable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        eventId,
        input.eventType,
        occurredAt,
        localDate,
        origin,
        provenance,
        reviewState,
        analysisInclusion,
        input.notes ?? null,
        input.sourceMediaPath ?? null,
        input.copiedFromEventId ?? null,
        createdAt,
        createdAt,
        logAgainUndoable ? 1 : 0,
      );
      for (const component of componentRows) {
        await database.runAsync(
          `INSERT INTO intake_components (
            id, event_id, canonical_id, original_name, original_amount_json,
            current_name, current_amount_json, provenance, review_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          component.id,
          eventId,
          component.snapshot.canonicalId,
          component.snapshot.name,
          intakeSnapshotToJson(component.snapshot),
          component.snapshot.name,
          intakeSnapshotToJson(component.snapshot),
          component.provenance,
          component.reviewState,
          createdAt,
          createdAt,
        );
      }
    });
    const created = await readIntakeEvent(eventId);
    if (created === null) throw new Error('Created Intake Event could not be read back');
    emitIntakeChange({
      kind: changeKind,
      eventId,
      occurredAt: created.occurredAt,
      invalidatesInsights: false,
    });
    return created;
  }

  async function listIntakeEvents(): Promise<readonly IntakeEvent[]> {
    await initialize();
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events ORDER BY local_date DESC, occurred_at DESC, created_at DESC;`,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...decodeIntakeEventRow(row),
        components: await intakeComponentsForEvent(requiredString(row.id, 'intake event id')),
      })),
    );
  }

  async function listIntakeEventsForDay(localDate: string): Promise<readonly IntakeEvent[]> {
    await initialize();
    assertIntakeLocalDate(localDate);
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events WHERE local_date = ? ORDER BY occurred_at DESC, created_at DESC;`,
      localDate,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...decodeIntakeEventRow(row),
        components: await intakeComponentsForEvent(requiredString(row.id, 'intake event id')),
      })),
    );
  }

  async function getIntakeEvent(id: string): Promise<IntakeEvent | null> {
    await initialize();
    return readIntakeEvent(id);
  }

  async function createIntakeEvent(input: CreateIntakeEventInput): Promise<IntakeEvent> {
    await initialize();
    return persistIntakeEvent(input);
  }

  async function updateIntakeEvent(
    id: string,
    input: UpdateIntakeEventInput,
  ): Promise<IntakeEvent> {
    await initialize();
    let updatedEvent: IntakeEvent | null = null;
    let inclusionChanged = false;
    await withWrite(async () => {
      const existing = await readIntakeEvent(id);
      if (existing === null) throw new Error('Intake Event was not found');
      const occurredAt =
        input.occurredAt === undefined
          ? existing.occurredAt
          : intakeOccurredAt({
              eventType: existing.eventType,
              occurredAt: input.occurredAt,
              components: [],
            });
      if (Number.isNaN(new Date(occurredAt).getTime())) {
        throw new Error('Intake event occurred timestamp must be valid');
      }
      const localDate =
        input.localDate ??
        (input.occurredAt === undefined
          ? existing.localDate
          : formatIntakeLocalDate(new Date(occurredAt)));
      assertIntakeLocalDate(localDate);
      const nextComponents =
        input.components ??
        existing.components.map((component) => ({
          id: component.id,
          name: component.name,
          amount: component.amount,
          canonicalId: component.canonicalId,
          provenance: component.provenance,
          reviewState: component.reviewState,
        }));
      if (nextComponents.length === 0)
        throw new Error('An Intake Event needs at least one Intake Component');
      const existingById = new Map(
        existing.components.map((component) => [component.id, component]),
      );
      const usedIds = new Set<string>();
      let materiallyChanged =
        input.eventType !== undefined && input.eventType !== existing.eventType;
      materiallyChanged ||=
        input.occurredAt !== undefined && input.occurredAt !== existing.occurredAt;
      materiallyChanged ||= input.localDate !== undefined && input.localDate !== existing.localDate;
      materiallyChanged ||= input.origin !== undefined && input.origin !== existing.origin;
      materiallyChanged ||= input.notes !== undefined && input.notes !== existing.notes;
      const preparedComponents = nextComponents.map((componentInput, index) => {
        const existingComponent =
          (componentInput.id === undefined
            ? existing.components[index]
            : existingById.get(componentInput.id)) ?? undefined;
        const nextSnapshot = snapshotForIntakeComponent(componentInput, existingComponent);
        const changed =
          existingComponent === undefined || !sameIntakeSnapshot(nextSnapshot, existingComponent);
        materiallyChanged ||= changed;
        const componentId =
          existingComponent?.id ?? componentInput.id ?? makeId('intake-component');
        usedIds.add(componentId);
        return {
          id: componentId,
          original: existingComponent?.original ?? nextSnapshot,
          snapshot: nextSnapshot,
          provenance: changed
            ? ('user-corrected' as const)
            : (existingComponent?.provenance ?? 'user-entered'),
          reviewState: componentInput.reviewState ?? existingComponent?.reviewState ?? 'confirmed',
          eventId: id,
        };
      });
      const nextInclusion = input.analysisInclusion ?? existing.analysisInclusion;
      inclusionChanged = nextInclusion !== existing.analysisInclusion;
      const nextProvenance = materiallyChanged ? ('user-corrected' as const) : existing.provenance;
      const result = await database.runAsync(
        `UPDATE intake_events SET event_type = ?, occurred_at = ?, local_date = ?, origin = ?,
          provenance = ?, review_state = ?, analysis_inclusion = ?, notes = ?, source_media_path = ?,
          updated_at = ?, log_again_undoable = 0
         WHERE id = ?;`,
        input.eventType ?? existing.eventType,
        occurredAt,
        localDate,
        input.origin ?? existing.origin,
        nextProvenance,
        input.reviewState ?? existing.reviewState,
        nextInclusion,
        input.notes === undefined ? existing.notes : input.notes,
        input.sourceMediaPath === undefined ? existing.sourceMediaPath : input.sourceMediaPath,
        now(),
        id,
      );
      if (result.changes !== 1) throw new Error('Intake Event could not be updated');
      for (const component of preparedComponents) {
        const existingComponent = existingById.get(component.id);
        if (existingComponent === undefined) {
          await database.runAsync(
            `INSERT INTO intake_components (
              id, event_id, canonical_id, original_name, original_amount_json,
              current_name, current_amount_json, provenance, review_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            component.id,
            id,
            component.snapshot.canonicalId,
            component.original.name,
            intakeSnapshotToJson(component.original),
            component.snapshot.name,
            intakeSnapshotToJson(component.snapshot),
            component.provenance,
            component.reviewState,
            now(),
            now(),
          );
        } else {
          await database.runAsync(
            `UPDATE intake_components SET canonical_id = ?, current_name = ?, current_amount_json = ?,
              provenance = ?, review_state = ?, updated_at = ? WHERE id = ? AND event_id = ?;`,
            component.snapshot.canonicalId,
            component.snapshot.name,
            intakeSnapshotToJson(component.snapshot),
            component.provenance,
            component.reviewState,
            now(),
            component.id,
            id,
          );
        }
      }
      for (const existingComponent of existing.components) {
        if (!usedIds.has(existingComponent.id)) {
          await database.runAsync(
            'DELETE FROM intake_components WHERE id = ? AND event_id = ?;',
            existingComponent.id,
            id,
          );
        }
      }
    });
    updatedEvent = await readIntakeEvent(id);
    if (updatedEvent === null) throw new Error('Updated Intake Event could not be read back');
    const changeKind: IntakeChange['kind'] = inclusionChanged
      ? 'analysis-inclusion-changed'
      : 'updated';
    emitIntakeChange({
      kind: changeKind,
      eventId: id,
      occurredAt: updatedEvent.occurredAt,
      invalidatesInsights:
        changeKind === 'analysis-inclusion-changed' || updatedEvent.provenance === 'user-corrected',
    });
    return updatedEvent;
  }

  async function logAgainEvent(id: string, occurredAt?: string): Promise<IntakeEvent> {
    await initialize();
    const source = await readIntakeEvent(id);
    if (source === null) throw new Error('Intake Event was not found');
    const copyOccurredAt = intakeOccurredAt({
      eventType: source.eventType,
      occurredAt: occurredAt ?? now(),
      components: [],
    });
    return persistIntakeEvent(
      {
        eventType: source.eventType,
        occurredAt: copyOccurredAt,
        localDate: formatIntakeLocalDate(new Date(copyOccurredAt)),
        origin: 'manual',
        provenance: 'user-entered',
        reviewState: source.reviewState,
        analysisInclusion: source.analysisInclusion,
        notes: source.notes,
        components: source.components.map((component) => ({
          name: component.name,
          amount: component.amount,
          canonicalId: component.canonicalId,
          provenance: component.provenance,
          reviewState: component.reviewState,
        })),
        copiedFromEventId: source.id,
      },
      'logged-again',
      true,
    );
  }

  async function undoLogAgain(id: string): Promise<void> {
    await initialize();
    let deleted = false;
    await withWrite(async () => {
      const undoableRows = await database.getAllAsync<{ log_again_undoable: number }>(
        'SELECT log_again_undoable FROM intake_events WHERE id = ? AND copied_from_event_id IS NOT NULL;',
        id,
      );
      const event = await readIntakeEvent(id);
      if (event === null) return;
      if (event.copiedFromEventId === null || undoableRows[0]?.log_again_undoable !== 1) {
        throw new Error('Only an unedited Log Again copy can be undone');
      }
      const result = await database.runAsync(
        'DELETE FROM intake_events WHERE id = ? AND copied_from_event_id IS NOT NULL;',
        id,
      );
      deleted = result.changes === 1;
    });
    if (deleted) {
      emitIntakeChange({
        kind: 'deleted',
        eventId: id,
        occurredAt: null,
        invalidatesInsights: true,
      });
    }
  }

  async function setAnalysisInclusion(
    id: string,
    inclusion: AnalysisInclusion,
  ): Promise<IntakeEvent> {
    return updateIntakeEvent(id, { analysisInclusion: inclusion });
  }

  async function deleteIntakeEvent(
    id: string,
  ): Promise<{ readonly deleted: boolean; readonly sourceMediaPath: string | null }> {
    await initialize();
    let sourceMediaPath: string | null = null;
    let deleted = false;
    await withWrite(async () => {
      const existing = await readIntakeEvent(id);
      if (existing === null) return;
      sourceMediaPath = existing.sourceMediaPath;
      await database.runAsync('DELETE FROM intake_components WHERE event_id = ?;', id);
      const result = await database.runAsync('DELETE FROM intake_events WHERE id = ?;', id);
      deleted = result.changes === 1;
      if (
        (
          await database.getAllAsync<{ id: string }>(
            'SELECT id FROM intake_components WHERE event_id = ?;',
            id,
          )
        ).length > 0
      ) {
        throw new Error('Intake Event deletion left orphaned components');
      }
    });
    if (deleted)
      emitIntakeChange({
        kind: 'deleted',
        eventId: id,
        occurredAt: null,
        invalidatesInsights: true,
      });
    return { deleted, sourceMediaPath };
  }

  function subscribeToIntakeChanges(listener: IntakeChangeListener): () => void {
    intakeListeners.add(listener);
    return () => intakeListeners.delete(listener);
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
    close: () => database.closeAsync(),
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    correctMeasurement,
    deleteRecord,
    listIntakeEvents,
    listIntakeEventsForDay,
    getIntakeEvent,
    createIntakeEvent,
    updateIntakeEvent,
    logAgainEvent,
    undoLogAgain,
    setAnalysisInclusion,
    deleteIntakeEvent,
    subscribeToIntakeChanges,
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
