import type { CanonicalId } from './index';
import { parseLocaleDecimal } from './labs';
import type { LabSourceArtifact, MeasurementValue, SpecimenType, LabDateState } from './labs';

export const VISION_OCR_CONTRACT_VERSION = 'alyte.vision.document.v2' as const;
export const EXTRACTION_PARSER_VERSION = 'alyte.local-parser.v3' as const;

const NUMERIC_TOKEN_PATTERN =
  '[<>≤≥]?\\s*[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?)|(?:\\d+(?:[.,]\\d+)?)|(?:\\.\\d+))';
const PLAIN_NUMERIC_TOKEN_PATTERN =
  '[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?)|(?:\\d+(?:[.,]\\d+)?)|(?:\\.\\d+))';

export type NormalizedBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type VisionTextObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly boundingBox: NormalizedBoundingBox;
  readonly pageIndex: number;
  readonly orientation: number;
  readonly structure?: {
    readonly kind: 'text' | 'table-cell';
    readonly tableId: string | null;
    readonly rowIndex: number | null;
    readonly columnIndex: number | null;
  };
  /** Internal routing metadata. Never render this as a user-facing accuracy percentage. */
  readonly recognition: {
    readonly level: 'fast' | 'accurate';
    readonly language: string | null;
    readonly internalConfidence: number | null;
  };
};

export type VisionOCRResult = {
  readonly contractVersion: typeof VISION_OCR_CONTRACT_VERSION;
  readonly pageIndex: number;
  readonly orientation: number;
  readonly observations: readonly VisionTextObservation[];
};

export type ExtractionSourceLocation = {
  readonly pageIndex: number;
  readonly boundingBox: NormalizedBoundingBox;
  readonly orientation: number;
  readonly artifact?: LabSourceArtifact | null;
  readonly observationIds: readonly string[];
  readonly observations?: readonly VisionTextObservation[];
  /** Exact OCR tokens copied before parsing or normalization. */
  readonly raw?: ExtractionRawSourceTokens;
  readonly semantic?: {
    readonly adapterVersion: string;
    readonly schemaVersion: 'alyte.semantic-mapper.v1';
    readonly sourceObservationIds: readonly string[];
    /** Versioned runtime inputs that produced the accepted source selection. */
    readonly modelVersion?: string;
    readonly runtimeVersion?: string;
    readonly promptVersion?: string;
    readonly chunkVersion?: string;
    readonly parserVersion?: string;
    readonly catalogueVersion?: string;
  } | null;
};

export type ExtractionRawSourceTokens = {
  readonly label: string | null;
  readonly value: string | null;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
  readonly collectionDate: string | null;
};

export type ExtractionDateContext = {
  readonly observationId: string;
  readonly pageIndex: number;
  readonly centerY: number;
  readonly locale: string | null;
  readonly context: 'collection' | 'unknown';
  readonly ambiguous: boolean;
  readonly collectionDate: LabDateState;
  /** The unmodified OCR observation containing the date candidate. */
  readonly sourceText?: string;
};

export type ExtractionRowDecision = 'unresolved' | 'preserve' | 'skip' | 'resolve';

export const EXTRACTION_REVIEW_REASONS = [
  'missing-label',
  'missing-value',
  'unparseable-value',
  'unsupported-alias',
  'missing-unit',
  'incompatible-unit',
  'incompatible-specimen',
  'ambiguous-assay',
  'incompatible-method',
  'unparseable-reference-interval',
  'missing-collection-date',
  'ambiguous-date',
  'unsupported-layout',
] as const;

export type ExtractionReviewReason = (typeof EXTRACTION_REVIEW_REASONS)[number];

const REQUIRED_EXTRACTION_REVIEW_REASONS = new Set<ExtractionReviewReason>([
  'missing-label',
  'missing-value',
  'unparseable-value',
  'missing-unit',
  'incompatible-unit',
  'unsupported-layout',
]);

const AUTO_EXCLUDED_EXTRACTION_REVIEW_REASONS = new Set<ExtractionReviewReason>([
  'missing-unit',
  'incompatible-unit',
  'unsupported-layout',
]);

export function extractionReviewRequiresAttention(
  row: Pick<ExtractionDraftRow, 'reviewReasons'>,
): boolean {
  return row.reviewReasons.some((reason) => REQUIRED_EXTRACTION_REVIEW_REASONS.has(reason));
}

export function extractionReviewBlocksConfirmation(
  row: Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>,
): boolean {
  return row.decision !== 'skip' && extractionReviewRequiresAttention(row);
}

function defaultExtractionDecision(
  reasons: readonly ExtractionReviewReason[],
): ExtractionRowDecision {
  return reasons.some((reason) => AUTO_EXCLUDED_EXTRACTION_REVIEW_REASONS.has(reason))
    ? 'skip'
    : reasons.length === 0
      ? 'resolve'
      : 'preserve';
}

export type ExtractionDraftRow = {
  readonly id: string;
  readonly order: number;
  readonly panelLabel: string | null;
  readonly sourceText: string;
  readonly sourceLabel: string;
  readonly sourceValue: MeasurementValue;
  readonly sourceValueString: string;
  readonly sourceUnit: string | null;
  readonly sourceReferenceInterval: string | null;
  readonly sourceFlag: string | null;
  readonly source: ExtractionSourceLocation;
  readonly collectionDateContext: ExtractionDateContext | null;
  readonly proposedLabel: string;
  readonly proposedValue: MeasurementValue;
  readonly proposedUnit: string | null;
  readonly proposedReferenceInterval: string | null;
  readonly proposedFlag: string | null;
  readonly proposedBiomarkerId: CanonicalId | null;
  readonly proposedSpecimenType: SpecimenType;
  readonly collectionDate: LabDateState;
  readonly reviewReasons: readonly ExtractionReviewReason[];
  readonly reviewState: 'ready' | 'needs-review';
  readonly decision: ExtractionRowDecision;
};

export type ExtractionDraft = {
  readonly id: string;
  readonly reportId: string;
  readonly state: 'draft' | 'confirmed' | 'failed';
  readonly ocrContractVersion: typeof VISION_OCR_CONTRACT_VERSION;
  readonly parserVersion: typeof EXTRACTION_PARSER_VERSION;
  readonly sourceArtifact?: LabSourceArtifact | null;
  readonly collectionDate: LabDateState;
  readonly rows: readonly ExtractionDraftRow[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
};

export type ExtractionAliasEntry = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly specimens: readonly SpecimenType[];
  readonly units: readonly string[];
  readonly unsafeAliases?: readonly string[];
  readonly methodPolicy?: {
    readonly version: string;
    readonly kind: 'method-agnostic' | 'standardized' | 'requires-explicit-method';
    readonly allowedMethods: readonly string[];
    readonly unsafePatterns: readonly string[];
    readonly profiles?: readonly ExtractionMethodProfile[];
  };
};

export type ExtractionMethodProfile = {
  readonly id: string;
  readonly assayPatterns: readonly string[];
  readonly temperatureC: 30 | 37;
  readonly temperaturePatterns: readonly string[];
  readonly pyridoxalPhosphate: 'present' | 'absent' | 'not-applicable';
  readonly pyridoxalPhosphatePatterns: readonly string[];
};

export type ExtractionSemanticProposal = {
  readonly sourceObservationIds: readonly string[];
  readonly proposedBiomarkerId: CanonicalId | null;
  readonly proposedSpecimenType?: SpecimenType | 'other';
  readonly role?: 'measurement' | 'specimen-context' | 'ignore';
};

/**
 * A deterministic Vision/table/geometry group supplied to the semantic mapper. The row ID is
 * internal bookkeeping; the model may only copy the complete sourceObservationIds array when it
 * proposes a mapping. Keeping cells nested under a row prevents the wire contract from presenting
 * one physical result as an unrelated OCR wall.
 */
export type ExtractionSemanticCandidateRow = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly observations: readonly VisionTextObservation[];
};

export type ExtractionSemanticProvenance = NonNullable<ExtractionSourceLocation['semantic']>;

/**
 * Ownership token for one extraction's use of a semantic runtime. The mapper may share the
 * underlying loaded model across extractions, but each successful prepare must release exactly
 * its own lease.
 */
export type ExtractionSemanticLease = {
  readonly release: () => Promise<void>;
};

export interface ExtractionSemanticMapper {
  readonly adapterVersion: string;
  readonly schemaVersion: 'alyte.semantic-mapper.v1';
  /** Maximum number of deterministic candidate rows in one model request. */
  readonly maxRowsPerChunk?: number;
  /** Maximum OCR observations in one model request, including every cell in those rows. */
  readonly maxObservationsPerChunk?: number;
  /** Optional production gate. A successful prepare returns an extraction-scoped runtime lease. */
  readonly prepare?: () => Promise<ExtractionSemanticLease>;
  readonly provenance?: Readonly<
    Partial<
      Pick<
        ExtractionSemanticProvenance,
        | 'modelVersion'
        | 'runtimeVersion'
        | 'promptVersion'
        | 'chunkVersion'
        | 'parserVersion'
        | 'catalogueVersion'
      >
    >
  >;
  supports(locale: string | null): boolean;
  map(input: {
    readonly pageIndex: number;
    readonly rows: readonly ExtractionSemanticCandidateRow[];
    readonly headings?: readonly VisionTextObservation[];
  }): Promise<unknown>;
}

type SemanticCandidateRowsInput =
  readonly ExtractionSemanticCandidateRow[] | readonly VisionTextObservation[];

/**
 * Keeps the old observation-array shape available to pure-domain callers while production uses
 * explicit candidate rows. This compatibility adapter is intentionally not used by the native
 * production wire serializer.
 */
function candidateRowsFromInput(
  input: SemanticCandidateRowsInput,
): readonly ExtractionSemanticCandidateRow[] {
  if (input.length === 0) return [];
  const first = input[0];
  if (first !== undefined && 'text' in first) {
    const observations = input as readonly VisionTextObservation[];
    const rowKeys = semanticObservationRowKeys(observations);
    const rows = new Map<string, VisionTextObservation[]>();
    for (const observation of observations) {
      const rowId = rowKeys.get(observation.id);
      if (rowId === undefined) continue;
      const row = rows.get(rowId) ?? [];
      row.push(observation);
      rows.set(rowId, row);
    }
    return [...rows].map(([rowId, rowObservations]) => ({
      rowId,
      sourceObservationIds: rowObservations.map((observation) => observation.id),
      observations: rowObservations,
    }));
  }
  return input as readonly ExtractionSemanticCandidateRow[];
}

/** Rejects model output unless it refers only to exact local rows and known catalogue IDs. */
export function validateSemanticProposals(
  input: unknown,
  candidateRowsInput: SemanticCandidateRowsInput,
  aliases: readonly ExtractionAliasEntry[],
): readonly ExtractionSemanticProposal[] {
  const isEnvelope = !Array.isArray(input);
  const proposals: readonly unknown[] | null = Array.isArray(input)
    ? input
    : typeof input === 'object' &&
        input !== null &&
        Array.isArray((input as Record<string, unknown>).proposals)
      ? ((input as Record<string, unknown>).proposals as readonly unknown[])
      : null;
  if (proposals === null) return [];
  if (proposals.length > 24) return [];
  const candidateRows = candidateRowsFromInput(candidateRowsInput);
  const sourceById = new Map<string, VisionTextObservation>();
  const rowBySourceIds = new Map<string, ExtractionSemanticCandidateRow>();
  const rowIds = new Set<string>();
  for (const row of candidateRows) {
    if (
      row.rowId.length === 0 ||
      row.rowId.length > 96 ||
      rowIds.has(row.rowId) ||
      row.sourceObservationIds.length === 0 ||
      row.sourceObservationIds.length > 8 ||
      new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length ||
      row.sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
      row.observations.length !== row.sourceObservationIds.length
    )
      return [];
    const rowObservationIds = row.observations.map((observation) => observation.id);
    if (
      rowObservationIds.some((id, index) => id !== row.sourceObservationIds[index]) ||
      row.observations.some((observation) => sourceById.has(observation.id))
    )
      return [];
    row.observations.forEach((observation) => sourceById.set(observation.id, observation));
    rowIds.add(row.rowId);
    rowBySourceIds.set(JSON.stringify(row.sourceObservationIds), row);
  }
  const biomarkerIds = new Set(aliases.map((item) => item.id));
  const consumedRows = new Set<string>();
  const accepted = proposals.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const value = item as Record<string, unknown>;
    if (!Array.isArray(value.sourceObservationIds)) return [];
    const allowedKeys = new Set([
      'sourceObservationIds',
      'proposedBiomarkerId',
      'biomarkerId',
      'proposedSpecimenType',
      'specimenType',
      'role',
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return [];
    if (value.proposedBiomarkerId !== undefined && value.biomarkerId !== undefined) return [];
    if (value.proposedSpecimenType !== undefined && value.specimenType !== undefined) return [];
    if (value.sourceObservationIds.some((id) => typeof id !== 'string')) return [];
    const sourceObservationIds = value.sourceObservationIds as string[];
    if (
      sourceObservationIds.length === 0 ||
      sourceObservationIds.length > 8 ||
      sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
      new Set(sourceObservationIds).size !== sourceObservationIds.length ||
      !sourceObservationIds.every((id) => sourceById.has(id))
    )
      return [];
    const row = rowBySourceIds.get(JSON.stringify(sourceObservationIds));
    // The model must copy the complete row ID array, including order. A partial, cross-row,
    // reordered, or extra-ID proposal is rejected rather than inferred or repaired.
    if (row === undefined || consumedRows.has(row.rowId)) return [];
    const sourceRows = sourceObservationIds.map((id) => sourceById.get(id));
    if (sourceRows.some((observation) => observation === undefined)) return [];
    const rawBiomarkerId =
      value.proposedBiomarkerId === undefined ? value.biomarkerId : value.proposedBiomarkerId;
    const proposedBiomarkerId =
      rawBiomarkerId === null || rawBiomarkerId === undefined
        ? null
        : typeof rawBiomarkerId === 'string'
          ? (rawBiomarkerId as CanonicalId)
          : null;
    if (rawBiomarkerId !== null && rawBiomarkerId !== undefined && proposedBiomarkerId === null)
      return [];
    const rawSpecimenType =
      value.proposedSpecimenType === undefined ? value.specimenType : value.proposedSpecimenType;
    const proposedSpecimenType =
      rawSpecimenType === undefined
        ? undefined
        : rawSpecimenType === 'other'
          ? 'other'
          : typeof rawSpecimenType === 'string' &&
              ['blood', 'serum', 'plasma', 'urine', 'stool', 'saliva', 'unknown'].includes(
                rawSpecimenType,
              )
            ? (rawSpecimenType as SpecimenType)
            : null;
    if (proposedSpecimenType === null) return [];
    const role =
      value.role === undefined
        ? undefined
        : value.role === 'measurement' ||
            value.role === 'specimen-context' ||
            value.role === 'ignore'
          ? value.role
          : null;
    if (role === null) return [];
    if (role === 'measurement' && proposedBiomarkerId === null) return [];
    if (role !== undefined && role !== 'measurement' && proposedBiomarkerId !== null) return [];
    const proposal: ExtractionSemanticProposal = {
      sourceObservationIds,
      proposedBiomarkerId,
      ...(proposedSpecimenType === undefined ? {} : { proposedSpecimenType }),
      ...(role === undefined ? {} : { role }),
    };
    if (proposal.proposedBiomarkerId !== null && !biomarkerIds.has(proposal.proposedBiomarkerId))
      return [];
    consumedRows.add(row.rowId);
    return [proposal];
  });
  // A malformed or duplicate envelope must never partially influence the draft. The production
  // mapper performs the same all-or-none check; this helper keeps legacy adapters fail-closed too.
  return isEnvelope && accepted.length !== proposals.length ? [] : accepted;
}

/**
 * Assigns a stable internal row key without exposing row bookkeeping to the model. Vision table
 * structure is authoritative when present; otherwise the same geometry tolerance as deterministic
 * extraction keeps a multi-cell loose row eligible for one semantic proposal.
 */
function semanticObservationRowKeys(
  observations: readonly VisionTextObservation[],
): ReadonlyMap<string, string> {
  const rowKeys = new Map<string, string>();
  const looseByPage = new Map<number, VisionTextObservation[]>();
  for (const observation of observations) {
    const structure = observation.structure;
    if (
      structure?.kind === 'table-cell' &&
      structure.tableId !== null &&
      structure.rowIndex !== null
    ) {
      rowKeys.set(
        observation.id,
        `table:${observation.pageIndex}:${structure.tableId}:${structure.rowIndex}`,
      );
      continue;
    }
    const page = looseByPage.get(observation.pageIndex) ?? [];
    page.push(observation);
    looseByPage.set(observation.pageIndex, page);
  }
  for (const [pageIndex, pageObservations] of looseByPage) {
    const groups: VisionTextObservation[][] = [];
    for (const observation of [...pageObservations].sort(
      (left, right) =>
        left.boundingBox.y +
          left.boundingBox.height / 2 -
          (right.boundingBox.y + right.boundingBox.height / 2) ||
        left.boundingBox.x - right.boundingBox.x,
    )) {
      const prior = groups.at(-1);
      const priorObservation = prior?.[0];
      const center = observation.boundingBox.y + observation.boundingBox.height / 2;
      const priorCenter =
        priorObservation === undefined
          ? null
          : priorObservation.boundingBox.y + priorObservation.boundingBox.height / 2;
      if (
        prior !== undefined &&
        priorObservation !== undefined &&
        priorCenter !== null &&
        Math.abs(center - priorCenter) <=
          Math.max(observation.boundingBox.height, priorObservation.boundingBox.height) * 0.75
      ) {
        prior.push(observation);
      } else {
        groups.push([observation]);
      }
    }
    groups.forEach((group, index) => {
      const key = `loose:${pageIndex}:${index}`;
      group.forEach((observation) => rowKeys.set(observation.id, key));
    });
  }
  return rowKeys;
}

export type ExtractionRowInput = {
  readonly id: string;
  readonly order: number;
  readonly panelLabel?: string | null;
  readonly text: string;
  readonly source: ExtractionSourceLocation;
  readonly collectionDate?: LabDateState;
  readonly collectionDateContexts?: readonly ExtractionDateContext[];
  readonly specimenType?: SpecimenType;
};

export type ExtractionDraftRowPatch = {
  readonly proposedLabel?: string;
  readonly proposedValue?: MeasurementValue;
  readonly proposedUnit?: string | null;
  readonly proposedReferenceInterval?: string | null;
  readonly proposedFlag?: string | null;
  readonly proposedBiomarkerId?: CanonicalId | null;
  readonly proposedSpecimenType?: SpecimenType;
  readonly collectionDate?: LabDateState;
  readonly decision?: ExtractionRowDecision;
};

export type ExtractionConfirmationPlan = {
  readonly draftId: string;
  readonly reportId: string;
  readonly records: readonly {
    readonly id: string;
    readonly collectionDate: LabDateState;
    readonly specimenType: SpecimenType;
    readonly measurements: readonly {
      readonly id: string;
      readonly biomarkerId: CanonicalId | null;
      readonly panelLabel: string | null;
      readonly label: string;
      readonly value: MeasurementValue;
      readonly valueString: string;
      readonly unit: string | null;
      readonly referenceInterval: string | null;
      readonly flag: string | null;
      readonly source: ExtractionSourceLocation;
      readonly original: {
        readonly label: string;
        readonly value: MeasurementValue;
        readonly valueString: string;
        readonly unit: string | null;
        readonly referenceInterval: string | null;
        readonly flag: string | null;
      };
      readonly sourceRowId: string;
      readonly reviewState: 'confirmed' | 'needs-review';
      readonly provenance: 'extracted' | 'user-corrected';
    }[];
  }[];
};

export function decodeVisionOCRResult(input: unknown): VisionOCRResult {
  if (typeof input !== 'object' || input === null)
    throw new Error('Vision OCR result is not an object');
  const value = input as Record<string, unknown>;
  if (value.contractVersion !== VISION_OCR_CONTRACT_VERSION)
    throw new Error('Unsupported Vision OCR contract version');
  const pageIndex = finiteInteger(value.pageIndex, 'Vision OCR page index', 0);
  const orientation = finiteInteger(value.orientation ?? 0, 'Vision OCR orientation', -360, 360);
  if (!Array.isArray(value.observations)) throw new Error('Vision OCR observations are missing');
  return {
    contractVersion: VISION_OCR_CONTRACT_VERSION,
    pageIndex,
    orientation,
    observations: value.observations.map((item, index) =>
      decodeObservation(item, index, pageIndex, orientation),
    ),
  };
}

function finiteInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid ${field}`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function decodeObservation(
  input: unknown,
  index: number,
  pageIndex: number,
  pageOrientation: number,
): VisionTextObservation {
  if (typeof input !== 'object' || input === null)
    throw new Error(`Vision OCR observation ${index} is not an object`);
  const value = input as Record<string, unknown>;
  const text = typeof value.text === 'string' ? value.text : '';
  if (text.trim().length === 0) throw new Error(`Vision OCR observation ${index} has no text`);
  const rawBox = value.boundingBox;
  if (typeof rawBox !== 'object' || rawBox === null)
    throw new Error(`Vision OCR observation ${index} has no bounding box`);
  const box = rawBox as Record<string, unknown>;
  const boundingBox = {
    x: finiteNumber(box.x, 'Vision OCR bounding-box x'),
    y: finiteNumber(box.y, 'Vision OCR bounding-box y'),
    width: finiteNumber(box.width, 'Vision OCR bounding-box width'),
    height: finiteNumber(box.height, 'Vision OCR bounding-box height'),
  };
  if (
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width <= 0 ||
    boundingBox.height <= 0 ||
    boundingBox.x + boundingBox.width > 1.000001 ||
    boundingBox.y + boundingBox.height > 1.000001
  ) {
    throw new Error(`Vision OCR observation ${index} has an invalid normalized bounding box`);
  }
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .filter((candidate) => candidate.trim().length > 0)
        .slice(0, 5)
    : [];
  const rawRecognition =
    typeof value.recognition === 'object' && value.recognition !== null
      ? (value.recognition as Record<string, unknown>)
      : {};
  const level = rawRecognition.level === 'fast' ? 'fast' : 'accurate';
  const language =
    typeof rawRecognition.language === 'string' && rawRecognition.language.length > 0
      ? rawRecognition.language
      : null;
  const internalConfidence =
    rawRecognition.internalConfidence === null || rawRecognition.internalConfidence === undefined
      ? null
      : finiteNumber(rawRecognition.internalConfidence, 'Vision OCR internal confidence');
  if (internalConfidence !== null && (internalConfidence < 0 || internalConfidence > 1))
    throw new Error(`Vision OCR observation ${index} has invalid internal confidence`);
  return {
    id:
      typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : `observation-${pageIndex}-${index}`,
    text,
    alternatives,
    boundingBox,
    pageIndex:
      value.pageIndex === undefined
        ? pageIndex
        : finiteInteger(value.pageIndex, 'Vision OCR observation page index', 0),
    orientation:
      value.orientation === undefined
        ? pageOrientation
        : finiteInteger(value.orientation, 'Vision OCR observation orientation', -360, 360),
    structure: decodeObservationStructure(value.structure, index),
    recognition: { level, language, internalConfidence },
  };
}

function decodeObservationStructure(
  input: unknown,
  index: number,
): NonNullable<VisionTextObservation['structure']> {
  if (input === undefined)
    return { kind: 'text', tableId: null, rowIndex: null, columnIndex: null };
  if (typeof input !== 'object' || input === null)
    throw new Error(`Vision OCR observation ${index} has invalid structure`);
  const value = input as Record<string, unknown>;
  const kind = value.kind === 'table-cell' ? 'table-cell' : value.kind === 'text' ? 'text' : null;
  if (kind === null) throw new Error(`Vision OCR observation ${index} has invalid structure kind`);
  const tableId = typeof value.tableId === 'string' && value.tableId ? value.tableId : null;
  const rowIndex =
    value.rowIndex === null || value.rowIndex === undefined
      ? null
      : finiteInteger(value.rowIndex, 'table row index', 0);
  const columnIndex =
    value.columnIndex === null || value.columnIndex === undefined
      ? null
      : finiteInteger(value.columnIndex, 'table column index', 0);
  if (kind === 'table-cell' && (tableId === null || rowIndex === null || columnIndex === null))
    throw new Error(`Vision OCR observation ${index} has incomplete table structure`);
  return { kind, tableId, rowIndex, columnIndex };
}

export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function proposeBiomarkerId(
  label: string,
  aliases: readonly ExtractionAliasEntry[],
): CanonicalId | null {
  const normalized = normalizeAlias(label);
  if (!normalized) return null;
  if (findUnsafeBiomarkerLabel(label, aliases) !== null) return null;
  const exact = aliases.find((entry) =>
    entry.aliases.some((alias) => normalizeAlias(alias) === normalized),
  );
  return exact === undefined ? null : (exact.id as CanonicalId);
}

export function parseComparatorValue(input: string): MeasurementValue | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^([<>≤≥])?\s*([+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+))\s*(.*)$/u);
  if (match === null) return trimmed.length === 0 ? null : { kind: 'free_text', value: trimmed };
  const numeric = parseLocaleDecimal(match[2] ?? '');
  if (numeric === null) return { kind: 'free_text', value: trimmed };
  const comparator = match[1] === '≤' ? '<' : match[1] === '≥' ? '>' : match[1];
  return comparator === '<' || comparator === '>'
    ? { kind: 'bounded', comparator, value: numeric }
    : { kind: 'numeric', value: numeric };
}

export function parseLabDate(input: string, locale = 'en-US'): LabDateState | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[./-]/).map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  let year: number;
  let month: number;
  let day: number;
  if (String(parts[0]).length === 4) [year, month, day] = parts as [number, number, number];
  else if ((parts[0] ?? 0) > 12) [day, month, year] = parts as [number, number, number];
  else if ((parts[1] ?? 0) > 12) [month, day, year] = parts as [number, number, number];
  else if (/^en-(us|ca)/i.test(locale)) [month, day, year] = parts as [number, number, number];
  else [day, month, year] = parts as [number, number, number];
  if (year < 100) year += 2000;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days) return null;
  return {
    kind: 'known',
    value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function parseReferenceInterval(input: string | null): string | null {
  if (input === null) return null;
  const value = input.trim();
  if (!value) return null;
  // Preserve the laboratory string exactly, but reject strings that look like an OCR fragment.
  const range = value.match(
    /^(?:[<>≤≥]\s*)?[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+)(?:\s*(?:-|–|—|to)\s*[<>≤≥]?\s*[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+))?$/iu,
  );
  return range === null ? null : value;
}

export function normalizeUnit(input: string | null): string | null {
  if (input === null) return null;
  const normalized = input.trim().replace('μ', 'µ').replace(/\s+/g, ' ');
  if (!normalized) return null;
  const lower = normalized.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    'mg/dl': 'mg/dL',
    'mg dl': 'mg/dL',
    'mmol/l': 'mmol/L',
    'mmol l': 'mmol/L',
    'g/dl': 'g/dL',
    'g/l': 'g/L',
    '%': '%',
    'mmol/mol': 'mmol/mol',
    fl: 'fL',
    'ng/ml': 'ng/mL',
    'ug/l': 'µg/L',
    'µg/l': 'µg/L',
    'nmol/l': 'nmol/L',
    'pg/ml': 'pg/mL',
    'pmol/l': 'pmol/L',
    'u/l': 'U/L',
    'iu/l': 'U/L',
    'l/l': 'L/L',
  };
  return aliases[lower] ?? normalized;
}

function requiresNumericUnit(value: MeasurementValue, unit: string | null): boolean {
  return unit === null && (value.kind === 'numeric' || value.kind === 'bounded');
}

function unitCompatible(
  unit: string | null,
  biomarkerId: CanonicalId | null,
  aliases: readonly ExtractionAliasEntry[],
): boolean {
  if (unit === null || biomarkerId === null) return true;
  const entry = aliases.find((candidate) => candidate.id === biomarkerId);
  return (
    entry === undefined ||
    entry.units.some((candidate) => normalizeUnit(candidate) === normalizeUnit(unit))
  );
}

function specimenCompatible(
  specimen: SpecimenType,
  biomarkerId: CanonicalId | null,
  aliases: readonly ExtractionAliasEntry[],
): boolean {
  if (biomarkerId === null || specimen === 'unknown') return true;
  const entry = aliases.find((candidate) => candidate.id === biomarkerId);
  return entry === undefined || entry.specimens.includes(specimen);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp | null {
  const words = normalizeAlias(alias).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join('[^\\p{L}\\p{N}]+'), 'iu');
}

export function findUnsafeBiomarkerLabel(
  sourceText: string,
  aliases: readonly ExtractionAliasEntry[],
  candidateId?: CanonicalId | null,
): { readonly id: CanonicalId; readonly pattern: string } | null {
  for (const entry of aliases) {
    if (candidateId !== undefined && entry.id !== candidateId) continue;
    for (const patternText of [
      ...(entry.unsafeAliases ?? []),
      ...(entry.methodPolicy?.unsafePatterns ?? []),
    ]) {
      const pattern = aliasPattern(patternText);
      if (pattern?.test(sourceText)) return { id: entry.id as CanonicalId, pattern: patternText };
    }
  }
  return null;
}

function methodProfileMatches(sourceText: string, profile: ExtractionMethodProfile): boolean {
  const normalized = normalizeAlias(sourceText);
  const containsAny = (patterns: readonly string[]) =>
    patterns.some((pattern) => normalized.includes(normalizeAlias(pattern)));
  return (
    containsAny(profile.assayPatterns) &&
    containsAny(profile.temperaturePatterns) &&
    containsAny(profile.pyridoxalPhosphatePatterns)
  );
}

export function resolveExtractionMethodProfile(
  sourceText: string,
  policy: ExtractionAliasEntry['methodPolicy'] | undefined,
): ExtractionMethodProfile | null {
  if (policy?.profiles === undefined) return null;
  const matches = policy.profiles.filter((profile) => methodProfileMatches(sourceText, profile));
  return matches.length === 1 ? matches[0]! : null;
}

function methodCompatible(
  sourceText: string,
  biomarkerId: CanonicalId | null,
  aliases: readonly ExtractionAliasEntry[],
): boolean {
  if (biomarkerId === null) return true;
  const entry = aliases.find((candidate) => candidate.id === biomarkerId);
  const policy = entry?.methodPolicy;
  if (policy === undefined || policy.kind !== 'requires-explicit-method') return true;
  if (policy.profiles !== undefined)
    return resolveExtractionMethodProfile(sourceText, policy) !== null;
  return policy.allowedMethods.some((method) => aliasPattern(method)?.test(sourceText) ?? false);
}

function findAliasMatches(
  sourceText: string,
  aliases: readonly ExtractionAliasEntry[],
): readonly {
  readonly id: CanonicalId;
  readonly text: string;
  readonly length: number;
  readonly start: number;
}[] {
  const matches = aliases.flatMap((entry) =>
    entry.aliases.flatMap((alias) => {
      const pattern = aliasPattern(alias);
      const match = pattern?.exec(sourceText);
      return match === null || match === undefined
        ? []
        : (() => {
            const start = match.index;
            let end = start + match[0].length;
            if (sourceText[end] === '(') {
              const closing = sourceText.indexOf(')', end + 1);
              if (closing >= 0) end = closing + 1;
            }
            return [
              {
                id: entry.id as CanonicalId,
                text: sourceText.slice(start, end),
                length: normalizeAlias(alias).length,
                start,
              },
            ];
          })();
    }),
  );
  matches.sort((a, b) => a.start - b.start || b.length - a.length || a.text.length - b.text.length);
  return matches;
}

type NumericSourceCandidate = {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly value: MeasurementValue | null;
};

type SourceValueAnalysis = {
  readonly valueCandidates: readonly NumericSourceCandidate[];
  readonly effectiveReferences: readonly {
    readonly raw: string;
    readonly start: number;
    readonly end: number;
  }[];
};

function analyzeSourceValues(sourceText: string): SourceValueAnalysis {
  const numericCandidates: NumericSourceCandidate[] = [
    ...sourceText.matchAll(new RegExp(NUMERIC_TOKEN_PATTERN, 'gu')),
  ]
    .map((match) => {
      const raw = match[0].trim();
      const start = (match.index ?? 0) + match[0].indexOf(raw);
      return {
        raw,
        start,
        end: start + raw.length,
        value: parseComparatorValue(raw),
      };
    })
    .filter((candidate) => {
      const before = sourceText[candidate.start - 1] ?? '';
      const after = sourceText[candidate.end] ?? '';
      const afterAfter = sourceText[candidate.end + 1] ?? '';
      const afterCandidate = sourceText.slice(candidate.start);
      const isMethodTemperature = /^(?:30|37)\s*(?:°\s*)?C\b|^(?:30|37)\s+degrees?/iu.test(
        afterCandidate,
      );
      return (
        !/[\p{L}\p{N}]/u.test(before) &&
        !/[\p{L}\p{N}]/u.test(after) &&
        !(after === '-' && /[\p{L}]/u.test(afterAfter)) &&
        !isMethodTemperature
      );
    });
  const referenceCandidates = [
    ...sourceText.matchAll(
      new RegExp(
        `(?:[<>≤≥]\\s*${PLAIN_NUMERIC_TOKEN_PATTERN}|${PLAIN_NUMERIC_TOKEN_PATTERN}\\s*(?:-|–|—|to)\\s*[<>≤≥]?\\s*${PLAIN_NUMERIC_TOKEN_PATTERN})`,
        'giu',
      ),
    ),
  ].map((match) => ({
    raw: match[0].trim(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const rangeReferences = referenceCandidates.filter(
    (reference) => !/^[<>≤≥]/u.test(reference.raw),
  );
  const overlapsRangeReference = (candidate: { start: number; end: number }) =>
    rangeReferences.some(
      (reference) => candidate.start < reference.end && candidate.end > reference.start,
    );
  const numericOutsideRange = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'numeric' && !overlapsRangeReference(candidate),
  );
  const isReference = (candidate: {
    start: number;
    end: number;
    value?: MeasurementValue | null;
  }) =>
    referenceCandidates.some(
      (reference) =>
        candidate.start < reference.end &&
        candidate.end > reference.start &&
        (!/^[<>≤≥]/u.test(reference.raw) || numericOutsideRange.length > 0),
    );
  const scalarCandidates = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'numeric' && !isReference(candidate),
  );
  const boundedCandidates = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'bounded' && !isReference(candidate),
  );
  return {
    valueCandidates: scalarCandidates.length > 0 ? scalarCandidates : boundedCandidates,
    effectiveReferences: referenceCandidates.filter(
      (reference) => !/^[<>≤≥]/u.test(reference.raw) || numericOutsideRange.length > 0,
    ),
  };
}

export function groupObservationsIntoRows(
  observations: readonly VisionTextObservation[],
  options: {
    readonly locale?: string;
    readonly collectionDate?: LabDateState;
    readonly collectionDateContexts?: readonly ExtractionDateContext[];
    readonly specimenType?: SpecimenType;
    readonly aliases?: readonly ExtractionAliasEntry[];
    readonly artifact?: LabSourceArtifact | null;
  } = {},
): readonly ExtractionDraftRow[] {
  const aliases = options.aliases ?? [];
  const sorted = [...observations]
    .filter((observation) => observation.text.trim())
    .sort(
      (a, b) =>
        a.pageIndex - b.pageIndex ||
        a.boundingBox.y + a.boundingBox.height / 2 - (b.boundingBox.y + b.boundingBox.height / 2) ||
        a.boundingBox.x - b.boundingBox.x,
    );
  const tableGroups = new Map<string, VisionTextObservation[]>();
  const loose: VisionTextObservation[] = [];
  for (const observation of sorted) {
    const structure = observation.structure ?? {
      kind: 'text' as const,
      tableId: null,
      rowIndex: null,
    };
    if (
      structure.kind === 'table-cell' &&
      structure.tableId !== null &&
      structure.rowIndex !== null
    ) {
      const key = `${observation.pageIndex}:${structure.tableId}:${structure.rowIndex}`;
      const group = tableGroups.get(key) ?? [];
      group.push(observation);
      tableGroups.set(key, group);
    } else loose.push(observation);
  }
  const groups: VisionTextObservation[][] = [...tableGroups.values()];
  for (const observation of loose) {
    const center = observation.boundingBox.y + observation.boundingBox.height / 2;
    const prior = groups.at(-1);
    const priorObservation = prior?.[0];
    const priorCenter =
      priorObservation === undefined
        ? null
        : priorObservation.boundingBox.y + priorObservation.boundingBox.height / 2;
    if (
      prior !== undefined &&
      priorObservation?.pageIndex === observation.pageIndex &&
      priorCenter !== null &&
      Math.abs(center - priorCenter) <=
        Math.max(observation.boundingBox.height, priorObservation.boundingBox.height) * 0.75
    )
      prior.push(observation);
    else groups.push([observation]);
  }
  return groups
    .map((group) => group.sort((a, b) => a.boundingBox.x - b.boundingBox.x))
    .sort(
      (a, b) =>
        (a[0]?.pageIndex ?? 0) - (b[0]?.pageIndex ?? 0) ||
        (a[0]?.boundingBox.y ?? 0) - (b[0]?.boundingBox.y ?? 0),
    )
    .map((group, order) =>
      parseSourceRow(
        group,
        order,
        options.locale ?? 'en-US',
        options.collectionDate ?? { kind: 'missing' },
        options.collectionDateContexts ?? [],
        options.specimenType ?? 'unknown',
        aliases,
        options.artifact ?? null,
      ),
    )
    .filter(isMeasurementShapedRow);
}

function isMeasurementShapedRow(row: ExtractionDraftRow): boolean {
  if (row.sourceLabel.trim().length < 2) return false;
  if (row.proposedBiomarkerId !== null && /\d/u.test(row.sourceText)) return true;
  if (row.sourceValueString.length === 0 || row.sourceValue.kind === 'free_text') return false;
  // Unknown biomarkers are useful only when the row has laboratory shape. A numeric token in a
  // phone number, address, licence, or footer is not enough to create review work.
  return (
    row.sourceValue.kind === 'categorical' ||
    row.proposedBiomarkerId !== null ||
    row.sourceUnit !== null ||
    row.sourceReferenceInterval !== null
  );
}

function parseSourceRow(
  group: readonly VisionTextObservation[],
  order: number,
  locale: string,
  collectionDate: LabDateState,
  collectionDateContexts: readonly ExtractionDateContext[],
  specimenType: SpecimenType,
  aliases: readonly ExtractionAliasEntry[],
  artifact: LabSourceArtifact | null,
): ExtractionDraftRow {
  const sourceText = group.map((observation) => observation.text.trim()).join('  ');
  const first = group[0];
  const firstBox = first?.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const source = {
    pageIndex: first?.pageIndex ?? 0,
    orientation: first?.orientation ?? 0,
    artifact,
    observationIds: group.map((item) => item.id),
    observations: [...group],
    semantic: null,
    boundingBox: group.slice(1).reduce(
      (box, item) => ({
        x: Math.min(box.x, item.boundingBox.x),
        y: Math.min(box.y, item.boundingBox.y),
        width:
          Math.max(box.x + box.width, item.boundingBox.x + item.boundingBox.width) -
          Math.min(box.x, item.boundingBox.x),
        height:
          Math.max(box.y + box.height, item.boundingBox.y + item.boundingBox.height) -
          Math.min(box.y, item.boundingBox.y),
      }),
      { ...firstBox },
    ),
  };
  const aliasMatches = findAliasMatches(sourceText, aliases);
  const aliasMatch = aliasMatches[0] ?? null;
  const hasSiblingAlias = new Set(aliasMatches.map((match) => match.id)).size > 1;
  const unsafeMatch = findUnsafeBiomarkerLabel(sourceText, aliases, aliasMatch?.id);
  const globalUnsafeMatch =
    aliasMatch === null ? findUnsafeBiomarkerLabel(sourceText, aliases) : null;
  const { valueCandidates, effectiveReferences } = analyzeSourceValues(sourceText);
  const selectedValue = valueCandidates.length === 1 ? valueCandidates[0] : undefined;
  const categoricalMatch =
    selectedValue === undefined
      ? /\b(not detected|positive|negative|detected|normal|abnormal|teigiamas|neigiamas|aptikta|neaptikta|positiv|negativ)\s*$/iu.exec(
          sourceText,
        )
      : null;
  const rawValue = selectedValue?.raw ?? categoricalMatch?.[1] ?? '';
  const valueStart = selectedValue?.start ?? categoricalMatch?.index ?? -1;
  const rawLabel = valueStart > 0 ? sourceText.slice(0, valueStart).trim() : sourceText;
  const proposedValue =
    categoricalMatch !== null
      ? { kind: 'categorical' as const, value: rawValue }
      : (parseComparatorValue(rawValue) ?? { kind: 'free_text' as const, value: sourceText });
  const unitMatch = sourceText.match(
    /(?:mg\s*\/\s*dL?|mmol\s*\/\s*L|g\s*\/\s*dL?|g\s*\/\s*L|ng\s*\/\s*mL|nmol\s*\/\s*L|µ?g\s*\/\s*L|pg\s*\/\s*mL|pmol\s*\/\s*L|IU\s*\/\s*L|U\s*\/\s*L|L\s*\/\s*L|fL|%|mmol\s*\/\s*mol)/iu,
  );
  const rawUnit = unitMatch?.[0] ?? null;
  const unit = normalizeUnit(rawUnit);
  const referenceCandidate = effectiveReferences[0]?.raw ?? null;
  const reference = parseReferenceInterval(referenceCandidate);
  const flagCandidate =
    sourceText.match(/(?:^|\s)(high|low|normal|abnormal|h|l|n)(?=\s|$)/iu)?.[1] ?? null;
  const safeAliasMatch = unsafeMatch === null && !hasSiblingAlias ? aliasMatch : null;
  const label = safeAliasMatch?.text ?? (rawLabel.trim() || sourceText);
  const biomarkerId = safeAliasMatch?.id ?? proposeBiomarkerId(label, aliases);
  const reasons: ExtractionReviewReason[] = [];
  if (!label) reasons.push('missing-label');
  if (!rawValue) reasons.push('missing-value');
  if (proposedValue.kind === 'free_text') reasons.push('unparseable-value');
  if (valueCandidates.length > 1 || effectiveReferences.length > 1 || hasSiblingAlias)
    reasons.push('unsupported-layout');
  if (biomarkerId === null) reasons.push('unsupported-alias');
  if (unsafeMatch !== null || globalUnsafeMatch !== null || hasSiblingAlias)
    reasons.push('ambiguous-assay');
  else if (!methodCompatible(sourceText, biomarkerId, aliases)) reasons.push('incompatible-method');
  if (!unitCompatible(unit, biomarkerId, aliases)) reasons.push('incompatible-unit');
  if (requiresNumericUnit(proposedValue, unit)) reasons.push('missing-unit');
  if (!specimenCompatible(specimenType, biomarkerId, aliases))
    reasons.push('incompatible-specimen');
  if (referenceCandidate !== null && reference === null)
    reasons.push('unparseable-reference-interval');
  const rowCenterY =
    group.reduce((sum, item) => sum + item.boundingBox.y + item.boundingBox.height / 2, 0) /
    Math.max(1, group.length);
  const nearestDateContext = collectionDateContexts
    .filter((candidate) => candidate.pageIndex === source.pageIndex)
    .sort((a, b) => Math.abs(a.centerY - rowCenterY) - Math.abs(b.centerY - rowCenterY))[0];
  const effectiveDate = nearestDateContext?.collectionDate ?? collectionDate;
  if (effectiveDate.kind === 'missing') reasons.push('missing-collection-date');
  if (nearestDateContext?.ambiguous) reasons.push('ambiguous-date');
  return {
    id: first?.id ?? `row-${order}`,
    order,
    panelLabel: null,
    sourceText,
    sourceLabel: label,
    sourceValue: proposedValue,
    sourceValueString: rawValue || sourceText,
    sourceUnit: unit,
    sourceReferenceInterval: reference,
    sourceFlag: flagCandidate,
    source: {
      ...source,
      raw: {
        label: first?.text ?? null,
        value: rawValue || null,
        unit: rawUnit,
        referenceInterval: referenceCandidate,
        flag: flagCandidate,
        collectionDate: nearestDateContext?.sourceText ?? null,
      },
    },
    collectionDateContext: nearestDateContext ?? null,
    proposedLabel: label,
    proposedValue,
    proposedUnit: unit,
    proposedReferenceInterval: reference,
    proposedFlag: flagCandidate,
    proposedBiomarkerId: biomarkerId,
    proposedSpecimenType: specimenType,
    collectionDate: effectiveDate,
    reviewReasons: [...new Set(reasons)],
    reviewState: reasons.length === 0 ? 'ready' : 'needs-review',
    decision: defaultExtractionDecision([...new Set(reasons)]),
  };
}

export function revalidateExtractionRow(
  row: ExtractionDraftRow,
  patch: ExtractionDraftRowPatch,
  aliases: readonly ExtractionAliasEntry[],
): ExtractionDraftRow {
  const next = { ...row, ...patch, source: row.source, sourceValue: row.sourceValue };
  const reasons = new Set<ExtractionReviewReason>();
  if (!next.proposedLabel.trim()) reasons.add('missing-label');
  if (!next.sourceValueString.trim()) reasons.add('missing-value');
  if (next.proposedValue.kind === 'free_text' && !next.proposedValue.value.trim())
    reasons.add('unparseable-value');
  const aliasMatches = findAliasMatches(next.sourceText, aliases);
  const aliasMatch = aliasMatches[0] ?? null;
  const hasSiblingAlias = new Set(aliasMatches.map((match) => match.id)).size > 1;
  const unsafeMatch = findUnsafeBiomarkerLabel(
    next.sourceText,
    aliases,
    next.proposedBiomarkerId ?? aliasMatch?.id,
  );
  const globalUnsafeMatch =
    aliasMatch === null ? findUnsafeBiomarkerLabel(next.sourceText, aliases) : null;
  const sourceValues = analyzeSourceValues(next.sourceText);
  const id =
    unsafeMatch === null && globalUnsafeMatch === null && !hasSiblingAlias
      ? next.proposedBiomarkerId
      : null;
  if (id === null) reasons.add('unsupported-alias');
  if (unsafeMatch !== null || globalUnsafeMatch !== null || hasSiblingAlias)
    reasons.add('ambiguous-assay');
  else if (!methodCompatible(next.sourceText, id, aliases)) reasons.add('incompatible-method');
  if (
    sourceValues.valueCandidates.length > 1 ||
    sourceValues.effectiveReferences.length > 1 ||
    hasSiblingAlias
  )
    reasons.add('unsupported-layout');
  if (!unitCompatible(next.proposedUnit, id, aliases)) reasons.add('incompatible-unit');
  if (requiresNumericUnit(next.proposedValue, next.proposedUnit)) reasons.add('missing-unit');
  if (!specimenCompatible(next.proposedSpecimenType, id, aliases))
    reasons.add('incompatible-specimen');
  if (next.collectionDate.kind === 'missing') reasons.add('missing-collection-date');
  if (next.collectionDateContext?.ambiguous) reasons.add('ambiguous-date');
  if (next.proposedReferenceInterval !== null && next.proposedReferenceInterval !== '') {
    if (parseReferenceInterval(next.proposedReferenceInterval) === null)
      reasons.add('unparseable-reference-interval');
  }
  const reviewReasons = [...reasons];
  const wasExplicitlySkipped = row.decision === 'skip' && patch.decision === undefined;
  return {
    ...next,
    proposedBiomarkerId: id,
    reviewReasons,
    reviewState: reasons.size === 0 ? 'ready' : 'needs-review',
    decision:
      patch.decision ?? (wasExplicitlySkipped ? 'skip' : defaultExtractionDecision(reviewReasons)),
  };
}

export function buildExtractionConfirmationPlan(
  draft: ExtractionDraft,
  ids: {
    readonly record: (key: string) => string;
    readonly measurement: (rowId: string) => string;
  },
): ExtractionConfirmationPlan {
  if (draft.state !== 'draft') throw new Error('Extraction Draft has already been confirmed');
  type PlannedRecord = {
    id: string;
    collectionDate: LabDateState;
    specimenType: SpecimenType;
    measurements: Array<ExtractionConfirmationPlan['records'][number]['measurements'][number]>;
  };
  const groups = new Map<string, PlannedRecord>();
  for (const row of draft.rows) {
    if (extractionReviewBlocksConfirmation(row))
      throw new Error('An extraction row has unresolved required fields');
    if (row.decision === 'skip') continue;
    const key = `${row.collectionDate.kind === 'known' ? row.collectionDate.value : 'missing'}|${row.proposedSpecimenType}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        id: ids.record(key),
        collectionDate: row.collectionDate,
        specimenType: row.proposedSpecimenType,
        measurements: [],
      };
      groups.set(key, group);
    }
    group.measurements.push({
      id: ids.measurement(row.id),
      biomarkerId: row.proposedBiomarkerId,
      panelLabel: row.panelLabel,
      label: row.proposedLabel.trim() || row.sourceLabel,
      value: row.proposedValue,
      valueString:
        row.proposedValue.kind === 'numeric'
          ? String(row.proposedValue.value)
          : row.proposedValue.kind === 'bounded'
            ? `${row.proposedValue.comparator}${row.proposedValue.value}`
            : row.proposedValue.value,
      unit: row.proposedUnit,
      referenceInterval: row.proposedReferenceInterval,
      flag: row.proposedFlag,
      source: row.source,
      original: {
        label: row.sourceLabel,
        value: row.sourceValue,
        valueString: row.sourceValueString,
        unit: row.sourceUnit,
        referenceInterval: row.sourceReferenceInterval,
        flag: row.sourceFlag,
      },
      sourceRowId: row.id,
      reviewState: row.reviewState === 'ready' ? 'confirmed' : 'needs-review',
      provenance:
        row.proposedLabel !== row.sourceLabel ||
        JSON.stringify(row.proposedValue) !== JSON.stringify(row.sourceValue) ||
        row.proposedUnit !== row.sourceUnit ||
        row.proposedReferenceInterval !== row.sourceReferenceInterval ||
        row.proposedFlag !== row.sourceFlag
          ? 'user-corrected'
          : 'extracted',
    });
  }
  return { draftId: draft.id, reportId: draft.reportId, records: [...groups.values()] };
}
