import type { CanonicalId } from './index';
import { parseLocaleDecimal } from './labs';
import type {
  LabSourceArtifact,
  MeasurementSnapshot,
  MeasurementValue,
  SpecimenType,
  LabDateState,
} from './labs';
import { normalizeAlias } from './text';

export { normalizeAlias } from './text';

export const VISION_OCR_LEGACY_CONTRACT_VERSION = 'alyte.vision.document.v2' as const;
export const VISION_OCR_CONTRACT_VERSION = 'alyte.vision.document.v3' as const;
export const EXTRACTION_PARSER_VERSION = 'alyte.local-parser.v7' as const;
/**
 * The physical-row grouping contract is deliberately independent from the parser version.  The
 * geometry/token-lattice work can advance this seam in a later phase without making a parser
 * version look current by accident.
 */
export const EXTRACTION_ROW_SEGMENTATION_VERSION = 'alyte.row-segmentation.v2' as const;

export const EXTRACTION_PIPELINE_FINGERPRINT_SCHEMA =
  'alyte.extraction-pipeline-fingerprint.v1' as const;

export type ExtractionPipelineFingerprintInput = {
  readonly sourceHash: string | null;
  readonly ocrContractVersion: string | null;
  readonly rowSegmentationVersion: string | null;
  readonly parserVersion: string | null;
  readonly semanticAdapterVersion: string | null;
  readonly semanticSchemaVersion: ExtractionSemanticSchemaVersion | null;
  readonly semanticChunkVersion: string | null;
  readonly semanticPromptVersion: string | null;
  readonly modelVersion: string | null;
  readonly runtimeVersion: string | null;
  readonly catalogueVersion: string | null;
};

export type ExtractionPipelineFingerprint = ExtractionPipelineFingerprintInput & {
  readonly schemaVersion: typeof EXTRACTION_PIPELINE_FINGERPRINT_SCHEMA;
  /** Monotonic extraction revision for one report; a full reprocess increments it. */
  readonly revision: number;
  /** Stable identity of the complete compatibility input, not a source-data hash. */
  readonly hash: string;
};

/**
 * Keep fingerprint serialization independent of object insertion order. The digest is a stable
 * compatibility identity; the Original Report's SHA-256 remains the authoritative artifact hash.
 */
export function extractionPipelineFingerprintCanonicalJson(
  input: ExtractionPipelineFingerprintInput,
): string {
  return JSON.stringify({
    sourceHash: input.sourceHash,
    ocrContractVersion: input.ocrContractVersion,
    rowSegmentationVersion: input.rowSegmentationVersion,
    parserVersion: input.parserVersion,
    semanticAdapterVersion: input.semanticAdapterVersion,
    semanticSchemaVersion: input.semanticSchemaVersion,
    semanticChunkVersion: input.semanticChunkVersion,
    semanticPromptVersion: input.semanticPromptVersion,
    modelVersion: input.modelVersion,
    runtimeVersion: input.runtimeVersion,
    catalogueVersion: input.catalogueVersion,
  });
}

/**
 * A small dependency-free digest makes the fingerprint usable in domain and mobile tests without
 * importing Node or a provider runtime. It is intentionally not used for artifact integrity.
 */
function extractionFingerprintDigest(value: string): string {
  const seeds = [2166136261, 2246822519, 3266489917, 668265263] as const;
  return seeds
    .map((seed) => {
      let hash: number = seed;
      for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}

export function createExtractionPipelineFingerprint(
  input: ExtractionPipelineFingerprintInput,
  revision = 1,
): ExtractionPipelineFingerprint {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Extraction pipeline revision must be a positive integer');
  }
  const canonical = extractionPipelineFingerprintCanonicalJson(input);
  return {
    schemaVersion: EXTRACTION_PIPELINE_FINGERPRINT_SCHEMA,
    revision,
    ...input,
    hash: extractionFingerprintDigest(canonical),
  };
}

export function classifyExtractionPipelineFingerprint(
  stored: ExtractionPipelineFingerprint | null | undefined,
  current: ExtractionPipelineFingerprint,
): 'current' | 'older' {
  return stored !== null && stored !== undefined && stored.hash === current.hash
    ? 'current'
    : 'older';
}

export function extractionDraftHasUserEdits(
  rows: readonly Pick<ExtractionDraftRow, 'editState'>[],
): boolean {
  return rows.some((row) => row.editState === 'user-edited');
}

export function extractionDraftHasUnknownEdits(
  rows: readonly Pick<ExtractionDraftRow, 'editState'>[],
): boolean {
  return rows.some((row) => row.editState === 'legacy-unknown');
}

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

export type VisionTokenSpan = {
  readonly id: string;
  readonly parentObservationId: string;
  /** Inclusive UTF-16 code-unit offset into the parent observation text. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset into the parent observation text. */
  readonly end: number;
  /** Exact parent substring; never normalized or translated. */
  readonly text: string;
  readonly boundingBox: NormalizedBoundingBox;
};

/** Span provenance attached to a geometry-derived source cell. */
export type VisionSourceSpan = VisionTokenSpan & {
  /** Retained so a persisted cell can be checked against its complete OCR parent after reopen. */
  readonly parentText: string;
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
  /** Token spans are present only for OCR v3 observations. */
  readonly spans?: readonly VisionTokenSpan[];
  /** Local geometry adapter provenance; native OCR never authors this field. */
  readonly sourceSpan?: VisionSourceSpan;
  /** Internal routing metadata. Never render this as a user-facing accuracy percentage. */
  readonly recognition: {
    readonly level: 'fast' | 'accurate';
    readonly language: string | null;
    readonly internalConfidence: number | null;
  };
};

export type VisionOCRResult = {
  readonly contractVersion:
    typeof VISION_OCR_LEGACY_CONTRACT_VERSION | typeof VISION_OCR_CONTRACT_VERSION;
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
    readonly schemaVersion: ExtractionSemanticSchemaVersion;
    readonly sourceObservationIds: readonly string[];
    /** Exact source cells selected for deterministic field parsing. */
    readonly sourceFieldObservationIds?: ExtractionSemanticFieldSelection;
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

export type ExtractionSemanticSchemaVersion =
  'alyte.semantic-mapper.v1' | 'alyte.semantic-mapper.v2';

/** Exact source observations selected for deterministic field parsing. */
export type ExtractionSemanticFieldSelection = {
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
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
  'defaulted-collection-date',
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

/** A defaulted local collection day is useful for grouping but does not require correction. */
export function extractionReviewHasOnlyNonBlockingReasons(
  reasons: readonly ExtractionReviewReason[],
): boolean {
  return reasons.length === 0 || reasons.every((reason) => reason === 'defaulted-collection-date');
}

function defaultExtractionDecision(
  reasons: readonly ExtractionReviewReason[],
): ExtractionRowDecision {
  return reasons.some((reason) => AUTO_EXCLUDED_EXTRACTION_REVIEW_REASONS.has(reason))
    ? 'skip'
    : extractionReviewHasOnlyNonBlockingReasons(reasons)
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
  /** Independent from the pipeline status so a rerun can never silently erase a correction. */
  /** Optional only for in-memory legacy callers; persisted rows always decode this field. */
  readonly editState?: 'automatic' | 'user-edited' | 'legacy-unknown';
};

export type ExtractionDraft = {
  readonly id: string;
  readonly reportId: string;
  readonly state: 'draft' | 'confirmed' | 'failed';
  /** Stored values remain readable across parser releases; compatibility is surfaced separately. */
  readonly ocrContractVersion: string;
  readonly parserVersion: string;
  readonly pipelineFingerprint: ExtractionPipelineFingerprint | null;
  readonly pipelineStatus: 'current' | 'older';
  readonly revision: number;
  readonly hasUserEdits: boolean;
  readonly hasUnknownEdits?: boolean;
  readonly sourceArtifact?: LabSourceArtifact | null;
  readonly collectionDate: LabDateState;
  readonly rows: readonly ExtractionDraftRow[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
};

export type ExtractionAliasEntry = {
  readonly id: string;
  /** Checked-in English display label; never model-authored or source provenance. */
  readonly canonicalLabel?: string;
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
  readonly sourceFields?: ExtractionSemanticFieldSelection;
  readonly proposedBiomarkerId: CanonicalId | null;
  readonly proposedSpecimenType?: SpecimenType | 'other';
  readonly role?: 'measurement' | 'preserve' | 'specimen-context' | 'ignore';
};

/**
 * A deterministic Vision/table/geometry group supplied to the semantic mapper. The row ID is
 * internal bookkeeping; the production wire contract addresses cells through compact row/cell
 * keys and expands accepted selections back to the complete sourceObservationIds array locally.
 * Keeping cells nested under a row prevents one physical result becoming an unrelated OCR wall.
 */
export type ExtractionSemanticCandidateRow = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly observations: readonly VisionTextObservation[];
};

/**
 * The one compact key mapping shared by the production serializer and response validator. The
 * row sort and observation order are deterministic so a response cannot address a different
 * physical cell merely because one side of the contract assigned keys differently.
 */
export type ExtractionSemanticWireRow = {
  readonly row: ExtractionSemanticCandidateRow;
  readonly rowKey: string;
  readonly cellIds: ReadonlyMap<string, string>;
};

export function mapExtractionSemanticWireRows(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): readonly ExtractionSemanticWireRow[] {
  return candidateRows
    .slice()
    .sort((left, right) => left.rowId.localeCompare(right.rowId))
    .map((row, rowIndex) => ({
      row,
      rowKey: `r${rowIndex}`,
      cellIds: new Map(row.observations.map((observation, index) => [`c${index}`, observation.id])),
    }));
}

export type ExtractionSemanticProvenance = NonNullable<ExtractionSourceLocation['semantic']>;

/**
 * Ownership token for one extraction's use of a semantic runtime. The mapper may share the
 * underlying loaded model across extractions, but each successful prepare must release exactly
 * its own lease.
 */
export type ExtractionSemanticLease = {
  readonly release: () => Promise<void>;
};

/**
 * Cancellation owned by one extraction operation. Subscribers are removed when their model
 * request settles, so a late cancellation from an older operation cannot reach a later request.
 */
export type ExtractionSemanticCancellation = {
  readonly isCancelled: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
};

export interface ExtractionSemanticMapper {
  readonly adapterVersion: string;
  readonly schemaVersion: ExtractionSemanticSchemaVersion;
  /** Maximum number of deterministic candidate rows in one model request. */
  readonly maxRowsPerChunk?: number;
  /** Maximum OCR observations in one model request, including every cell in those rows. */
  readonly maxObservationsPerChunk?: number;
  /** Checks the verified pack before OCR. Post-OCR failures must fall back to deterministic rows. */
  readonly checkAvailability?: () => Promise<void>;
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
    readonly cancellation?: ExtractionSemanticCancellation;
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
      row.sourceObservationIds.length > 24 ||
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
  const wireRows = mapExtractionSemanticWireRows(candidateRows);
  const wireRowsByKey = new Map(wireRows.map((item) => [item.rowKey, item]));
  const parsed = proposals.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const value = item as Record<string, unknown>;
    const compact = typeof value.rowKey === 'string';
    const allowedKeys = compact
      ? new Set([
          'rowKey',
          'labelKey',
          'valueKey',
          'unitKey',
          'referenceIntervalKey',
          'flagKey',
          'biomarkerId',
          'role',
          'specimenType',
        ])
      : new Set([
          'sourceObservationIds',
          'proposedBiomarkerId',
          'biomarkerId',
          'proposedSpecimenType',
          'specimenType',
          'role',
        ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return [];
    let row: ExtractionSemanticCandidateRow | undefined;
    let sourceObservationIds: string[];
    let sourceFields: ExtractionSemanticFieldSelection | undefined;
    if (compact) {
      if (
        typeof value.rowKey !== 'string' ||
        !/^r(?:0|[1-9]\d*)$/u.test(value.rowKey) ||
        value.labelKey === undefined ||
        value.valueKey === undefined ||
        value.unitKey === undefined ||
        value.referenceIntervalKey === undefined ||
        value.flagKey === undefined
      )
        return [];
      const wireRow = wireRowsByKey.get(value.rowKey);
      if (wireRow === undefined) return [];
      row = wireRow.row;
      const sourceIdForKey = (key: unknown, required: boolean): string | null | undefined => {
        if (key === null) return required ? undefined : null;
        if (typeof key !== 'string' || !/^c(?:0|[1-9]\d*)$/u.test(key)) return undefined;
        return wireRow.cellIds.get(key);
      };
      const label = sourceIdForKey(value.labelKey, true);
      const selectedValue = sourceIdForKey(value.valueKey, true);
      const unit = sourceIdForKey(value.unitKey, false);
      const referenceInterval = sourceIdForKey(value.referenceIntervalKey, false);
      const flag = sourceIdForKey(value.flagKey, false);
      if (
        label === undefined ||
        selectedValue === undefined ||
        unit === undefined ||
        referenceInterval === undefined ||
        flag === undefined
      )
        return [];
      if (typeof label !== 'string' || typeof selectedValue !== 'string') return [];
      const selected = [label, selectedValue, unit, referenceInterval, flag].filter(
        (item): item is string => item !== null,
      );
      if (new Set(selected).size !== selected.length || label === selectedValue) return [];
      sourceObservationIds = [...row.sourceObservationIds];
      sourceFields = {
        label,
        value: selectedValue,
        unit,
        referenceInterval,
        flag,
      };
    } else {
      if (!Array.isArray(value.sourceObservationIds)) return [];
      sourceObservationIds = value.sourceObservationIds as string[];
    }
    if (value.proposedBiomarkerId !== undefined && value.biomarkerId !== undefined) return [];
    if (value.proposedSpecimenType !== undefined && value.specimenType !== undefined) return [];
    if (sourceObservationIds.some((id) => typeof id !== 'string')) return [];
    if (
      sourceObservationIds.length === 0 ||
      sourceObservationIds.length > (compact ? 24 : 8) ||
      sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
      new Set(sourceObservationIds).size !== sourceObservationIds.length ||
      !sourceObservationIds.every((id) => sourceById.has(id))
    )
      return [];
    row ??= rowBySourceIds.get(JSON.stringify(sourceObservationIds));
    // The model must copy the complete row ID array, including order. A partial, cross-row,
    // reordered, or extra-ID proposal is rejected rather than inferred or repaired.
    if (row === undefined) return [];
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
            value.role === 'preserve' ||
            value.role === 'specimen-context' ||
            value.role === 'ignore'
          ? value.role
          : null;
    if (role === null) return [];
    // A model cannot prove that a physical OCR row is not a Measurement. Keep this role in the
    // legacy decoder for compatibility, but make production semantics an explicit no-op.
    if (role === 'ignore') return [];
    if (role === 'measurement' && proposedBiomarkerId === null) return [];
    if (role !== undefined && role !== 'measurement' && proposedBiomarkerId !== null) return [];
    if (compact && (role === 'measurement' || role === 'preserve') && sourceFields === undefined)
      return [];
    const proposal: ExtractionSemanticProposal = {
      sourceObservationIds,
      ...(sourceFields === undefined ? {} : { sourceFields }),
      proposedBiomarkerId,
      ...(proposedSpecimenType === undefined ? {} : { proposedSpecimenType }),
      ...(role === undefined ? {} : { role }),
    };
    if (proposal.proposedBiomarkerId !== null && !biomarkerIds.has(proposal.proposedBiomarkerId))
      return [];
    return [{ proposal, rowId: row.rowId }];
  });
  // A malformed proposal is discarded independently, while duplicate proposals for one physical
  // row are all rejected. This keeps good rows useful without allowing ambiguous output to win by
  // array order.
  const counts = new Map<string, number>();
  for (const item of parsed) counts.set(item.rowId, (counts.get(item.rowId) ?? 0) + 1);
  return parsed.filter((item) => counts.get(item.rowId) === 1).map((item) => item.proposal);
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
  readonly decision?: ExtractionRowDecision;
};

type SemanticRevalidationOptions = {
  readonly sourceFields?: ExtractionSemanticFieldSelection;
  /** Internal group-date update seam; collection dates are never a per-row public patch. */
  readonly collectionDate?: LabDateState;
  /** False means a user supplied group date has replaced an app fallback. */
  readonly collectionDateDefaulted?: boolean;
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
  const contractVersion =
    value.contractVersion === VISION_OCR_CONTRACT_VERSION
      ? VISION_OCR_CONTRACT_VERSION
      : value.contractVersion === VISION_OCR_LEGACY_CONTRACT_VERSION
        ? VISION_OCR_LEGACY_CONTRACT_VERSION
        : null;
  if (contractVersion === null) throw new Error('Unsupported Vision OCR contract version');
  const pageIndex = finiteInteger(value.pageIndex, 'Vision OCR page index', 0);
  const orientation = finiteInteger(value.orientation ?? 0, 'Vision OCR orientation', -360, 360);
  if (!Array.isArray(value.observations)) throw new Error('Vision OCR observations are missing');
  return {
    contractVersion,
    pageIndex,
    orientation,
    observations: value.observations.map((item, index) =>
      decodeObservation(item, index, pageIndex, orientation, contractVersion),
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
  contractVersion: typeof VISION_OCR_LEGACY_CONTRACT_VERSION | typeof VISION_OCR_CONTRACT_VERSION,
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
  const id =
    typeof value.id === 'string' && value.id.length > 0
      ? value.id
      : `observation-${pageIndex}-${index}`;
  const spans =
    contractVersion === VISION_OCR_CONTRACT_VERSION
      ? decodeVisionTokenSpans(value.spans, text, id, index)
      : undefined;
  return {
    id,
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
    ...(spans === undefined ? {} : { spans }),
    ...(value.sourceSpan === undefined
      ? {}
      : { sourceSpan: decodeVisionSourceSpan(value.sourceSpan, text, id, index) }),
    recognition: { level, language, internalConfidence },
  };
}

function decodeVisionTokenSpans(
  input: unknown,
  parentText: string,
  parentId: string,
  observationIndex: number,
): readonly VisionTokenSpan[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 128)
    throw new Error(`Vision OCR observation ${observationIndex} has invalid token spans`);
  const spans = input.map((item, index) => {
    if (typeof item !== 'object' || item === null)
      throw new Error(`Vision OCR observation ${observationIndex} has invalid token span`);
    const value = item as Record<string, unknown>;
    const start = finiteInteger(value.start, 'Vision OCR token span start', 0, parentText.length);
    const end = finiteInteger(value.end, 'Vision OCR token span end', 0, parentText.length);
    if (start >= end)
      throw new Error(`Vision OCR observation ${observationIndex} has invalid token span`);
    const text = typeof value.text === 'string' ? value.text : '';
    if (text !== parentText.slice(start, end))
      throw new Error(`Vision OCR observation ${observationIndex} has non-exact token span`);
    const parentObservationId =
      typeof value.parentObservationId === 'string' ? value.parentObservationId : null;
    if (parentObservationId !== parentId)
      throw new Error(`Vision OCR observation ${observationIndex} has invalid token parent`);
    const rawBox = value.boundingBox;
    if (typeof rawBox !== 'object' || rawBox === null)
      throw new Error(`Vision OCR observation ${observationIndex} has invalid token bounding box`);
    const box = rawBox as Record<string, unknown>;
    const boundingBox = {
      x: finiteNumber(box.x, 'Vision OCR token bounding-box x'),
      y: finiteNumber(box.y, 'Vision OCR token bounding-box y'),
      width: finiteNumber(box.width, 'Vision OCR token bounding-box width'),
      height: finiteNumber(box.height, 'Vision OCR token bounding-box height'),
    };
    if (
      boundingBox.x < 0 ||
      boundingBox.y < 0 ||
      boundingBox.width <= 0 ||
      boundingBox.height <= 0 ||
      boundingBox.x + boundingBox.width > 1.000001 ||
      boundingBox.y + boundingBox.height > 1.000001
    )
      throw new Error(`Vision OCR observation ${observationIndex} has invalid token bounding box`);
    const id =
      typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : `${parentId}-span-${start}-${end}`;
    return { id, parentObservationId, start, end, text, boundingBox, index };
  });
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const ids = new Set<string>();
  let priorEnd = -1;
  for (const span of ordered) {
    if (ids.has(span.id) || span.start < priorEnd)
      throw new Error(`Vision OCR observation ${observationIndex} has overlapping token spans`);
    ids.add(span.id);
    priorEnd = span.end;
  }
  return ordered.map(({ index: _index, ...span }) => span);
}

function decodeVisionSourceSpan(
  input: unknown,
  cellText: string,
  cellId: string,
  observationIndex: number,
): VisionSourceSpan {
  if (typeof input !== 'object' || input === null)
    throw new Error(`Vision OCR observation ${observationIndex} has invalid source span`);
  const value = input as Record<string, unknown>;
  const parentText = typeof value.parentText === 'string' ? value.parentText : null;
  const parentObservationId =
    typeof value.parentObservationId === 'string' ? value.parentObservationId : null;
  if (parentText === null || parentObservationId === null)
    throw new Error(`Vision OCR observation ${observationIndex} has invalid source span`);
  const start = finiteInteger(value.start, 'Vision source span start', 0, parentText.length);
  const end = finiteInteger(value.end, 'Vision source span end', 0, parentText.length);
  if (start >= end || parentText.slice(start, end) !== cellText)
    throw new Error(`Vision OCR observation ${observationIndex} has non-exact source span`);
  const rawBox = value.boundingBox;
  if (typeof rawBox !== 'object' || rawBox === null)
    throw new Error(`Vision OCR observation ${observationIndex} has invalid source span box`);
  const box = rawBox as Record<string, unknown>;
  const boundingBox = {
    x: finiteNumber(box.x, 'Vision source span bounding-box x'),
    y: finiteNumber(box.y, 'Vision source span bounding-box y'),
    width: finiteNumber(box.width, 'Vision source span bounding-box width'),
    height: finiteNumber(box.height, 'Vision source span bounding-box height'),
  };
  if (
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width <= 0 ||
    boundingBox.height <= 0 ||
    boundingBox.x + boundingBox.width > 1.000001 ||
    boundingBox.y + boundingBox.height > 1.000001
  )
    throw new Error(`Vision OCR observation ${observationIndex} has invalid source span box`);
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `${cellId}-source-span`,
    parentObservationId,
    start,
    end,
    text: cellText,
    boundingBox,
    parentText,
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
  const normalized = input
    .trim()
    .replace(/μ/gu, 'µ')
    .replace(/\s*\/\s*/gu, '/')
    .replace(/\s+/gu, ' ');
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
    'l/l': 'L/L',
  };
  return aliases[lower] ?? normalized;
}

/**
 * Unit-shaped OCR tokens are bounded on both sides so a shorter known unit cannot be selected
 * from inside a longer one (`mg/L` must not become `g/L`, and `mIU/L` must not become `IU/L`).
 * Slash-separated tokens are accepted even when they are not in the catalogue; compatibility
 * remains a separate deterministic validation step and the exact token stays in source.raw.
 */
const UNIT_TOKEN_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:%|fL|[\p{L}\p{M}\p{N}µμ⁰¹²³⁴⁵⁶⁷⁸⁹^+−_.-]+(?:\s*/\s*[\p{L}\p{M}\p{N}µμ⁰¹²³⁴⁵⁶⁷⁸⁹^+−_.-]+)+)(?![\p{L}\p{N}])`,
  'giu',
);

function extractUnitToken(
  sourceText: string,
  valueCandidates: readonly { readonly start: number; readonly end: number }[],
): string | null {
  const candidates = [...sourceText.matchAll(UNIT_TOKEN_PATTERN)]
    .map((match) => ({
      raw: match[0] ?? '',
      start: match.index ?? 0,
      end: (match.index ?? 0) + (match[0]?.length ?? 0),
    }))
    // A date or ratio made only of numbers is not a unit. A valid unfamiliar unit must contain
    // at least one letter/symbol, while the complete token may still contain numeric exponents.
    .filter(
      (candidate) =>
        (candidate.raw === '%' || /[\p{L}\p{M}µμ]/u.test(candidate.raw)) &&
        // Hyphenated slash tokens are common assay/method labels such as LC-MS/MS, not units.
        !/[\p{L}]-[\p{L}]/u.test(candidate.raw),
    );
  const value = valueCandidates.length === 1 ? valueCandidates[0] : undefined;
  candidates.sort((left, right) => {
    if (value !== undefined) {
      const distance = (candidate: typeof left) =>
        candidate.start >= value.end
          ? { distance: candidate.start - value.end, after: 0 }
          : candidate.end <= value.start
            ? { distance: value.start - candidate.end, after: 1 }
            : { distance: 0, after: 0 };
      const leftDistance = distance(left);
      const rightDistance = distance(right);
      return (
        leftDistance.distance - rightDistance.distance ||
        leftDistance.after - rightDistance.after ||
        left.start - right.start ||
        right.raw.length - left.raw.length
      );
    }
    return left.start - right.start || right.raw.length - left.raw.length;
  });
  return candidates[0]?.raw ?? null;
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

/**
 * Finds aliases after the same accent/punctuation folding used for exact catalogue lookup. The
 * regex path above is intentionally cheap, but cannot match a normalized `z` against Lithuanian
 * `ž`; token ranges keep the original source offsets and therefore preserve source wording.
 */
function normalizedAliasMatch(
  sourceText: string,
  alias: string,
): { readonly index: number; readonly length: number } | null {
  const target = normalizeAlias(alias);
  if (!target) return null;
  const tokens = [...sourceText.matchAll(/[^\s]+/gu)].map((match) => ({
    text: match[0] ?? '',
    start: match.index ?? 0,
  }));
  for (let start = 0; start < tokens.length; start += 1) {
    const parts: string[] = [];
    for (let end = start; end < tokens.length; end += 1) {
      const normalized = normalizeAlias(tokens[end]?.text ?? '');
      if (!normalized) continue;
      parts.push(normalized);
      const candidate = parts.join(' ');
      if (candidate === target) {
        const first = tokens[start];
        const last = tokens[end];
        if (first === undefined || last === undefined) return null;
        return {
          index: first.start,
          length: last.start + last.text.length - first.start,
        };
      }
      if (!target.startsWith(`${candidate} `) && !candidate.startsWith(`${target} `)) break;
    }
  }
  return null;
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
      const normalizedMatch =
        match === null || match === undefined ? normalizedAliasMatch(sourceText, alias) : null;
      if (match === null || match === undefined) {
        if (normalizedMatch === null) return [];
        return [
          {
            id: entry.id as CanonicalId,
            text: sourceText.slice(
              normalizedMatch.index,
              normalizedMatch.index + normalizedMatch.length,
            ),
            length: normalizeAlias(alias).length,
            start: normalizedMatch.index,
          },
        ];
      }
      return (() => {
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

type DisplaySuffixPart = {
  readonly kind: 'value' | 'unit' | 'reference' | 'flag';
  readonly expected: MeasurementValue | string | null;
};

function measurementValuesMatch(left: MeasurementValue, right: MeasurementValue): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'numeric' && right.kind === 'numeric') return left.value === right.value;
  if (left.kind === 'bounded' && right.kind === 'bounded') {
    return left.comparator === right.comparator && left.value === right.value;
  }
  return left.kind === 'categorical' && right.kind === 'categorical'
    ? normalizeAlias(left.value) === normalizeAlias(right.value)
    : left.kind === 'free_text' && right.kind === 'free_text'
      ? left.value === right.value
      : false;
}

function numericParts(input: string): readonly MeasurementValue[] {
  return [...input.matchAll(new RegExp(NUMERIC_TOKEN_PATTERN, 'gu'))]
    .map((match) => parseComparatorValue(match[0]?.trim() ?? ''))
    .filter((value): value is MeasurementValue => value !== null);
}

function displaySuffixPartMatches(part: DisplaySuffixPart, actual: string): boolean {
  if (part.kind === 'value' && typeof part.expected !== 'string' && part.expected !== null) {
    const parsed = parseComparatorValue(actual);
    return parsed !== null && measurementValuesMatch(parsed, part.expected);
  }
  if (part.kind === 'reference' && typeof part.expected === 'string') {
    const expected = numericParts(part.expected);
    const actualParts = numericParts(actual);
    return (
      parseReferenceInterval(actual) !== null &&
      expected.length === actualParts.length &&
      expected.every((value, index) => measurementValuesMatch(value, actualParts[index]!))
    );
  }
  if (part.kind === 'unit' && typeof part.expected === 'string') {
    return normalizeUnit(actual) === normalizeUnit(part.expected);
  }
  if (part.kind === 'flag' && typeof part.expected === 'string') {
    return normalizeAlias(actual) === normalizeAlias(part.expected);
  }
  return false;
}

function displaySuffixPrefix(label: string, suffix: readonly DisplaySuffixPart[]): string | null {
  const trimmed = label.trim();
  const consume = (partIndex: number, end: number): string | null => {
    if (partIndex < 0) return trimmed.slice(0, end).trim() || null;
    for (let boundary = end - 1; boundary >= 0; boundary -= 1) {
      if (!/\s/u.test(trimmed[boundary] ?? '')) continue;
      const actual = trimmed.slice(boundary + 1, end).trim();
      if (actual.length > 0 && displaySuffixPartMatches(suffix[partIndex]!, actual)) {
        const prefix = consume(partIndex - 1, boundary + 1);
        if (prefix !== null) return prefix;
      }
    }
    return null;
  };
  return consume(suffix.length - 1, trimmed.length);
}

/**
 * Removes a result-shaped suffix from a proposed display label only when the suffix leaves one
 * uniquely identifiable catalogue alias. The complete selected OCR cell remains in `source` and
 * therefore this helper can never rewrite Original Report provenance.
 */
export function cleanProposedDisplayLabel(
  input: string,
  fields: {
    readonly value: MeasurementValue;
    readonly unit: string | null;
    readonly referenceInterval: string | null;
    readonly flag?: string | null;
  },
  aliases: readonly ExtractionAliasEntry[],
): string {
  const label = input.trim();
  if (label.length === 0) return label;
  const parts = [
    { kind: 'value' as const, expected: fields.value },
    { kind: 'unit' as const, expected: fields.unit },
    { kind: 'reference' as const, expected: fields.referenceInterval },
    { kind: 'flag' as const, expected: fields.flag ?? null },
  ].filter((part) => part.expected !== null && part.expected !== '');
  if (
    parts.length === 0 ||
    parts.every((part) => part.kind !== 'value' && part.kind !== 'reference')
  )
    return label;

  const candidates = new Map<string, string>();
  let longestSuffix = 0;
  const visit = (remaining: readonly DisplaySuffixPart[], suffix: readonly DisplaySuffixPart[]) => {
    if (suffix.length > 0 && suffix.length <= parts.length) {
      // A separator is intentionally limited to whitespace. Punctuation embedded in a source
      // value/range is part of that exact selected cell and must not be guessed away.
      const prefix = displaySuffixPrefix(label, suffix);
      if (prefix !== null) {
        const aliasIds = new Set(findAliasMatches(prefix, aliases).map((item) => item.id));
        if (aliasIds.size === 1) {
          if (suffix.length > longestSuffix) {
            candidates.clear();
            longestSuffix = suffix.length;
          }
          if (suffix.length === longestSuffix) candidates.set(prefix, prefix);
        }
      }
    }
    for (const [index, part] of remaining.entries()) {
      visit([...remaining.slice(0, index), ...remaining.slice(index + 1)], [...suffix, part]);
    }
  };
  visit(parts, []);
  return candidates.size === 1 ? [...candidates.values()][0]! : label;
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
    /** True when the known date is an app-supplied local-day fallback, not source provenance. */
    readonly collectionDateDefaulted?: boolean;
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
        options.collectionDateDefaulted ?? false,
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
  collectionDateDefaulted: boolean,
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
  const rawUnit = extractUnitToken(sourceText, valueCandidates);
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
  else if (collectionDateDefaulted && nearestDateContext === undefined)
    reasons.push('defaulted-collection-date');
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
    reviewState: extractionReviewHasOnlyNonBlockingReasons(reasons) ? 'ready' : 'needs-review',
    decision: defaultExtractionDecision([...new Set(reasons)]),
    editState: 'automatic',
  };
}

function selectedObservationText(row: ExtractionDraftRow, id: string | null): string | null {
  if (id === null) return null;
  return row.source.observations?.find((observation) => observation.id === id)?.text.trim() ?? null;
}

const CATEGORICAL_VALUE_PATTERN =
  /^(?:not detected|positive|negative|detected|normal|abnormal|teigiamas|neigiamas|aptikta|neaptikta|positiv|negativ)$/iu;

function parseSelectedMeasurementValue(input: string): MeasurementValue | null {
  const value = input.trim();
  if (CATEGORICAL_VALUE_PATTERN.test(value)) return { kind: 'categorical', value };
  // A selected value must be a complete scalar cell. In particular, do not accept a numeric
  // prefix from a cell that also contains a unit, reference range, date, or metadata text.
  if (!new RegExp(`^${NUMERIC_TOKEN_PATTERN}\\s*$`, 'u').test(value)) return null;
  const parsed = parseComparatorValue(value);
  return parsed?.kind === 'numeric' || parsed?.kind === 'bounded' ? parsed : null;
}

/**
 * Rebuilds source-shaped fields from the exact OCR cells selected by the semantic mapper. The
 * complete source row, raw fields, and every OCR observation remain untouched; only the proposed
 * parsed projection is replaced. A missing/invalid selection is rejected instead of falling back
 * to the broad concatenated row.
 */
export function reparseExtractionRowFromSemanticFields(
  row: ExtractionDraftRow,
  sourceFields: ExtractionSemanticFieldSelection,
  aliases: readonly ExtractionAliasEntry[],
): ExtractionDraftRow {
  const label = selectedObservationText(row, sourceFields.label);
  const value = selectedObservationText(row, sourceFields.value);
  const unit = selectedObservationText(row, sourceFields.unit);
  const referenceInterval = selectedObservationText(row, sourceFields.referenceInterval);
  const flag = selectedObservationText(row, sourceFields.flag);
  if (label === null || value === null) throw new Error('semantic-source-field-missing');
  const sourceCellIndex = (id: string | null): number | null => {
    if (id === null) return null;
    const index = row.source.observations?.findIndex((observation) => observation.id === id) ?? -1;
    return index < 0 ? null : index;
  };
  const labelIndex = sourceCellIndex(sourceFields.label);
  const valueIndex = sourceCellIndex(sourceFields.value);
  const unitIndex = sourceCellIndex(sourceFields.unit);
  const referenceIndex = sourceCellIndex(sourceFields.referenceInterval);
  const selectedIndexes = [
    labelIndex,
    valueIndex,
    unitIndex,
    referenceIndex,
    sourceCellIndex(sourceFields.flag),
  ].filter((index): index is number => index !== null);
  // Cell order is a layout detail, not a semantic invariant. Same-row membership is already
  // guaranteed by selectedObservationText; distinct cells remain mandatory to prevent one source
  // token from being silently reused for multiple roles.
  if (
    labelIndex === null ||
    valueIndex === null ||
    new Set(selectedIndexes).size !== selectedIndexes.length
  )
    throw new Error('semantic-source-field-selection-invalid');
  const parsedValue = parseSelectedMeasurementValue(value);
  if (parsedValue === null) throw new Error('semantic-source-value-unparseable');
  if (referenceInterval !== null && parseReferenceInterval(referenceInterval) === null)
    throw new Error('semantic-source-reference-unparseable');
  const next: ExtractionDraftRow = {
    ...row,
    proposedLabel: cleanProposedDisplayLabel(
      label,
      {
        value: parsedValue,
        unit: normalizeUnit(unit),
        referenceInterval,
        flag,
      },
      aliases,
    ),
    proposedValue: parsedValue,
    proposedUnit: normalizeUnit(unit),
    proposedReferenceInterval: referenceInterval,
    proposedFlag: flag,
  };
  return revalidateExtractionRow(next, {}, aliases, { sourceFields });
}

function extractedSnapshotFromSemanticRow(row: ExtractionDraftRow): MeasurementSnapshot | null {
  const fields = row.source.semantic?.sourceFieldObservationIds;
  if (fields === undefined) return null;
  const value = selectedObservationText(row, fields.value);
  const label = selectedObservationText(row, fields.label);
  if (value === null || label === null) return null;
  const parsedValue = parseSelectedMeasurementValue(value);
  if (parsedValue === null) return null;
  return {
    label,
    value: parsedValue,
    valueString: value,
    unit: row.proposedUnit,
    referenceInterval: row.proposedReferenceInterval,
    flag: row.proposedFlag,
  };
}

export function revalidateExtractionRow(
  row: ExtractionDraftRow,
  patch: ExtractionDraftRowPatch,
  aliases: readonly ExtractionAliasEntry[],
  options: SemanticRevalidationOptions = {},
): ExtractionDraftRow {
  const next = {
    ...row,
    ...patch,
    ...(options.collectionDate === undefined ? {} : { collectionDate: options.collectionDate }),
    source: row.source,
    sourceValue: row.sourceValue,
  };
  const reasons = new Set<ExtractionReviewReason>();
  if (!next.proposedLabel.trim()) reasons.add('missing-label');
  if (!next.sourceValueString.trim()) reasons.add('missing-value');
  if (next.proposedValue.kind === 'free_text' && !next.proposedValue.value.trim())
    reasons.add('unparseable-value');
  const aliasMatches = findAliasMatches(
    options.sourceFields === undefined ? next.sourceText : next.proposedLabel,
    aliases,
  );
  const aliasMatch = aliasMatches[0] ?? null;
  const hasSiblingAlias = new Set(aliasMatches.map((match) => match.id)).size > 1;
  const unsafeMatch = findUnsafeBiomarkerLabel(
    next.sourceText,
    aliases,
    next.proposedBiomarkerId ?? aliasMatch?.id,
  );
  const globalUnsafeMatch =
    aliasMatch === null ? findUnsafeBiomarkerLabel(next.sourceText, aliases) : null;
  const sourceValues =
    options.sourceFields === undefined
      ? analyzeSourceValues(next.sourceText)
      : {
          valueCandidates:
            next.proposedValue.kind === 'numeric' || next.proposedValue.kind === 'bounded'
              ? [
                  {
                    raw: selectedObservationText(next, options.sourceFields.value) ?? '',
                    start: 0,
                    end: selectedObservationText(next, options.sourceFields.value)?.length ?? 0,
                    value: next.proposedValue,
                  },
                ]
              : [],
          effectiveReferences:
            next.proposedReferenceInterval === null
              ? []
              : [
                  {
                    raw: next.proposedReferenceInterval,
                    start: 0,
                    end: next.proposedReferenceInterval.length,
                  },
                ],
        };
  const id =
    unsafeMatch === null && globalUnsafeMatch === null && !hasSiblingAlias
      ? next.proposedBiomarkerId
      : null;
  if (id === null) reasons.add('unsupported-alias');
  if (unsafeMatch !== null || globalUnsafeMatch !== null || hasSiblingAlias)
    reasons.add('ambiguous-assay');
  else if (!methodCompatible(next.sourceText, id, aliases)) reasons.add('incompatible-method');
  if (
    options.sourceFields === undefined &&
    (sourceValues.valueCandidates.length > 1 ||
      sourceValues.effectiveReferences.length > 1 ||
      hasSiblingAlias)
  )
    reasons.add('unsupported-layout');
  if (!unitCompatible(next.proposedUnit, id, aliases)) reasons.add('incompatible-unit');
  if (requiresNumericUnit(next.proposedValue, next.proposedUnit)) reasons.add('missing-unit');
  if (!specimenCompatible(next.proposedSpecimenType, id, aliases))
    reasons.add('incompatible-specimen');
  if (next.collectionDate.kind === 'missing') reasons.add('missing-collection-date');
  else if (
    options.collectionDateDefaulted === true ||
    (options.collectionDateDefaulted === undefined &&
      row.reviewReasons.includes('defaulted-collection-date'))
  )
    reasons.add('defaulted-collection-date');
  if (next.collectionDateContext?.ambiguous) reasons.add('ambiguous-date');
  if (next.proposedReferenceInterval !== null && next.proposedReferenceInterval !== '') {
    if (parseReferenceInterval(next.proposedReferenceInterval) === null)
      reasons.add('unparseable-reference-interval');
  }
  const reviewReasons = [...reasons];
  const wasExplicitlySkipped =
    options.sourceFields === undefined && row.decision === 'skip' && patch.decision === undefined;
  return {
    ...next,
    proposedBiomarkerId: id,
    reviewReasons,
    reviewState: extractionReviewHasOnlyNonBlockingReasons(reviewReasons)
      ? 'ready'
      : 'needs-review',
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
    const semanticSnapshot = extractedSnapshotFromSemanticRow(row);
    const original = semanticSnapshot ?? {
      label: row.sourceLabel,
      value: row.sourceValue,
      valueString: row.sourceValueString,
      unit: row.sourceUnit,
      referenceInterval: row.sourceReferenceInterval,
      flag: row.sourceFlag,
    };
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
      original,
      sourceRowId: row.id,
      reviewState: row.reviewState === 'ready' ? 'confirmed' : 'needs-review',
      provenance:
        semanticSnapshot === null &&
        (row.proposedLabel !== row.sourceLabel ||
          JSON.stringify(row.proposedValue) !== JSON.stringify(row.sourceValue) ||
          row.proposedUnit !== row.sourceUnit ||
          row.proposedReferenceInterval !== row.sourceReferenceInterval ||
          row.proposedFlag !== row.sourceFlag)
          ? 'user-corrected'
          : 'extracted',
    });
  }
  return { draftId: draft.id, reportId: draft.reportId, records: [...groups.values()] };
}
