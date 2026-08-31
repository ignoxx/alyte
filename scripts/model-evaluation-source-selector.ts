import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  groupObservationsIntoRows,
  mapExtractionSemanticWireRows,
  reparseExtractionRowFromSemanticFields,
  type ExtractionSemanticCandidateRow,
  type ExtractionSemanticFieldSelection,
  type SpecimenType,
} from '@alyte/domain';
import {
  sourceSelectorCandidateManifests,
  type SourceSelectorCandidate,
  type EvaluationManifest,
} from '../packages/model-evaluation/src/manifest';
import {
  productionAliases,
  productionV2Fixtures,
  PRODUCTION_V2_FIXTURE_VERSION,
  type V2Fixture,
} from './model-evaluation-v2-fixtures';
import { estimateSemanticMapperTokens } from './model-evaluation-production';
import {
  verifyExternalArtifactAgainst,
  type ArtifactVerificationReader,
} from './model-evaluation-prepare';
// @ts-expect-error JavaScript helper intentionally has no generated type surface.
import { assertAggregatePrivacy } from './model-evaluation-aggregate-scrub.mjs';

export const SOURCE_SELECTOR_SCHEMA_VERSION = 'alyte.semantic-source-selector.v1' as const;
export const SOURCE_SELECTOR_CHUNK_VERSION = 'alyte.semantic-source-selector-chunk.v1' as const;
export const SOURCE_SELECTOR_PROMPT_VERSION = 'alyte.semantic-source-selector.prompt.v2' as const;
export const SOURCE_SELECTOR_CONTRACT_VERSION =
  'alyte.semantic-source-selector.contract.v1' as const;

export const SOURCE_SELECTOR_LIMITS = Object.freeze({
  maxRows: 2,
  maxObservations: 24,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxOutputBytes: 8_192,
  maxInputBytes: 8_192,
  maxPromptBytes: 7_168,
  contextWindowTokens: 2_048,
  outputTokenLimit: 256,
  maxRetries: 1,
});
export const SOURCE_SELECTOR_FORMAT_MAX_ENCODED_BYTES = 2_500_000;
const SOURCE_SELECTOR_MAX_BRANCHES = 5_000;

const SELECTOR_FIELDS = Object.freeze([
  'labelKey',
  'valueKey',
  'unitKey',
  'referenceIntervalKey',
  'flagKey',
] as const);
type SelectorField = (typeof SELECTOR_FIELDS)[number];
type FieldAssignment = Readonly<Record<SelectorField, string | null>>;

export type SourceSelectorSelection = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly sourceFields: ExtractionSemanticFieldSelection;
};

export type SourceSelectorValidationFailureCode =
  | 'malformed-envelope'
  | 'oversized-output'
  | 'invalid-selection'
  | 'unknown-row-key'
  | 'unknown-cell-key'
  | 'duplicate-cell'
  | 'duplicate-row';

export type SourceSelectorValidation = {
  readonly selections: readonly SourceSelectorSelection[];
  readonly rejectedRows: readonly ExtractionSemanticCandidateRow[];
  readonly malformedEnvelope: boolean;
  readonly failures: readonly SourceSelectorValidationFailureCode[];
};

export async function verifySourceSelectorArtifact(
  modelPath: string,
  candidate: SourceSelectorCandidate,
  reader?: ArtifactVerificationReader,
): Promise<void> {
  await verifyExternalArtifactAgainst(
    modelPath,
    sourceSelectorCandidateManifests[candidate].model,
    reader,
  );
}

function boundedFailure(code: string): Error {
  return new Error(`model-evaluation-failed:${code}`);
}

function validateCandidateRows(candidateRows: readonly ExtractionSemanticCandidateRow[]): void {
  if (
    candidateRows.length === 0 ||
    candidateRows.length > SOURCE_SELECTOR_LIMITS.maxRows ||
    candidateRows.reduce((count, row) => count + row.observations.length, 0) >
      SOURCE_SELECTOR_LIMITS.maxObservations
  )
    throw boundedFailure('source-selector-input');
  const rowIds = new Set<string>();
  const observationIds = new Set<string>();
  for (const row of candidateRows) {
    if (
      row.rowId.length === 0 ||
      row.rowId.length > 96 ||
      rowIds.has(row.rowId) ||
      row.sourceObservationIds.length === 0 ||
      row.sourceObservationIds.length !== row.observations.length ||
      row.sourceObservationIds.length > SOURCE_SELECTOR_LIMITS.maxObservations ||
      new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length
    )
      throw boundedFailure('source-selector-input');
    rowIds.add(row.rowId);
    row.observations.forEach((observation, index) => {
      const id = row.sourceObservationIds[index];
      if (
        id === undefined ||
        observation.id !== id ||
        id.length === 0 ||
        id.length > 96 ||
        observationIds.has(id) ||
        observation.text.length > SOURCE_SELECTOR_LIMITS.maxObservationTextCharacters ||
        observation.alternatives.some(
          (alternative) => alternative.length > SOURCE_SELECTOR_LIMITS.maxAlternativeCharacters,
        )
      )
        throw boundedFailure('source-selector-input');
      observationIds.add(id);
    });
  }
}

/** Serializes only row-local OCR cells. Source IDs, specimen data, and catalogue IDs stay local. */
export function serializeSourceSelectorChunk(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
  locale: string,
): string {
  validateCandidateRows(candidateRows);
  const rows = mapExtractionSemanticWireRows(candidateRows).map(({ row, rowKey }) => ({
    key: rowKey,
    cells: row.observations.map((observation, index) => ({
      key: `c${index}`,
      text: observation.text,
      alternatives: [...observation.alternatives].sort((left, right) => left.localeCompare(right)),
    })),
  }));
  const result = JSON.stringify({ version: SOURCE_SELECTOR_CHUNK_VERSION, locale, rows });
  if (new TextEncoder().encode(result).byteLength > SOURCE_SELECTOR_LIMITS.maxInputBytes)
    throw boundedFailure('source-selector-input');
  return result;
}

function assignmentsFor(cellKeys: readonly string[]): readonly FieldAssignment[] {
  const assignments: FieldAssignment[] = [];
  const selected: Partial<Record<SelectorField, string | null>> = {};
  const visit = (index: number, used: ReadonlySet<string>) => {
    if (assignments.length > SOURCE_SELECTOR_MAX_BRANCHES)
      throw boundedFailure('source-selector-schema');
    const field = SELECTOR_FIELDS[index];
    if (field === undefined) {
      assignments.push({ ...selected } as FieldAssignment);
      return;
    }
    const choices = cellKeys.filter((key) => !used.has(key));
    if (index >= 2) choices.unshift('');
    for (const choice of choices) {
      const value = index >= 2 && choice === '' ? null : choice;
      selected[field] = value;
      visit(index + 1, value === null ? used : new Set([...used, value]));
      delete selected[field];
    }
  };
  visit(0, new Set());
  return assignments;
}

function assignmentCount(cellCount: number): number {
  if (cellCount < 2) return 0;
  const optional = cellCount - 2;
  let permutation = 1;
  let optionalAssignments = 1;
  for (let selected = 1; selected <= Math.min(3, optional); selected += 1) {
    permutation *= optional - selected + 1;
    optionalAssignments += (selected === 1 ? 3 : selected === 2 ? 3 : 1) * permutation;
  }
  return cellCount * (cellCount - 1) * optionalAssignments;
}

function selectorBranch(rowKey: string, assignment: FieldAssignment) {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['rowKey', ...SELECTOR_FIELDS]),
    properties: Object.freeze({
      rowKey: Object.freeze({ const: rowKey }),
      ...Object.fromEntries(
        SELECTOR_FIELDS.map((field) => [field, Object.freeze({ const: assignment[field] })]),
      ),
    }),
  });
}

/**
 * Builds an evaluator-only schema whose branches are tied to the actual rows and cells in this
 * request. Enumerating bounded assignments is intentional: JSON Schema has no portable way to
 * express cross-property inequality, so duplicate-cell selections fail before model output is
 * accepted. No semantic, specimen, or authoritative fields exist in this schema.
 */
export function createSourceSelectorFormat(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): Readonly<Record<string, unknown>> {
  validateCandidateRows(candidateRows);
  const estimatedBranches = candidateRows.reduce(
    (count, row) => count + assignmentCount(row.observations.length),
    0,
  );
  // Reject before enumerating a pathological report. This keeps both branch count and the
  // eventual encoded grammar bounded, rather than constructing megabytes and checking too late.
  if (
    estimatedBranches === 0 ||
    estimatedBranches > SOURCE_SELECTOR_MAX_BRANCHES ||
    estimatedBranches * 512 > SOURCE_SELECTOR_FORMAT_MAX_ENCODED_BYTES
  )
    throw boundedFailure('source-selector-schema');
  const branches = mapExtractionSemanticWireRows(candidateRows).flatMap(({ row, rowKey }) => {
    const cellKeys = row.observations.map((_, index) => `c${index}`);
    if (cellKeys.length < 2) throw boundedFailure('source-selector-schema');
    return assignmentsFor(cellKeys).map((assignment) => selectorBranch(rowKey, assignment));
  });
  if (branches.length === 0 || branches.length !== estimatedBranches)
    throw boundedFailure('source-selector-schema');
  const format = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['schemaVersion', 'selections']),
    properties: Object.freeze({
      schemaVersion: Object.freeze({ const: SOURCE_SELECTOR_SCHEMA_VERSION }),
      selections: Object.freeze({
        type: 'array',
        maxItems: candidateRows.length,
        items: Object.freeze({ oneOf: Object.freeze(branches) }),
      }),
    }),
  });
  if (
    new TextEncoder().encode(JSON.stringify(format)).byteLength >
    SOURCE_SELECTOR_FORMAT_MAX_ENCODED_BYTES
  )
    throw boundedFailure('source-selector-schema');
  return format;
}

function failure(code: SourceSelectorValidationFailureCode): SourceSelectorValidationFailureCode {
  return code;
}

/** Expands compact row/cell keys locally and rejects every cross-row or duplicate selection. */
export function validateSourceSelectorOutput(
  raw: unknown,
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): SourceSelectorValidation {
  try {
    validateCandidateRows(candidateRows);
  } catch {
    return { selections: [], rejectedRows: candidateRows, malformedEnvelope: true, failures: [] };
  }
  const rejectAll = (code: SourceSelectorValidationFailureCode): SourceSelectorValidation => ({
    selections: [],
    rejectedRows: candidateRows,
    malformedEnvelope: true,
    failures: [failure(code)],
  });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return rejectAll('malformed-envelope');
  const root = raw as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => !['schemaVersion', 'selections'].includes(key)) ||
    root.schemaVersion !== SOURCE_SELECTOR_SCHEMA_VERSION ||
    !Array.isArray(root.selections) ||
    root.selections.length > candidateRows.length
  )
    return rejectAll('malformed-envelope');
  const wireRows = mapExtractionSemanticWireRows(candidateRows);
  const rowsByKey = new Map(wireRows.map((entry) => [entry.rowKey, entry]));
  // Count raw row keys before inspecting fields. A valid-looking duplicate paired with a malformed
  // duplicate must not let the valid half escape into a retry or aggregate score.
  const rawRowKeyCounts = new Map<string, number>();
  for (const item of root.selections) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rowKey = (item as Record<string, unknown>).rowKey;
    if (typeof rowKey === 'string' && /^r(?:0|[1-9]\d*)$/u.test(rowKey))
      rawRowKeyCounts.set(rowKey, (rawRowKeyCounts.get(rowKey) ?? 0) + 1);
  }
  const parsed: SourceSelectorSelection[] = [];
  const failures: SourceSelectorValidationFailureCode[] = [];
  for (const item of root.selections) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      failures.push(failure('invalid-selection'));
      continue;
    }
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['rowKey', ...SELECTOR_FIELDS].includes(key)) ||
      Object.keys(value).length !== SELECTOR_FIELDS.length + 1
    ) {
      failures.push(failure('invalid-selection'));
      continue;
    }
    const rowKey = value.rowKey;
    if (typeof rowKey !== 'string' || !/^r(?:0|[1-9]\d*)$/u.test(rowKey)) {
      failures.push(failure('unknown-row-key'));
      continue;
    }
    const wireRow = rowsByKey.get(rowKey);
    if (wireRow === undefined) {
      failures.push(failure('unknown-row-key'));
      continue;
    }
    if ((rawRowKeyCounts.get(rowKey) ?? 0) > 1) {
      failures.push(failure('duplicate-row'));
      continue;
    }
    const sourceId = (key: unknown, required: boolean): string | null | undefined => {
      if (key === null) return required ? undefined : null;
      if (typeof key !== 'string' || !/^c(?:0|[1-9]\d*)$/u.test(key)) return undefined;
      return wireRow.cellIds.get(key);
    };
    const label = sourceId(value.labelKey, true);
    const selectedValue = sourceId(value.valueKey, true);
    const unit = sourceId(value.unitKey, false);
    const referenceInterval = sourceId(value.referenceIntervalKey, false);
    const flag = sourceId(value.flagKey, false);
    if (
      label === undefined ||
      selectedValue === undefined ||
      unit === undefined ||
      referenceInterval === undefined ||
      flag === undefined ||
      typeof label !== 'string' ||
      typeof selectedValue !== 'string'
    ) {
      failures.push(failure('unknown-cell-key'));
      continue;
    }
    const selected = [label, selectedValue, unit, referenceInterval, flag].filter(
      (id): id is string => id !== null,
    );
    if (new Set(selected).size !== selected.length || label === selectedValue) {
      failures.push(failure('duplicate-cell'));
      continue;
    }
    parsed.push({
      rowId: wireRow.row.rowId,
      sourceObservationIds: [...wireRow.row.sourceObservationIds],
      sourceFields: { label, value: selectedValue, unit, referenceInterval, flag },
    });
  }
  const counts = new Map<string, number>();
  parsed.forEach((selection) =>
    counts.set(selection.rowId, (counts.get(selection.rowId) ?? 0) + 1),
  );
  const duplicateRows = parsed.filter((selection) => counts.get(selection.rowId)! > 1);
  if (duplicateRows.length > 0) failures.push(failure('duplicate-row'));
  const accepted = parsed.filter((selection) => counts.get(selection.rowId) === 1);
  const acceptedRows = new Set(accepted.map((selection) => selection.rowId));
  return {
    selections: accepted,
    rejectedRows: candidateRows.filter((row) => !acceptedRows.has(row.rowId)),
    malformedEnvelope: false,
    failures,
  };
}

function localeFor(language: V2Fixture['language']): string {
  return language === 'de' ? 'de-DE' : language === 'lt' ? 'lt-LT' : 'en-US';
}

type DeterministicMapping = {
  readonly canonicalBiomarkerId: string | null;
  readonly specimenType: SpecimenType;
  /** Parsing succeeded, even when alias/specimen checks intentionally preserve a null mapping. */
  readonly parseSucceeded: boolean;
  readonly reviewRequired: boolean;
};

/** Re-parses exact selected cells through the checked-in production domain parser. */
export function mapSelectedSourceFields(
  fixture: V2Fixture,
  selection: SourceSelectorSelection,
): DeterministicMapping {
  const row = fixture.rows.find((candidate) => candidate.rowId === selection.rowId);
  const sourceSpecimens = new Set(
    row?.sourceObservationIds.flatMap((id) => {
      const observation = fixture.observations.find((candidate) => candidate.id === id);
      return observation === undefined ? [] : [observation.specimenType];
    }) ?? [],
  );
  const specimenType: SpecimenType =
    sourceSpecimens.size === 1 ? [...sourceSpecimens][0]! : 'unknown';
  if (row === undefined) {
    return {
      canonicalBiomarkerId: null,
      specimenType: 'unknown',
      parseSucceeded: false,
      reviewRequired: true,
    };
  }
  try {
    const parsed = groupObservationsIntoRows(row.observations, {
      aliases: productionAliases,
      locale: localeFor(fixture.language),
      specimenType,
      collectionDate: { kind: 'missing' },
    })[0];
    if (parsed === undefined) throw new Error('source-selector-row-parse');
    const reparsed = reparseExtractionRowFromSemanticFields(
      parsed,
      selection.sourceFields,
      productionAliases,
    );
    return {
      canonicalBiomarkerId: reparsed.proposedBiomarkerId,
      specimenType: reparsed.proposedSpecimenType,
      parseSucceeded: true,
      reviewRequired: reparsed.reviewState === 'needs-review',
    };
  } catch {
    // A bad selected value/range remains a preserved review row; no broad-row fallback is allowed.
    return {
      canonicalBiomarkerId: null,
      specimenType,
      parseSucceeded: false,
      reviewRequired: true,
    };
  }
}

type FailureCounts = Readonly<Record<SourceSelectorValidationFailureCode | 'transport', number>>;

type FixtureScore = {
  readonly expectedRows: number;
  readonly selectedRows: number;
  readonly fullFieldRows: number;
  readonly fieldCorrectRows: Readonly<Record<SelectorField, number>>;
  readonly deterministicParseSuccessRows: number;
  readonly supportedExpectedRows: number;
  readonly supportedCorrectMappings: number;
  readonly unsupportedExpectedRows: number;
  readonly unsupportedRowsPreserved: number;
  readonly reviewRows: number;
  readonly failureCounts: FailureCounts;
};

function emptyFailures(): Record<SourceSelectorValidationFailureCode | 'transport', number> {
  return {
    'malformed-envelope': 0,
    'oversized-output': 0,
    'invalid-selection': 0,
    'unknown-row-key': 0,
    'unknown-cell-key': 0,
    'duplicate-cell': 0,
    'duplicate-row': 0,
    transport: 0,
  };
}

function scoreFixture(
  fixture: V2Fixture,
  selections: readonly SourceSelectorSelection[],
  failures: FailureCounts,
): FixtureScore {
  let fullFieldRows = 0;
  let deterministicParseSuccessRows = 0;
  let supportedCorrectMappings = 0;
  let unsupportedRowsPreserved = 0;
  let reviewRows = 0;
  const fieldCorrectRows = Object.fromEntries(SELECTOR_FIELDS.map((field) => [field, 0])) as Record<
    SelectorField,
    number
  >;
  const selectionByRow = new Map(selections.map((selection) => [selection.rowId, selection]));
  for (const expected of fixture.expected) {
    const selection = selectionByRow.get(expected.rowId);
    if (selection === undefined) {
      reviewRows += 1;
      continue;
    }
    const fieldMatches = SELECTOR_FIELDS.map((field) => {
      const expectedField =
        expected.sourceFields[
          field === 'labelKey'
            ? 'label'
            : field === 'valueKey'
              ? 'value'
              : field === 'unitKey'
                ? 'unit'
                : field === 'referenceIntervalKey'
                  ? 'referenceInterval'
                  : 'flag'
        ];
      const actualField =
        selection.sourceFields[
          field === 'labelKey'
            ? 'label'
            : field === 'valueKey'
              ? 'value'
              : field === 'unitKey'
                ? 'unit'
                : field === 'referenceIntervalKey'
                  ? 'referenceInterval'
                  : 'flag'
        ];
      return [field, expectedField === actualField] as const;
    });
    for (const [field, matches] of fieldMatches) if (matches) fieldCorrectRows[field] += 1;
    const fullFields = fieldMatches.every(([, matches]) => matches);
    if (fullFields) fullFieldRows += 1;
    const mapping = mapSelectedSourceFields(fixture, selection);
    if (mapping.parseSucceeded) deterministicParseSuccessRows += 1;
    if (mapping.reviewRequired) reviewRows += 1;
    if (expected.biomarkerId === null) {
      if (fullFields && mapping.canonicalBiomarkerId === null) unsupportedRowsPreserved += 1;
    } else if (
      fullFields &&
      mapping.parseSucceeded &&
      mapping.canonicalBiomarkerId === expected.biomarkerId &&
      mapping.specimenType === expected.specimenType
    ) {
      supportedCorrectMappings += 1;
    }
  }
  const supportedExpectedRows = fixture.expected.filter((item) => item.biomarkerId !== null).length;
  return {
    expectedRows: fixture.expected.length,
    selectedRows: selections.length,
    fullFieldRows,
    fieldCorrectRows,
    deterministicParseSuccessRows,
    supportedExpectedRows,
    supportedCorrectMappings,
    unsupportedExpectedRows: fixture.expected.filter((item) => item.biomarkerId === null).length,
    unsupportedRowsPreserved,
    reviewRows,
    failureCounts: { ...failures },
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0 || !Number.isFinite(numerator)) return 0;
  return Math.min(1, Math.max(0, numerator / denominator));
}

function aggregateScores(scores: readonly FixtureScore[], fixtures: readonly V2Fixture[]) {
  const sum = (key: Exclude<keyof FixtureScore, 'fieldCorrectRows' | 'failureCounts'>): number =>
    scores.reduce((total, score) => total + score[key], 0);
  const failureCounts = emptyFailures();
  for (const score of scores)
    for (const [code, count] of Object.entries(score.failureCounts))
      failureCounts[code as keyof typeof failureCounts] += count;
  const expectedRows = sum('expectedRows');
  const selectedRows = sum('selectedRows');
  const fullFieldRows = sum('fullFieldRows');
  const deterministicParseSuccessRows = sum('deterministicParseSuccessRows');
  const supportedExpectedRows = sum('supportedExpectedRows');
  const supportedCorrectMappings = sum('supportedCorrectMappings');
  const unsupportedExpectedRows = sum('unsupportedExpectedRows');
  const unsupportedRowsPreserved = sum('unsupportedRowsPreserved');
  const reviewRows = sum('reviewRows');
  const fieldCorrectRows = Object.fromEntries(
    SELECTOR_FIELDS.map((field) => [field, sumField(scores, field)]),
  ) as Record<SelectorField, number>;
  const fieldSelectionAccuracy = Object.fromEntries(
    SELECTOR_FIELDS.map((field) => [
      field,
      {
        correctRows: fieldCorrectRows[field],
        expectedRows,
        accuracy: ratio(fieldCorrectRows[field], expectedRows),
      },
    ]),
  ) as Record<SelectorField, { correctRows: number; expectedRows: number; accuracy: number }>;
  return {
    fixtureCount: scores.length,
    languageCount: new Set(fixtures.map((fixture) => fixture.language)).size,
    expectedRows,
    selectedRows,
    fullFieldRows,
    fullFieldRowAccuracy: ratio(fullFieldRows, expectedRows),
    fieldSelectionAccuracy,
    deterministicParseSuccessRows,
    supportedExpectedRows,
    supportedCorrectMappings,
    supportedDeterministicMappingAccuracy: ratio(supportedCorrectMappings, supportedExpectedRows),
    unsupportedExpectedRows,
    unsupportedRowsPreserved,
    unsupportedExactPreservationAccuracy: ratio(unsupportedRowsPreserved, unsupportedExpectedRows),
    reviewRows,
    reviewBurdenRate: ratio(reviewRows, expectedRows),
    failureCounts,
  } as const;
}

function sumField(scores: readonly FixtureScore[], field: SelectorField): number {
  return scores.reduce((total, score) => total + score.fieldCorrectRows[field], 0);
}

export type SourceSelectorGenerateRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly raw: true;
  readonly stream: false;
  readonly think: false;
  readonly format: Readonly<Record<string, unknown>>;
  readonly options: {
    readonly num_ctx: 2_048;
    readonly num_predict: 256;
    readonly temperature: 0;
    readonly top_p: 1;
  };
};
export type SourceSelectorTransport = (request: SourceSelectorGenerateRequest) => Promise<string>;

export function createSourceSelectorPrompt(
  candidate: SourceSelectorCandidate,
  locale: string,
  serializedChunk: string,
): string {
  const system =
    'You select exact source cells from physical laboratory rows. Return only the JSON object required by the schema. Select label and complete observed result cells, plus unit, reference, and flag cells when present. Cell order is arbitrary: c0, c1, c2, and c3 have no semantic meaning. Infer each cell role from its visible content, not its position. Use only row and cell keys from the input. Never output source text, IDs, mappings, values, units, ranges, flags, explanations, or extra fields. Keep ambiguous rows reviewable.';
  const user = `Schema version: ${SOURCE_SELECTOR_SCHEMA_VERSION}. Locale: ${locale}. OCR chunk: ${serializedChunk}`;
  const prompt =
    candidate === 'gemma4'
      ? `<bos><|turn>system\n${system}<turn|>\n<|turn>user\n${user}<turn|>\n<|turn>model\n`
      : candidate === 'qwen3'
        ? `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`
        : candidate === 'lfm2-350m-extract' || candidate === 'lfm2-1.2b-extract'
          ? `<|startoftext|><|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`
          : `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
  if (
    new TextEncoder().encode(prompt).byteLength > SOURCE_SELECTOR_LIMITS.maxPromptBytes ||
    !sourceSelectorPromptFitsContext(prompt)
  )
    throw boundedFailure('source-selector-input');
  return prompt;
}

/** Conservative lexical estimate; model-tokenizer exactness is intentionally not claimed. */
export function sourceSelectorPromptTokenEstimate(prompt: string): number {
  // Keep the production lexical estimator as the baseline, then add a byte-derived ceiling.
  // UTF-8 fragments can tokenize more densely than a scalar-only lexical estimate, especially
  // for OCR text outside ASCII. This remains deterministic and deliberately overestimates rather
  // than claiming to reproduce either candidate tokenizer.
  const lexicalEstimate = estimateSemanticMapperTokens(prompt);
  const byteCeiling = Math.ceil(new TextEncoder().encode(prompt).byteLength / 2);
  return Math.max(lexicalEstimate, byteCeiling);
}

export function sourceSelectorPromptFitsContext(prompt: string): boolean {
  return (
    sourceSelectorPromptTokenEstimate(prompt) + SOURCE_SELECTOR_LIMITS.outputTokenLimit <=
    SOURCE_SELECTOR_LIMITS.contextWindowTokens
  );
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export type SourceSelectorCandidateOptions = {
  readonly candidate: SourceSelectorCandidate;
  readonly modelAlias: string;
  readonly transport: SourceSelectorTransport;
  readonly preflight?: () => Promise<void>;
  readonly fixtures?: readonly V2Fixture[];
  readonly now?: () => number;
  readonly capturedAt?: () => string;
  readonly artifactPath?: string;
  readonly artifactReader?: ArtifactVerificationReader;
};

export type SourceSelectorArtifactOptions = Omit<
  SourceSelectorCandidateOptions,
  'candidate' | 'artifactPath'
> & {
  readonly artifactPath: string;
};

async function verifyCandidateArtifact(options: SourceSelectorCandidateOptions): Promise<void> {
  if (options.artifactPath === undefined) throw boundedFailure('artifact-path');
  try {
    await verifySourceSelectorArtifact(
      options.artifactPath,
      options.candidate,
      options.artifactReader,
    );
  } catch {
    throw boundedFailure('artifact-identity');
  }
}

async function runSourceSelectorCandidateInternal(
  options: SourceSelectorCandidateOptions,
  artifactAlreadyVerified = false,
) {
  const manifest = sourceSelectorCandidateManifests[options.candidate] as EvaluationManifest;
  const fixtures = options.fixtures ?? productionV2Fixtures;
  const now = options.now ?? (() => performance.now());
  const timings: number[] = [];
  const scores: FixtureScore[] = [];
  let retryCount = 0;
  if (!artifactAlreadyVerified && options.candidate !== 'qwen' && options.candidate !== 'gemma4')
    await verifyCandidateArtifact(options);
  if (options.preflight !== undefined) {
    try {
      await options.preflight();
    } catch {
      throw boundedFailure('candidate-identity');
    }
  }
  for (const fixture of fixtures) {
    let rows = fixture.rows;
    const selections: SourceSelectorSelection[] = [];
    const failures = emptyFailures();
    for (let attempt = 0; attempt <= SOURCE_SELECTOR_LIMITS.maxRetries; attempt += 1) {
      const serialized = serializeSourceSelectorChunk(rows, fixture.language);
      const started = now();
      let response: string;
      try {
        response = await options.transport({
          model: options.modelAlias,
          prompt: createSourceSelectorPrompt(options.candidate, fixture.language, serialized),
          raw: true,
          stream: false,
          think: false,
          format: createSourceSelectorFormat(rows),
          options: { num_ctx: 2_048, num_predict: 256, temperature: 0, top_p: 1 },
        });
      } catch {
        failures.transport += 1;
        break;
      }
      timings.push(Math.max(0, now() - started));
      if (new TextEncoder().encode(response).byteLength > SOURCE_SELECTOR_LIMITS.maxOutputBytes) {
        failures['oversized-output'] += 1;
        if (attempt === SOURCE_SELECTOR_LIMITS.maxRetries) break;
        retryCount += 1;
        continue;
      }
      let raw: unknown = null;
      try {
        raw = JSON.parse(response) as unknown;
      } catch {
        // Validator records malformed output without retaining the response.
      }
      const state = validateSourceSelectorOutput(raw, rows);
      if (state.malformedEnvelope) failures['malformed-envelope'] += 1;
      for (const code of state.failures) failures[code] += 1;
      selections.push(...state.selections);
      if (state.rejectedRows.length === 0 || attempt === SOURCE_SELECTOR_LIMITS.maxRetries) break;
      retryCount += 1;
      rows = state.rejectedRows;
    }
    const uniqueSelections = [
      ...new Map(selections.map((selection) => [selection.rowId, selection])).values(),
    ];
    scores.push(scoreFixture(fixture, uniqueSelections, failures));
  }
  const report = {
    reportVersion: 'alyte.semantic-source-selector.aggregate.v1',
    provenance: {
      contractVersion: SOURCE_SELECTOR_CONTRACT_VERSION,
      schemaVersion: SOURCE_SELECTOR_SCHEMA_VERSION,
      chunkVersion: SOURCE_SELECTOR_CHUNK_VERSION,
      selectorPromptVersion: SOURCE_SELECTOR_PROMPT_VERSION,
      candidatePromptBundleVersion: manifest.promptBundleVersion ?? null,
      fixtureVersion: PRODUCTION_V2_FIXTURE_VERSION,
      candidate: options.candidate,
      manifestVersion: manifest.manifestVersion,
      modelId: manifest.model.id,
      modelRepository: manifest.model.repository,
      modelRevision: manifest.model.revision,
      modelFilename: manifest.model.filename,
      modelPublisher: manifest.model.publisher,
      modelLicense: manifest.model.license,
      modelQuantization: manifest.model.quantization,
      modelSha256: manifest.model.sha256,
      sourceModelId: manifest.sourceModel?.id ?? null,
      sourceModelRepository: manifest.sourceModel?.repository ?? null,
      sourceModelRevision: manifest.sourceModel?.revision ?? null,
      sourceModelChatTemplateRevision: manifest.sourceModel?.chatTemplateRevision ?? null,
      sourceModelChatTemplateUrl: manifest.sourceModel?.chatTemplateUrl ?? null,
      runtimeId: manifest.runtime.id,
      runtimeRepository: manifest.runtime.repository,
      runtimeRelease: manifest.runtime.release,
      runtimeRevision: manifest.runtime.revision,
      contextWindowTokens: SOURCE_SELECTOR_LIMITS.contextWindowTokens,
      outputTokenLimit: SOURCE_SELECTOR_LIMITS.outputTokenLimit,
      maxInputBytes: SOURCE_SELECTOR_LIMITS.maxInputBytes,
      maxOutputBytes: SOURCE_SELECTOR_LIMITS.maxOutputBytes,
      temperature: 0,
      topP: 1,
      thinking: false,
      turnTemplate:
        options.candidate === 'gemma4'
          ? 'gemma4-v1'
          : options.candidate === 'qwen3'
            ? 'qwen3-v1'
            : options.candidate === 'lfm2-350m-extract' || options.candidate === 'lfm2-1.2b-extract'
              ? 'lfm2-v1'
              : 'qwen-chatml-v1',
    },
    quality: aggregateScores(scores, fixtures),
    retryCount,
    devices: [
      {
        deviceClass: 'mac',
        deviceModel: 'mac',
        osVersion: process.platform,
        warmInferenceMsP50: percentile(timings, 0.5),
        warmInferenceMsP95: percentile(timings, 0.95),
        packBytes: manifest.model.bytes,
        capturedAt: options.capturedAt?.() ?? new Date().toISOString(),
      },
    ],
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

export async function runSourceSelectorCandidate(options: SourceSelectorCandidateOptions) {
  return runSourceSelectorCandidateInternal(options);
}

type AggregateCandidate = Awaited<ReturnType<typeof runSourceSelectorCandidate>>;

export async function runSourceSelectorAB(options: {
  readonly qwen: Omit<SourceSelectorCandidateOptions, 'candidate'>;
  readonly gemma4: Omit<SourceSelectorCandidateOptions, 'candidate'>;
}) {
  const qwen = await runSourceSelectorCandidate({ ...options.qwen, candidate: 'qwen' });
  const gemma4 = await runSourceSelectorCandidate({ ...options.gemma4, candidate: 'gemma4' });
  const report = {
    reportVersion: 'alyte.semantic-source-selector.ab.aggregate.v1',
    qwen: qwen as AggregateCandidate,
    gemma4: gemma4 as AggregateCandidate,
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

export async function runSourceSelectorQwen3(options: SourceSelectorArtifactOptions) {
  return runSourceSelectorCandidate({ ...options, candidate: 'qwen3' });
}

/** Runs the Qwen3 control, then both LFM2 candidates in fixed order against one selector contract. */
export async function runSourceSelectorLfm2Comparison(options: {
  readonly qwen3: SourceSelectorArtifactOptions;
  readonly lfm2_350m: SourceSelectorArtifactOptions;
  readonly lfm2_1_2b: SourceSelectorArtifactOptions;
}) {
  const arms = [
    { ...options.qwen3, candidate: 'qwen3' as const },
    { ...options.lfm2_350m, candidate: 'lfm2-350m-extract' as const },
    { ...options.lfm2_1_2b, candidate: 'lfm2-1.2b-extract' as const },
  ] as const;
  for (const arm of arms) await verifyCandidateArtifact(arm);
  const qwen3 = await runSourceSelectorCandidateInternal(arms[0], true);
  const lfm2_350m = await runSourceSelectorCandidateInternal(arms[1], true);
  const lfm2_1_2b = await runSourceSelectorCandidateInternal(arms[2], true);
  const report = {
    reportVersion: 'alyte.semantic-source-selector.lfm2-comparison.aggregate.v2',
    qwen3_control: qwen3,
    lfm2_350m_extract: lfm2_350m,
    lfm2_1_2b_extract: lfm2_1_2b,
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

function loopbackUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw boundedFailure('endpoint');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  )
    throw boundedFailure('loopback-only');
  return url;
}

export function loopbackSourceSelectorTransport(
  endpoint = 'http://127.0.0.1:11434/api/generate',
): SourceSelectorTransport {
  const url = loopbackUrl(endpoint);
  return async (request) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch {
      throw boundedFailure('transport');
    }
    if (!response.ok) throw boundedFailure('response');
    let body: { response?: unknown };
    try {
      body = (await response.json()) as { response?: unknown };
    } catch {
      throw boundedFailure('payload');
    }
    if (typeof body.response !== 'string') throw boundedFailure('payload');
    return body.response;
  };
}

function hasExactPinnedBlobFromLine(value: unknown, expectedDigest: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const modelfile = (value as Record<string, unknown>).modelfile;
  if (typeof modelfile !== 'string') return false;
  const fromLines = modelfile
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^FROM(?:\s|$)/u.test(line));
  if (fromLines.length !== 1) return false;
  const match = /^FROM\s+\/(?:[^\s/]+\/)*blobs\/sha256-([a-f0-9]{64})$/u.exec(fromLines[0]!);
  return match?.[1] === expectedDigest;
}

export function loopbackCandidatePreflight(
  candidate: SourceSelectorCandidate,
  modelAlias: string,
  endpoint = 'http://127.0.0.1:11434/api/generate',
): () => Promise<void> {
  const url = loopbackUrl(endpoint);
  const showUrl = new URL('/api/show', url.origin);
  const manifest = sourceSelectorCandidateManifests[candidate];
  return async () => {
    let response: Response;
    try {
      response = await fetch(showUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: modelAlias }),
      });
    } catch {
      throw boundedFailure('candidate-identity');
    }
    if (!response.ok) throw boundedFailure('candidate-identity');
    let metadata: unknown;
    try {
      metadata = await response.json();
    } catch {
      throw boundedFailure('candidate-identity');
    }
    if (!hasExactPinnedBlobFromLine(metadata, manifest.model.sha256))
      throw boundedFailure('candidate-identity');
  };
}

export function isSourceSelectorAggregatePath(path: string): boolean {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const absolute = resolve(path);
  const insideRepository = (candidate: string): boolean => {
    const candidateRelative = relative(repositoryRoot, candidate);
    return (
      candidateRelative === '' ||
      (candidateRelative !== '..' &&
        !candidateRelative.startsWith('../') &&
        !isAbsolute(candidateRelative))
    );
  };
  if (
    !path.startsWith('/') ||
    !absolute.endsWith('.json') ||
    insideRepository(absolute) ||
    !/^model-evaluation-aggregate-source-selector(?:-[a-z0-9-]+)?\.json$/u.test(
      absolute.split('/').pop() ?? '',
    )
  )
    return false;
  try {
    if (lstatSync(absolute).isSymbolicLink()) return false;
    return !insideRepository(realpathSync.native(absolute));
  } catch {
    try {
      return !insideRepository(realpathSync.native(resolve(absolute, '..')));
    } catch {
      return false;
    }
  }
}

export function writeSourceSelectorAggregate(path: string, report: unknown): void {
  if (!isSourceSelectorAggregatePath(path)) throw boundedFailure('output-path');
  assertAggregatePrivacy(report);
  const absolute = resolve(path);
  const fd = openSync(
    absolute,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const encoded = Buffer.from(`${JSON.stringify(report)}\n`, 'utf8');
    writeFileSync(fd, encoded);
    ftruncateSync(fd, encoded.byteLength);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}
