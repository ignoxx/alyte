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
  type ExtractionDraft,
  type ExtractionDraftRow,
  type ExtractionDraftRowPatch,
  type ExtractionDateContext,
  type SanitizationRecipe,
  createSanitizationRecipe,
} from '@alyte/domain';
import {
  buildExtractionConfirmationPlan,
  decodeVisionOCRResult,
  EXTRACTION_PARSER_VERSION,
  extractionReviewBlocksConfirmation,
  VISION_OCR_CONTRACT_VERSION,
  proposeBiomarkerId,
  revalidateExtractionRow,
} from '@alyte/domain';
import type { ExtractionAliasEntry } from '@alyte/domain';
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
  panel_label: unknown;
  original_state_json: unknown;
  source_page_index: unknown;
  source_bbox_json: unknown;
  source_orientation: unknown;
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

type ExtractionDraftRowDb = {
  id: unknown;
  draft_id: unknown;
  row_order: unknown;
  panel_label: unknown;
  source_text: unknown;
  source_label: unknown;
  source_value_json: unknown;
  source_value_string: unknown;
  source_unit: unknown;
  source_reference_interval: unknown;
  source_flag: unknown;
  source_page_index: unknown;
  source_bbox_json: unknown;
  source_orientation: unknown;
  date_context_json: unknown;
  proposed_label: unknown;
  proposed_value_json: unknown;
  proposed_unit: unknown;
  proposed_reference_interval: unknown;
  proposed_flag: unknown;
  proposed_biomarker_id: unknown;
  proposed_specimen_type: unknown;
  collection_date: unknown;
  date_state: unknown;
  review_reasons_json: unknown;
  review_state: unknown;
  decision: unknown;
};

type ExtractionDraftDb = {
  id: unknown;
  report_id: unknown;
  state: unknown;
  ocr_contract_version: unknown;
  parser_version: unknown;
  collection_date: unknown;
  date_state: unknown;
  created_at: unknown;
  updated_at: unknown;
  confirmed_at: unknown;
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

function sourceLocationFromUnknown(row: {
  source_page_index: unknown;
  source_bbox_json: unknown;
  source_orientation: unknown;
}): Measurement['source'] {
  if (row.source_page_index === null || row.source_page_index === undefined) return null;
  if (
    typeof row.source_page_index !== 'number' ||
    !Number.isInteger(row.source_page_index) ||
    row.source_page_index < 0
  )
    throw new Error('Invalid measurement source page in local database');
  const boxValue = parseJson(row.source_bbox_json, 'measurement source bounding box');
  if (typeof boxValue !== 'object' || boxValue === null)
    throw new Error('Invalid measurement source bounding box in local database');
  const box = boxValue as Record<string, unknown>;
  const boundingBox = {
    x: Number(box.x),
    y: Number(box.y),
    width: Number(box.width),
    height: Number(box.height),
  };
  if (
    Object.values(boundingBox).some((value) => !Number.isFinite(value)) ||
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width <= 0 ||
    boundingBox.height <= 0 ||
    boundingBox.x + boundingBox.width > 1.000001 ||
    boundingBox.y + boundingBox.height > 1.000001
  )
    throw new Error('Invalid measurement source bounding box in local database');
  if (typeof row.source_orientation !== 'number' || !Number.isInteger(row.source_orientation))
    throw new Error('Invalid measurement source orientation in local database');
  const observationIds =
    typeof box.observationIds === 'object' && Array.isArray(box.observationIds)
      ? box.observationIds.filter((value): value is string => typeof value === 'string')
      : [];
  const observations = decodeStoredObservations(
    box.observations,
    row.source_page_index,
    row.source_orientation,
  );
  return {
    pageIndex: row.source_page_index,
    boundingBox,
    orientation: row.source_orientation,
    observationIds,
    observations,
    semantic: decodeStoredSemantic(box.semantic),
  };
}

function decodeStoredObservations(value: unknown, pageIndex: number, orientation: number) {
  if (value === undefined) return [];
  return decodeVisionOCRResult({
    contractVersion: VISION_OCR_CONTRACT_VERSION,
    pageIndex,
    orientation,
    observations: value,
  }).observations;
}

function decodeStoredSemantic(
  value: unknown,
): NonNullable<ExtractionDraftRow['source']['semantic']> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error('Invalid extraction semantic provenance');
  const item = value as Record<string, unknown>;
  if (
    typeof item.adapterVersion !== 'string' ||
    item.schemaVersion !== 'alyte.semantic-mapper.v1' ||
    !Array.isArray(item.sourceObservationIds) ||
    item.sourceObservationIds.some((id) => typeof id !== 'string')
  )
    throw new Error('Invalid extraction semantic provenance');
  return {
    adapterVersion: item.adapterVersion,
    schemaVersion: item.schemaVersion,
    sourceObservationIds: item.sourceObservationIds as string[],
    ...(typeof item.modelVersion === 'string' ? { modelVersion: item.modelVersion } : {}),
    ...(typeof item.runtimeVersion === 'string' ? { runtimeVersion: item.runtimeVersion } : {}),
    ...(typeof item.promptVersion === 'string' ? { promptVersion: item.promptVersion } : {}),
    ...(typeof item.parserVersion === 'string' ? { parserVersion: item.parserVersion } : {}),
    ...(typeof item.catalogueVersion === 'string'
      ? { catalogueVersion: item.catalogueVersion }
      : {}),
  };
}

function sourceLocationValue(value: unknown): Measurement['source'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new Error('Invalid measurement source in local database');
  const candidate = value as Record<string, unknown>;
  return sourceLocationFromUnknown({
    source_page_index: candidate.pageIndex,
    source_bbox_json: JSON.stringify({
      ...(typeof candidate.boundingBox === 'object' && candidate.boundingBox !== null
        ? candidate.boundingBox
        : {}),
      observationIds: candidate.observationIds,
      observations: candidate.observations,
      semantic: candidate.semantic,
    }),
    source_orientation: candidate.orientation,
  });
}

function parseJson(value: unknown, field: string): unknown {
  const json = requiredString(value, field);
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON in local database`, { cause: error });
  }
}

function draftDate(value: unknown, state: unknown): LabRecord['collectionDate'] {
  const dateState = enumValue(state, ['known', 'missing'] as const, 'extraction date state');
  const date = nullableString(value, 'extraction collection date');
  if (dateState === 'missing') {
    if (date !== null) throw new Error('Missing extraction date unexpectedly has a value');
    return { kind: 'missing' };
  }
  if (date === null) throw new Error('Known extraction date is missing its value');
  assertLabDateState({ kind: 'known', value: date });
  return { kind: 'known', value: date };
}

function extractionRowFromDb(row: ExtractionDraftRowDb): ExtractionDraftRow {
  const box = parseJson(row.source_bbox_json, 'extraction source bounding box');
  if (typeof box !== 'object' || box === null)
    throw new Error('Invalid extraction source bounding box');
  const sourceBox = box as Record<string, unknown>;
  const boundingBox = {
    x: Number(sourceBox.x),
    y: Number(sourceBox.y),
    width: Number(sourceBox.width),
    height: Number(sourceBox.height),
  };
  if (
    Object.values(boundingBox).some((value) => !Number.isFinite(value)) ||
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width <= 0 ||
    boundingBox.height <= 0 ||
    boundingBox.x + boundingBox.width > 1.000001 ||
    boundingBox.y + boundingBox.height > 1.000001
  )
    throw new Error('Invalid extraction source bounding box');
  const value = storedValue(parseJson(row.proposed_value_json, 'extraction proposed value'));
  const sourceValue =
    row.source_value_json === null || row.source_value_json === undefined
      ? value
      : storedValue(parseJson(row.source_value_json, 'extraction source value'));
  const reasons = parseJson(row.review_reasons_json, 'extraction review reasons');
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== 'string'))
    throw new Error('Invalid extraction review reasons');
  const pageIndex = row.source_page_index;
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0)
    throw new Error('Invalid extraction source page');
  const orientation = row.source_orientation;
  if (typeof orientation !== 'number' || !Number.isInteger(orientation))
    throw new Error('Invalid extraction source orientation');
  const dateContext =
    row.date_context_json === null || row.date_context_json === undefined
      ? null
      : (parseJson(row.date_context_json, 'extraction date context') as ExtractionDateContext);
  const observationIds =
    typeof sourceBox.observationIds === 'object' && Array.isArray(sourceBox.observationIds)
      ? sourceBox.observationIds.filter(
          (candidate): candidate is string => typeof candidate === 'string',
        )
      : [];
  const observations = decodeStoredObservations(sourceBox.observations, pageIndex, orientation);
  return {
    id: requiredString(row.id, 'extraction row id'),
    order: typeof row.row_order === 'number' ? row.row_order : Number(row.row_order),
    panelLabel: nullableString(row.panel_label, 'extraction panel label'),
    sourceText: requiredString(row.source_text, 'extraction source text'),
    sourceLabel: requiredString(row.source_label, 'extraction source label'),
    sourceValue,
    sourceValueString: requiredString(row.source_value_string, 'extraction source value'),
    sourceUnit: nullableString(row.source_unit, 'extraction source unit'),
    sourceReferenceInterval: nullableString(
      row.source_reference_interval,
      'extraction source reference interval',
    ),
    sourceFlag: nullableString(row.source_flag, 'extraction source flag'),
    source: {
      pageIndex,
      boundingBox,
      orientation,
      observationIds,
      observations,
      semantic: decodeStoredSemantic(sourceBox.semantic),
    },
    collectionDateContext: dateContext,
    proposedLabel: requiredString(row.proposed_label, 'extraction proposed label'),
    proposedValue: value,
    proposedUnit: nullableString(row.proposed_unit, 'extraction proposed unit'),
    proposedReferenceInterval: nullableString(
      row.proposed_reference_interval,
      'extraction proposed reference interval',
    ),
    proposedFlag: nullableString(row.proposed_flag, 'extraction proposed flag'),
    proposedBiomarkerId:
      row.proposed_biomarker_id === null || row.proposed_biomarker_id === undefined
        ? null
        : canonicalId(
            requiredString(row.proposed_biomarker_id, 'extraction proposed biomarker id'),
          ),
    proposedSpecimenType: enumValue(
      row.proposed_specimen_type,
      specimenTypes,
      'extraction proposed specimen type',
    ),
    collectionDate: draftDate(row.collection_date, row.date_state),
    reviewReasons: reasons as ExtractionDraftRow['reviewReasons'],
    reviewState: enumValue(
      row.review_state,
      ['ready', 'needs-review'] as const,
      'extraction review state',
    ),
    decision: enumValue(
      row.decision ?? 'unresolved',
      ['unresolved', 'preserve', 'skip', 'resolve'] as const,
      'extraction row decision',
    ),
  };
}

function extractionDraftFromDb(
  row: ExtractionDraftDb,
  rows: readonly ExtractionDraftRow[],
): ExtractionDraft {
  const state = enumValue(
    row.state,
    ['draft', 'confirmed', 'failed'] as const,
    'extraction draft state',
  );
  const ocr = requiredString(row.ocr_contract_version, 'OCR contract version');
  const parser = requiredString(row.parser_version, 'extraction parser version');
  if (ocr !== VISION_OCR_CONTRACT_VERSION || parser !== EXTRACTION_PARSER_VERSION)
    throw new Error('Unsupported extraction draft version');
  return {
    id: requiredString(row.id, 'extraction draft id'),
    reportId: requiredString(row.report_id, 'extraction report id'),
    state,
    ocrContractVersion: VISION_OCR_CONTRACT_VERSION,
    parserVersion: EXTRACTION_PARSER_VERSION,
    collectionDate: draftDate(row.collection_date, row.date_state),
    rows,
    createdAt: requiredString(row.created_at, 'extraction draft created timestamp'),
    updatedAt: requiredString(row.updated_at, 'extraction draft updated timestamp'),
    confirmedAt: nullableString(row.confirmed_at, 'extraction draft confirmed timestamp'),
  };
}

function extractionDraftVersions(row: ExtractionDraftDb): {
  readonly ocr: string;
  readonly parser: string;
} {
  return {
    ocr: requiredString(row.ocr_contract_version, 'OCR contract version'),
    parser: requiredString(row.parser_version, 'extraction parser version'),
  };
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
  const source = sourceLocationFromUnknown(row);
  const provenance = enumValue(row.provenance, provenances, 'measurement provenance');
  const reviewState = enumValue(row.review_state, reviewStates, 'measurement review state');
  const biomarkerId =
    row.biomarker_id === null || row.biomarker_id === undefined
      ? null
      : canonicalId(requiredString(row.biomarker_id, 'biomarker id'));
  const specimenType = enumValue(row.specimen_type, specimenTypes, 'measurement specimen type');
  const originalState =
    row.original_state_json === null || row.original_state_json === undefined
      ? { biomarkerId, specimenType, snapshot: original, reviewState, provenance, source }
      : correctionStateFromUnknown(
          parseJson(row.original_state_json, 'original measurement state'),
          {
            biomarkerId,
            specimenType,
            reviewState,
            provenance,
            source,
          },
        );
  return {
    id: requiredString(row.id, 'measurement id'),
    labRecordId: requiredString(row.lab_record_id, 'measurement lab record id'),
    biomarkerId,
    specimenType,
    panelLabel: nullableString(row.panel_label, 'measurement panel label'),
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
    originalState,
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
    provenance,
    reviewState,
    source,
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
    source: measurement.source,
  });
  const next = correctionStateFromUnknown(parseJson(row.next_json, 'next correction'), {
    biomarkerId: measurement.biomarkerId,
    specimenType: measurement.specimenType,
    reviewState: measurement.reviewState,
    provenance: 'user-corrected',
    source: measurement.source,
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
    source:
      candidate.source === undefined ? fallback.source : sourceLocationValue(candidate.source),
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
  findMeasurementRecordId(id: string): Promise<string | null>;
  deleteMeasurement(id: string): Promise<void>;
  deleteRecord(id: string): Promise<void>;
  requestCombinedDeletion(recordId: string, reportId: string): Promise<void>;
  markCombinedDeletionSourceComplete(recordId: string, reportId: string): Promise<void>;
  finalizeCombinedDeletion(recordId: string, reportId: string): Promise<void>;
  listPendingCombinedDeletions(): Promise<
    readonly {
      recordId: string;
      reportId: string;
      state: 'requested' | 'source-complete';
    }[]
  >;
  createExtractionDraft(input: {
    readonly id?: string;
    readonly reportId: string;
    readonly collectionDate: LabRecord['collectionDate'];
    readonly rows: readonly ExtractionDraftRow[];
    readonly now?: string;
  }): Promise<ExtractionDraft>;
  countOpenExtractionDrafts(): Promise<number>;
  getExtractionDraft(
    id: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraft | null>;
  getExtractionDraftForReport(
    reportId: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraft | null>;
  updateExtractionDraftRow(
    id: string,
    patch: ExtractionDraftRowPatch,
    aliases: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraftRow>;
  confirmExtractionDraft(
    id: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<readonly LabRecord[]>;
  getSanitizationDraft(reportId: string): Promise<SanitizationRecipe | null>;
  saveSanitizationDraft(reportId: string, recipe: SanitizationRecipe): Promise<void>;
  clearSanitizationDraft(reportId: string): Promise<void>;
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
        panel_label, original_state_json, source_page_index, source_bbox_json, source_orientation,
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
          originalState:
            row.original_state_json === null || row.original_state_json === undefined
              ? correctionRows[0] === undefined
                ? measurement.originalState
                : decodeCorrectionRow(correctionRows[0], measurement).previous
              : measurement.originalState,
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
        const original = measurementInput.original ?? snapshot;
        assertMeasurementValue(original.value);
        if (original.label.trim().length === 0 || original.valueString.trim().length === 0) {
          throw new Error('Original Measurement provenance is incomplete');
        }
        const provenance = measurementInput.provenance ?? 'user-entered';
        const reviewState = measurementInput.reviewState ?? 'confirmed';
        await database.runAsync(
          `INSERT INTO measurements (
            id, lab_record_id, biomarker_id, specimen_type, original_label, original_value_string,
            original_value_json, original_unit, original_reference_interval, original_flag,
            current_label, current_value_string, current_value_json, current_unit,
            current_reference_interval, current_flag, panel_label, original_state_json, source_page_index, source_bbox_json,
            source_orientation, provenance, review_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          measurementId,
          recordId,
          measurementInput.biomarkerId ?? null,
          measurementInput.specimenType ?? input.specimenType ?? 'unknown',
          original.label,
          original.valueString,
          snapshotToJson(original),
          original.unit,
          original.referenceInterval,
          original.flag,
          snapshot.label,
          snapshot.valueString,
          snapshotToJson(snapshot),
          snapshot.unit,
          snapshot.referenceInterval,
          snapshot.flag,
          measurementInput.panelLabel ?? null,
          JSON.stringify({
            biomarkerId: measurementInput.biomarkerId ?? null,
            specimenType: measurementInput.specimenType ?? input.specimenType ?? 'unknown',
            snapshot: original,
            reviewState,
            provenance,
            source: measurementInput.source ?? null,
          }),
          measurementInput.source?.pageIndex ?? null,
          measurementInput.source === undefined || measurementInput.source === null
            ? null
            : JSON.stringify({
                ...measurementInput.source.boundingBox,
                observationIds: measurementInput.source.observationIds ?? [],
                observations: measurementInput.source.observations ?? [],
                semantic: measurementInput.source.semantic ?? null,
              }),
          measurementInput.source?.orientation ?? null,
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
          panel_label, original_state_json, source_page_index, source_bbox_json, source_orientation,
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
        source: existing.source,
      };
      const nextState: MeasurementCorrectionState = {
        biomarkerId: nextBiomarkerId ?? null,
        specimenType: nextSpecimenType,
        snapshot: next,
        reviewState: nextReviewState,
        provenance: nextProvenance,
        source: input.source === undefined ? existing.source : input.source,
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
          source_page_index = ?, source_bbox_json = ?, source_orientation = ?, updated_at = ? WHERE id = ?;`,
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
        input.source === undefined
          ? (existing.source?.pageIndex ?? null)
          : (input.source?.pageIndex ?? null),
        input.source === undefined
          ? existing.source === null
            ? null
            : JSON.stringify({
                ...existing.source.boundingBox,
                observationIds: existing.source.observationIds ?? [],
                observations: existing.source.observations ?? [],
                semantic: existing.source.semantic ?? null,
              })
          : input.source === null
            ? null
            : JSON.stringify({
                ...input.source.boundingBox,
                observationIds: input.source.observationIds ?? [],
                observations: input.source.observations ?? [],
                semantic: input.source.semantic ?? null,
              }),
        input.source === undefined
          ? (existing.source?.orientation ?? null)
          : (input.source?.orientation ?? null),
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

  async function deleteMeasurement(id: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      const result = await database.runAsync('DELETE FROM measurements WHERE id = ?;', id);
      if (result.changes > 1) throw new Error('Measurement deletion affected multiple rows');
      const corrections = await database.getAllAsync<{ id: string }>(
        'SELECT id FROM measurement_corrections WHERE measurement_id = ?;',
        id,
      );
      if (corrections.length > 0) throw new Error('Measurement deletion left correction history');
    });
  }

  async function findMeasurementRecordId(id: string): Promise<string | null> {
    await initialize();
    const rows = await database.getAllAsync<{ lab_record_id: unknown }>(
      'SELECT lab_record_id FROM measurements WHERE id = ?;',
      id,
    );
    return rows[0] === undefined
      ? null
      : requiredString(rows[0].lab_record_id, 'Measurement Lab Record id');
  }

  async function assertRecordReportLink(recordId: string, reportId: string): Promise<void> {
    const rows = await database.getAllAsync<{ lab_report_id: unknown }>(
      'SELECT lab_report_id FROM lab_records WHERE id = ?;',
      recordId,
    );
    if (rows[0]?.lab_report_id !== reportId)
      throw new Error('Lab Record source association changed during deletion');
  }

  async function requestCombinedDeletion(recordId: string, reportId: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await assertRecordReportLink(recordId, reportId);
      const timestamp = now();
      await database.runAsync(
        `INSERT INTO lab_combined_deletions (id, record_id, report_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'requested', ?, ?)
         ON CONFLICT(record_id, report_id) DO UPDATE SET updated_at = excluded.updated_at;`,
        makeId('lab-combined-deletion'),
        recordId,
        reportId,
        timestamp,
        timestamp,
      );
    });
  }

  async function markCombinedDeletionSourceComplete(
    recordId: string,
    reportId: string,
  ): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await assertRecordReportLink(recordId, reportId);
      const result = await database.runAsync(
        `UPDATE lab_combined_deletions SET state = 'source-complete', updated_at = ?
         WHERE record_id = ? AND report_id = ? AND state IN ('requested', 'source-complete');`,
        now(),
        recordId,
        reportId,
      );
      if (result.changes !== 1) throw new Error('Combined deletion intent was not found');
    });
  }

  async function finalizeCombinedDeletion(recordId: string, reportId: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await assertRecordReportLink(recordId, reportId);
      const operations = await database.getAllAsync<{ id: unknown }>(
        `SELECT id FROM lab_combined_deletions
         WHERE record_id = ? AND report_id = ? AND state = 'source-complete';`,
        recordId,
        reportId,
      );
      if (operations.length !== 1) throw new Error('Combined deletion is not ready to finalize');
      const result = await database.runAsync('DELETE FROM lab_records WHERE id = ?;', recordId);
      if (result.changes !== 1) throw new Error('Combined Lab Record deletion did not complete');
      const dangling = await database.getAllAsync<{ id: unknown }>(
        'SELECT id FROM lab_combined_deletions WHERE record_id = ?;',
        recordId,
      );
      if (dangling.length > 0) throw new Error('Combined deletion intent did not cascade');
    });
  }

  async function listPendingCombinedDeletions() {
    await initialize();
    const rows = await database.getAllAsync<{
      record_id: unknown;
      report_id: unknown;
      state: unknown;
    }>(
      `SELECT record_id, report_id, state FROM lab_combined_deletions
       WHERE state IN ('requested', 'source-complete') ORDER BY created_at ASC;`,
    );
    return rows.map((row) => ({
      recordId: requiredString(row.record_id, 'combined deletion record id'),
      reportId: requiredString(row.report_id, 'combined deletion report id'),
      state: enumValue(
        row.state,
        ['requested', 'source-complete'] as const,
        'combined deletion state',
      ),
    }));
  }

  const extractionDraftColumns = `id, report_id, state, ocr_contract_version, parser_version,
    collection_date, date_state, created_at, updated_at, confirmed_at`;
  const extractionRowColumns = `id, draft_id, row_order, panel_label, source_text, source_label,
    source_value_string, source_value_json, source_unit, source_reference_interval, source_flag, source_page_index,
    source_bbox_json, source_orientation, proposed_label, proposed_value_json, proposed_unit,
    proposed_reference_interval, proposed_flag, proposed_biomarker_id, proposed_specimen_type,
    collection_date, date_state, date_context_json, review_reasons_json, review_state, decision`;

  async function extractionRowsFor(draftId: string): Promise<readonly ExtractionDraftRow[]> {
    const rows = await database.getAllAsync<ExtractionDraftRowDb>(
      `SELECT ${extractionRowColumns} FROM extraction_draft_rows WHERE draft_id = ? ORDER BY row_order ASC;`,
      draftId,
    );
    return rows.map(extractionRowFromDb);
  }

  async function readExtractionDraft(
    row: ExtractionDraftDb,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraft> {
    const rows = await extractionRowsFor(requiredString(row.id, 'extraction draft id'));
    const versions = extractionDraftVersions(row);
    const state = enumValue(
      row.state,
      ['draft', 'confirmed', 'failed'] as const,
      'extraction draft state',
    );
    if (
      state === 'draft' &&
      versions.ocr === VISION_OCR_CONTRACT_VERSION &&
      versions.parser !== EXTRACTION_PARSER_VERSION &&
      aliases !== undefined
    ) {
      await withWrite(async () => {
        for (const current of rows) {
          const next = revalidateExtractionRow(current, {}, aliases);
          await database.runAsync(
            `UPDATE extraction_draft_rows SET proposed_biomarker_id = ?, review_reasons_json = ?,
              review_state = ?, decision = ? WHERE id = ?;`,
            next.proposedBiomarkerId,
            JSON.stringify(next.reviewReasons),
            next.reviewState,
            next.decision,
            next.id,
          );
        }
        await database.runAsync(
          'UPDATE extraction_drafts SET parser_version = ?, updated_at = ? WHERE id = ?;',
          EXTRACTION_PARSER_VERSION,
          now(),
          row.id,
        );
      });
      const refreshed = await database.getAllAsync<ExtractionDraftDb>(
        `SELECT ${extractionDraftColumns} FROM extraction_drafts WHERE id = ?;`,
        row.id,
      );
      const refreshedRow = refreshed[0];
      if (refreshedRow === undefined)
        throw new Error('Extraction Draft was removed during migration');
      return extractionDraftFromDb(
        refreshedRow,
        await extractionRowsFor(requiredString(refreshedRow.id, 'extraction draft id')),
      );
    }
    return extractionDraftFromDb(row, rows);
  }

  async function getExtractionDraft(
    id: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraft | null> {
    await initialize();
    const rows = await database.getAllAsync<ExtractionDraftDb>(
      `SELECT ${extractionDraftColumns} FROM extraction_drafts WHERE id = ?;`,
      id,
    );
    const row = rows[0];
    return row === undefined ? null : readExtractionDraft(row, aliases);
  }

  async function countOpenExtractionDrafts(): Promise<number> {
    await initialize();
    const rows = await database.getAllAsync<{ count: unknown }>(
      `SELECT COUNT(*) AS count
       FROM extraction_drafts AS draft
       INNER JOIN lab_reports AS report ON report.id = draft.report_id
       WHERE draft.state = 'draft' AND report.import_state <> 'deleted';`,
    );
    const count = rows[0]?.count;
    if (typeof count !== 'number')
      throw new Error('Invalid Extraction Draft count in local database');
    return count;
  }

  async function getExtractionDraftForReport(
    reportId: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraft | null> {
    await initialize();
    const rows = await database.getAllAsync<ExtractionDraftDb>(
      `SELECT ${extractionDraftColumns} FROM extraction_drafts WHERE report_id = ?;`,
      reportId,
    );
    const row = rows[0];
    return row === undefined ? null : readExtractionDraft(row, aliases);
  }

  async function createExtractionDraft(input: {
    readonly id?: string;
    readonly reportId: string;
    readonly collectionDate: LabRecord['collectionDate'];
    readonly rows: readonly ExtractionDraftRow[];
    readonly now?: string;
  }): Promise<ExtractionDraft> {
    await initialize();
    assertLabDateState(input.collectionDate);
    if (input.rows.length === 0)
      throw new Error('Extraction Draft must preserve at least one source row');
    const draftId = input.id ?? makeId('extraction-draft');
    const createdAt = input.now ?? now();
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO extraction_drafts (id, report_id, state, ocr_contract_version, parser_version,
          collection_date, date_state, created_at, updated_at, confirmed_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, NULL);`,
        draftId,
        input.reportId,
        VISION_OCR_CONTRACT_VERSION,
        EXTRACTION_PARSER_VERSION,
        input.collectionDate.kind === 'known' ? input.collectionDate.value : null,
        input.collectionDate.kind,
        createdAt,
        createdAt,
      );
      for (const row of input.rows) {
        await database.runAsync(
          `INSERT INTO extraction_draft_rows (
            id, draft_id, row_order, panel_label, source_text, source_label, source_value_string,
            source_value_json, source_unit, source_reference_interval, source_flag, source_page_index, source_bbox_json,
            source_orientation, proposed_label, proposed_value_json, proposed_unit,
            proposed_reference_interval, proposed_flag, proposed_biomarker_id, proposed_specimen_type,
            collection_date, date_state, date_context_json, review_reasons_json, review_state, decision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          row.id,
          draftId,
          row.order,
          row.panelLabel,
          row.sourceText,
          row.sourceLabel,
          row.sourceValueString,
          JSON.stringify(row.sourceValue),
          row.sourceUnit,
          row.sourceReferenceInterval,
          row.sourceFlag,
          row.source.pageIndex,
          JSON.stringify({
            ...row.source.boundingBox,
            observationIds: row.source.observationIds,
            observations: row.source.observations ?? [],
            semantic: row.source.semantic ?? null,
          }),
          row.source.orientation,
          row.proposedLabel,
          JSON.stringify(row.proposedValue),
          row.proposedUnit,
          row.proposedReferenceInterval,
          row.proposedFlag,
          row.proposedBiomarkerId,
          row.proposedSpecimenType,
          row.collectionDate.kind === 'known' ? row.collectionDate.value : null,
          row.collectionDate.kind,
          row.collectionDateContext === null ? null : JSON.stringify(row.collectionDateContext),
          JSON.stringify(row.reviewReasons),
          row.reviewState,
          row.decision,
        );
      }
    });
    const created = await getExtractionDraft(draftId);
    if (created === null) throw new Error('Extraction Draft could not be read back');
    return created;
  }

  async function updateExtractionDraftRow(
    id: string,
    patch: ExtractionDraftRowPatch,
    aliases: readonly ExtractionAliasEntry[],
  ): Promise<ExtractionDraftRow> {
    await initialize();
    let updated: ExtractionDraftRow | null = null;
    await withWrite(async () => {
      const rows = await database.getAllAsync<ExtractionDraftRowDb>(
        `SELECT ${extractionRowColumns} FROM extraction_draft_rows WHERE id = ?;`,
        id,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('Extraction Draft row was not found');
      const draftRows = await database.getAllAsync<{ state: unknown }>(
        'SELECT state FROM extraction_drafts WHERE id = ?;',
        row.draft_id,
      );
      if (draftRows[0]?.state !== 'draft') throw new Error('Only a draft can be edited');
      const current = extractionRowFromDb(row);
      const resolvedPatch =
        patch.proposedLabel !== undefined && patch.proposedBiomarkerId === undefined
          ? { ...patch, proposedBiomarkerId: proposeBiomarkerId(patch.proposedLabel, aliases) }
          : patch;
      updated = revalidateExtractionRow(current, resolvedPatch, aliases);
      const next = updated;
      await database.runAsync(
        `UPDATE extraction_draft_rows SET proposed_label = ?, proposed_value_json = ?,
          proposed_unit = ?, proposed_reference_interval = ?, proposed_flag = ?, proposed_biomarker_id = ?,
          proposed_specimen_type = ?, collection_date = ?, date_state = ?, review_reasons_json = ?,
          review_state = ?, decision = ? WHERE id = ?;`,
        next.proposedLabel,
        JSON.stringify(next.proposedValue),
        next.proposedUnit,
        next.proposedReferenceInterval,
        next.proposedFlag,
        next.proposedBiomarkerId,
        next.proposedSpecimenType,
        next.collectionDate.kind === 'known' ? next.collectionDate.value : null,
        next.collectionDate.kind,
        JSON.stringify(next.reviewReasons),
        next.reviewState,
        next.decision,
        id,
      );
      await database.runAsync(
        'UPDATE extraction_drafts SET updated_at = ? WHERE id = ?;',
        now(),
        row.draft_id,
      );
    });
    if (updated === null) throw new Error('Extraction Draft row could not be updated');
    return updated;
  }

  async function confirmExtractionDraft(
    id: string,
    aliases?: readonly ExtractionAliasEntry[],
  ): Promise<readonly LabRecord[]> {
    await initialize();
    // Revalidate before opening the confirmation transaction. The migration is
    // itself transactional, so doing this preflight avoids nesting a write
    // transaction when an older open draft is confirmed directly after launch.
    if (aliases !== undefined) await getExtractionDraft(id, aliases);
    let recordIds: string[] = [];
    await withWrite(async () => {
      const draft = await getExtractionDraft(id, aliases);
      if (draft === null) throw new Error('Extraction Draft was not found');
      if (draft.state === 'confirmed') {
        const existing = await database.getAllAsync<{ id: string }>(
          'SELECT id FROM lab_records WHERE lab_report_id = ? ORDER BY created_at ASC;',
          draft.reportId,
        );
        recordIds = existing.map((record) => record.id);
        return;
      }
      if (draft.state !== 'draft') throw new Error('Extraction Draft cannot be confirmed');
      const unresolved = draft.rows.filter(extractionReviewBlocksConfirmation);
      if (unresolved.length > 0)
        throw new Error('Extraction rows still have unresolved required fields');
      const invalidResolved = draft.rows.filter(
        (row) => row.decision === 'resolve' && row.reviewState !== 'ready',
      );
      if (invalidResolved.length > 0)
        throw new Error('Resolved extraction rows still require review');
      const plan = buildExtractionConfirmationPlan(draft, {
        record: (key) => makeId(`lab-record-${key.replace(/[^a-z0-9]+/gi, '-')}`),
        measurement: (rowId) => makeId(`measurement-${rowId}`),
      });
      if (plan.records.length === 0)
        throw new Error('At least one extraction row must be included');
      const createdAt = now();
      for (const planned of plan.records) {
        await database.runAsync(
          `INSERT INTO lab_records (id, lab_report_id, collection_date, date_state, specimen_type, laboratory_name, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?);`,
          planned.id,
          draft.reportId,
          planned.collectionDate.kind === 'known' ? planned.collectionDate.value : null,
          planned.collectionDate.kind,
          planned.specimenType,
          createdAt,
          createdAt,
        );
        for (const measurement of planned.measurements) {
          await database.runAsync(
            `INSERT INTO measurements (
              id, lab_record_id, biomarker_id, specimen_type, original_label, original_value_string,
              original_value_json, original_unit, original_reference_interval, original_flag,
              current_label, current_value_string, current_value_json, current_unit,
              current_reference_interval, current_flag, panel_label, original_state_json, source_page_index, source_bbox_json,
              source_orientation, provenance, review_state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            measurement.id,
            planned.id,
            measurement.biomarkerId,
            planned.specimenType,
            measurement.original.label,
            measurement.original.valueString,
            JSON.stringify(measurement.original),
            measurement.original.unit,
            measurement.original.referenceInterval,
            measurement.original.flag,
            measurement.label,
            measurement.valueString,
            JSON.stringify({
              label: measurement.label,
              value: measurement.value,
              valueString: measurement.valueString,
              unit: measurement.unit,
              referenceInterval: measurement.referenceInterval,
              flag: measurement.flag,
            }),
            measurement.unit,
            measurement.referenceInterval,
            measurement.flag,
            measurement.panelLabel,
            JSON.stringify({
              biomarkerId: measurement.biomarkerId,
              specimenType: planned.specimenType,
              snapshot: measurement.original,
              reviewState: measurement.reviewState,
              provenance: measurement.provenance,
              source: measurement.source,
            }),
            measurement.source.pageIndex,
            JSON.stringify({
              ...measurement.source.boundingBox,
              observationIds: measurement.source.observationIds,
              observations: measurement.source.observations ?? [],
              semantic: measurement.source.semantic ?? null,
            }),
            measurement.source.orientation,
            measurement.provenance,
            measurement.reviewState,
            createdAt,
            createdAt,
          );
        }
        recordIds.push(planned.id);
      }
      await database.runAsync(
        "UPDATE extraction_drafts SET state = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ? AND state = 'draft';",
        createdAt,
        createdAt,
        id,
      );
    });
    const records = await Promise.all(
      recordIds.map(async (recordId) => {
        const record = await getRecord(recordId);
        if (record === null) throw new Error('Confirmed Lab Record could not be read back');
        return record;
      }),
    );
    return records;
  }

  const reportRepository = createLabReportRepository({
    database,
    initialize,
    withWrite,
    now,
    idGenerator: makeId,
  });

  const draftKey = (reportId: string) => `labs.sanitization-draft.${reportId}`;
  async function getSanitizationDraft(reportId: string): Promise<SanitizationRecipe | null> {
    await initialize();
    const rows = await database.getAllAsync<{ value: unknown }>(
      'SELECT value FROM app_preferences WHERE key = ?;',
      draftKey(reportId),
    );
    if (typeof rows[0]?.value !== 'string') return null;
    const value = JSON.parse(rows[0].value) as SanitizationRecipe;
    return createSanitizationRecipe(value.reportId, value.pages);
  }
  async function saveSanitizationDraft(
    reportId: string,
    recipe: SanitizationRecipe,
  ): Promise<void> {
    if (recipe.reportId !== reportId)
      throw new Error('Sanitization draft belongs to another report');
    await initialize();
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO app_preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        draftKey(reportId),
        JSON.stringify(recipe),
        now(),
      );
    });
  }
  async function clearSanitizationDraft(reportId: string): Promise<void> {
    await initialize();
    await withWrite(async () => {
      await database.runAsync('DELETE FROM app_preferences WHERE key = ?;', draftKey(reportId));
    });
  }

  return {
    initialize,
    close,
    listRecords,
    getRecord,
    createRecord,
    updateRecord,
    correctMeasurement,
    findMeasurementRecordId,
    deleteMeasurement,
    deleteRecord,
    requestCombinedDeletion,
    markCombinedDeletionSourceComplete,
    finalizeCombinedDeletion,
    listPendingCombinedDeletions,
    createExtractionDraft,
    countOpenExtractionDrafts,
    getExtractionDraft,
    getExtractionDraftForReport,
    updateExtractionDraftRow,
    confirmExtractionDraft,
    getSanitizationDraft,
    saveSanitizationDraft,
    clearSanitizationDraft,
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
