import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import {
  createSemanticMapperPrompt,
  createSemanticMapperRetryPrompt,
  SEMANTIC_MAPPER_CONTEXT,
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  serializeSemanticMapperChunk,
  validateSemanticMapperOutputWithState,
  productionLocalModelManifest,
} from './model-evaluation-production';
// The repository's privacy scrub is a small ESM utility without a declaration file.
// @ts-expect-error JavaScript helper intentionally has no generated type surface.
import { assertAggregatePrivacy } from './model-evaluation-aggregate-scrub.mjs';
import { EVALUATION_MODEL_ALIAS, EXPECTED_MODEL } from './model-evaluation-prepare';
import {
  mapExtractionSemanticWireRows,
  type ExtractionSemanticCandidateRow,
  type ExtractionSemanticFieldSelection,
} from '@alyte/domain';
import {
  PRODUCTION_V2_FIXTURE_VERSION,
  productionAliases,
  productionV2Fixtures,
  type V2Fixture,
} from './model-evaluation-v2-fixtures';
import { CATALOGUE_SCHEMA_VERSION, CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  COMPACT_KEY_CANDIDATE_PROMPT_VERSION,
  createCompactKeyCandidatePrompt,
} from './model-evaluation-compact-key-candidate';

export type OllamaSemanticFormat = Readonly<Record<string, unknown>>;

export type OllamaGenerateRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly raw: true;
  readonly stream: false;
  readonly think: false;
  /** Ollama's transport-level equivalent of the production GBNF envelope constraint. */
  readonly format: OllamaSemanticFormat;
  readonly options: {
    readonly num_ctx: 2_048;
    readonly num_predict: 192;
    readonly temperature: 0;
    readonly top_p: 1;
  };
};

const nullableStringSchema = Object.freeze({
  anyOf: Object.freeze([{ type: 'string' }, { type: 'null' }]),
});

/**
 * Ollama does not accept Alyte's production GBNF string through `/api/generate`. Its documented
 * structured-output boundary accepts JSON Schema instead, so the evaluator binds the same closed
 * envelope before the unchanged production validator runs. Keep the focused request test aligned
 * with the checked-in production grammar drift check.
 */
export const OLLAMA_SEMANTIC_FORMAT = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['schemaVersion', 'proposals']),
  properties: Object.freeze({
    schemaVersion: Object.freeze({ const: SEMANTIC_MAPPER_SCHEMA_VERSION }),
    proposals: Object.freeze({
      type: 'array',
      maxItems: SEMANTIC_MAPPER_LIMITS.maxProposals,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze([
          'rowKey',
          'labelKey',
          'valueKey',
          'unitKey',
          'referenceIntervalKey',
          'flagKey',
          'role',
          'specimenType',
          'biomarkerId',
        ]),
        properties: Object.freeze({
          rowKey: Object.freeze({ type: 'string' }),
          labelKey: Object.freeze({ type: 'string' }),
          valueKey: Object.freeze({ type: 'string' }),
          unitKey: nullableStringSchema,
          referenceIntervalKey: nullableStringSchema,
          flagKey: nullableStringSchema,
          role: Object.freeze({
            enum: Object.freeze(['measurement', 'preserve', 'specimen-context', 'ignore']),
          }),
          specimenType: Object.freeze({
            enum: Object.freeze(['blood', 'serum', 'plasma', 'urine', 'other', 'unknown']),
          }),
          biomarkerId: nullableStringSchema,
        }),
      }),
    }),
  }),
});
export const OLLAMA_SEMANTIC_FORMAT_VERSION =
  'alyte.semantic-mapper.ollama-json-schema-envelope.v1' as const;

export const OLLAMA_DYNAMIC_SEMANTIC_FORMAT_VERSION =
  'alyte.semantic-mapper.ollama-json-schema-dynamic-row-cells.v1' as const;

export const OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_VERSION =
  'alyte.semantic-mapper.ollama-json-schema-role-safe-distinct-cells.v1' as const;

/**
 * Three roles times the distinct field assignments for one or more rows. This ceiling keeps the
 * evaluator grammar bounded before constructing the branch array; a six-cell row is intentionally
 * outside the final experiment even though the production wire contract allows it.
 */
const DISTINCT_SCHEMA_MAX_BRANCHES = 5_000;
export const OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_MAX_ENCODED_BYTES = 2_500_000;
const COMPACT_SEMANTIC_FIELDS = Object.freeze([
  'labelKey',
  'valueKey',
  'unitKey',
  'referenceIntervalKey',
  'flagKey',
] as const);
type CompactSemanticField = (typeof COMPACT_SEMANTIC_FIELDS)[number];

function nullableCompactKeySchema(cellKeys: readonly string[]) {
  return Object.freeze({
    anyOf: Object.freeze([
      Object.freeze({ enum: Object.freeze([...cellKeys]) }),
      Object.freeze({ type: 'null' }),
    ]),
  });
}

/**
 * Creates the evaluator-only transport schema for one serialized chunk. Each `oneOf` branch is
 * tied to one row key, so Ollama cannot emit a compact cell key belonging to a different row or
 * to a cell that is absent from this chunk. The production validator remains the acceptance
 * boundary after transport decoding.
 */
export function createDynamicOllamaSemanticFormat(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): OllamaSemanticFormat {
  if (
    candidateRows.length === 0 ||
    candidateRows.length > SEMANTIC_MAPPER_LIMITS.maxRows ||
    new Set(candidateRows.map((row) => row.rowId)).size !== candidateRows.length ||
    candidateRows.reduce((count, row) => count + row.observations.length, 0) >
      SEMANTIC_MAPPER_LIMITS.maxObservations ||
    candidateRows.some(
      (row) =>
        row.rowId.length === 0 ||
        row.rowId.length > 96 ||
        row.sourceObservationIds.length === 0 ||
        row.sourceObservationIds.length > SEMANTIC_MAPPER_LIMITS.maxObservations ||
        row.sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
        row.sourceObservationIds.length !== row.observations.length ||
        new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length ||
        row.observations.some(
          (observation, index) => observation.id !== row.sourceObservationIds[index],
        ),
    )
  ) {
    throw boundedFailure('constrained-schema-input');
  }
  const wireRows = mapExtractionSemanticWireRows(candidateRows);
  const seenObservationIds = new Set<string>();
  for (const { row } of wireRows) {
    for (const observation of row.observations) {
      if (seenObservationIds.has(observation.id)) throw boundedFailure('constrained-schema-input');
      seenObservationIds.add(observation.id);
    }
  }
  const proposals = wireRows.map(({ rowKey, row }) => {
    const cellKeys = row.observations.map((_, index) => `c${index}`);
    return Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([
        'rowKey',
        'labelKey',
        'valueKey',
        'unitKey',
        'referenceIntervalKey',
        'flagKey',
        'role',
        'specimenType',
        'biomarkerId',
      ]),
      properties: Object.freeze({
        rowKey: Object.freeze({ const: rowKey }),
        labelKey: Object.freeze({ enum: Object.freeze([...cellKeys]) }),
        valueKey: Object.freeze({ enum: Object.freeze([...cellKeys]) }),
        unitKey: nullableCompactKeySchema(cellKeys),
        referenceIntervalKey: nullableCompactKeySchema(cellKeys),
        flagKey: nullableCompactKeySchema(cellKeys),
        role: Object.freeze({
          enum: Object.freeze(['measurement', 'preserve', 'specimen-context', 'ignore']),
        }),
        specimenType: Object.freeze({
          enum: Object.freeze(['blood', 'serum', 'plasma', 'urine', 'other', 'unknown']),
        }),
        biomarkerId: nullableStringSchema,
      }),
    });
  });
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['schemaVersion', 'proposals']),
    properties: Object.freeze({
      schemaVersion: Object.freeze({ const: SEMANTIC_MAPPER_SCHEMA_VERSION }),
      proposals: Object.freeze({
        type: 'array',
        maxItems: candidateRows.length,
        items: Object.freeze({ oneOf: Object.freeze(proposals) }),
      }),
    }),
  });
}

type DistinctFieldAssignment = Readonly<Record<CompactSemanticField, string | null>>;

function distinctFieldAssignments(cellKeys: readonly string[]): readonly DistinctFieldAssignment[] {
  const assignments: DistinctFieldAssignment[] = [];
  const selected: Partial<Record<CompactSemanticField, string | null>> = {};

  const visit = (index: number, used: ReadonlySet<string>) => {
    if (assignments.length > DISTINCT_SCHEMA_MAX_BRANCHES) return;
    const field = COMPACT_SEMANTIC_FIELDS[index];
    if (field === undefined) {
      assignments.push({ ...selected } as DistinctFieldAssignment);
      return;
    }
    const choices = cellKeys.filter((key) => !used.has(key));
    if (index >= 2) choices.unshift('');
    for (const choice of choices) {
      const value = index >= 2 && choice === '' ? null : choice;
      selected[field] = value;
      visit(index + 1, value === null ? used : new Set([...used, value]));
      delete selected[field];
      if (assignments.length > DISTINCT_SCHEMA_MAX_BRANCHES) return;
    }
  };

  visit(0, new Set());
  if (assignments.length > DISTINCT_SCHEMA_MAX_BRANCHES)
    throw boundedFailure('constrained-schema-input');
  return assignments;
}

function distinctAssignmentCount(cellCount: number): number {
  if (cellCount < 2) return 0;
  const availableOptionalCells = cellCount - 2;
  let permutation = 1;
  let optionalAssignments = 1;
  for (let selected = 1; selected <= Math.min(3, availableOptionalCells); selected += 1) {
    permutation *= availableOptionalCells - selected + 1;
    const fieldPositionChoices = selected === 1 ? 3 : selected === 2 ? 3 : 1;
    optionalAssignments += fieldPositionChoices * permutation;
  }
  return cellCount * (cellCount - 1) * optionalAssignments;
}

function distinctFieldProperties(assignment: DistinctFieldAssignment) {
  return Object.freeze(
    Object.fromEntries(
      COMPACT_SEMANTIC_FIELDS.map((field) => [field, Object.freeze({ const: assignment[field] })]),
    ),
  );
}

/**
 * Builds the final evaluator-only Ollama schema. JSON Schema has no portable cross-property
 * inequality operator, so this schema enumerates the bounded valid assignments instead. Every
 * proposal branch chooses one row, five compact fields, and one validator-compatible role. The
 * branch count is deliberately bounded: a report that would require an oversized grammar fails
 * closed instead of silently relaxing the distinct-cell guarantee.
 */
export function createRoleSafeDistinctOllamaSemanticFormat(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): OllamaSemanticFormat {
  if (
    candidateRows.length === 0 ||
    candidateRows.length > SEMANTIC_MAPPER_LIMITS.maxRows ||
    new Set(candidateRows.map((row) => row.rowId)).size !== candidateRows.length ||
    candidateRows.reduce((count, row) => count + row.observations.length, 0) >
      SEMANTIC_MAPPER_LIMITS.maxObservations ||
    candidateRows.some(
      (row) =>
        row.rowId.length === 0 ||
        row.rowId.length > 96 ||
        row.sourceObservationIds.length === 0 ||
        row.sourceObservationIds.length > SEMANTIC_MAPPER_LIMITS.maxObservations ||
        row.sourceObservationIds.length !== row.observations.length ||
        new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length ||
        row.sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
        row.observations.some(
          (observation, index) => observation.id !== row.sourceObservationIds[index],
        ),
    )
  ) {
    throw boundedFailure('constrained-schema-input');
  }

  const wireRows = mapExtractionSemanticWireRows(candidateRows);
  const seenObservationIds = new Set<string>();
  for (const { row } of wireRows) {
    for (const observation of row.observations) {
      if (seenObservationIds.has(observation.id)) throw boundedFailure('constrained-schema-input');
      seenObservationIds.add(observation.id);
    }
  }

  const estimatedBranchCount = wireRows.reduce(
    (count, { row }) => count + distinctAssignmentCount(row.observations.length) * 3,
    0,
  );
  if (estimatedBranchCount === 0 || estimatedBranchCount > DISTINCT_SCHEMA_MAX_BRANCHES)
    throw boundedFailure('constrained-schema-input');

  const branches = wireRows.flatMap(({ rowKey, row }) => {
    const cellKeys = row.observations.map((_, index) => `c${index}`);
    const assignments = distinctFieldAssignments(cellKeys);
    return assignments.flatMap((assignment) =>
      (['measurement', 'preserve', 'specimen-context'] as const).map((role) => {
        const biomarkerId =
          role === 'measurement' ? Object.freeze(productionAliases.map((alias) => alias.id)) : null;
        return Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: Object.freeze([
            'rowKey',
            ...COMPACT_SEMANTIC_FIELDS,
            'role',
            'specimenType',
            'biomarkerId',
          ]),
          properties: Object.freeze({
            rowKey: Object.freeze({ const: rowKey }),
            ...distinctFieldProperties(assignment),
            role: Object.freeze({ const: role }),
            specimenType: Object.freeze({
              enum: Object.freeze(['blood', 'serum', 'plasma', 'urine', 'other', 'unknown']),
            }),
            biomarkerId:
              biomarkerId === null
                ? Object.freeze({ const: null })
                : Object.freeze({ enum: biomarkerId }),
          }),
        });
      }),
    );
  });
  if (branches.length === 0 || branches.length !== estimatedBranchCount)
    throw boundedFailure('constrained-schema-input');

  const format = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: Object.freeze(['schemaVersion', 'proposals']),
    properties: Object.freeze({
      schemaVersion: Object.freeze({ const: SEMANTIC_MAPPER_SCHEMA_VERSION }),
      proposals: Object.freeze({
        type: 'array',
        maxItems: candidateRows.length,
        items: Object.freeze({ oneOf: Object.freeze(branches) }),
      }),
    }),
  });
  if (
    new TextEncoder().encode(JSON.stringify(format)).byteLength >
    OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_MAX_ENCODED_BYTES
  )
    throw boundedFailure('constrained-schema-input');
  return format;
}

export type OllamaTransport = (request: OllamaGenerateRequest) => Promise<string>;
export type OllamaPreflight = () => Promise<void>;
type ProductionPromptFactory = (
  locale: V2Fixture['language'],
  serializedChunk: string,
  attempt: number,
) => string;

type FailureCounts = { malformedEnvelope: number; rejectedRows: number };
type Timings = { readonly warmInferenceMs: number[] };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function boundedFailure(code: string): Error {
  return new Error(`model-evaluation-failed:${code}`);
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

function isRepositoryPath(path: string): boolean {
  const relativePath = relative(repositoryRoot, path);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('../'));
}

function resolvedExternalPath(path: string): boolean {
  const absolute = resolve(path);
  if (isRepositoryPath(absolute)) return false;
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return false;
    return !isRepositoryPath(realpathSync.native(absolute));
  } catch {
    try {
      return !isRepositoryPath(realpathSync.native(resolve(absolute, '..')));
    } catch {
      return false;
    }
  }
}

export function isExternalAggregatePath(path: string): boolean {
  const absolute = resolve(path);
  return (
    isAbsolutePath(path) &&
    absolute.endsWith('.json') &&
    resolvedExternalPath(absolute) &&
    /^model-evaluation-aggregate(?:-[a-z0-9-]+)?\.json$/u.test(absolute.split('/').pop() ?? '')
  );
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
}

function parseResponse(response: string): unknown {
  try {
    return JSON.parse(response) as unknown;
  } catch {
    return null;
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function sourceFieldsEqual(
  actual: ExtractionSemanticFieldSelection | undefined,
  expected: ExtractionSemanticFieldSelection,
): boolean {
  return (
    actual !== undefined &&
    actual.label === expected.label &&
    actual.value === expected.value &&
    actual.unit === expected.unit &&
    actual.referenceInterval === expected.referenceInterval &&
    actual.flag === expected.flag
  );
}

function sourceObservationIdsEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function score(
  fixture: V2Fixture,
  referenced: ReadonlySet<string>,
  accepted: readonly {
    rowId: string;
    proposedBiomarkerId: string | null;
    proposedSpecimenType?: string;
    role?: string;
    sourceObservationIds: readonly string[];
    sourceFields?: ExtractionSemanticFieldSelection;
  }[],
  failures: FailureCounts,
) {
  const isCorrect = (proposal: (typeof accepted)[number]) => {
    const expected = fixture.expected.find((item) => item.rowId === proposal.rowId);
    return (
      expected !== undefined &&
      sourceObservationIdsEqual(proposal.sourceObservationIds, expected.sourceObservationIds) &&
      sourceFieldsEqual(proposal.sourceFields, expected.sourceFields) &&
      expected.biomarkerId === proposal.proposedBiomarkerId &&
      expected.specimenType === proposal.proposedSpecimenType &&
      expected.role === proposal.role
    );
  };
  const correct = accepted.filter(isCorrect).length;
  const expectedPreserveRows = fixture.expected.filter((item) => item.role === 'preserve').length;
  const acceptedPreserveProposals = accepted.filter(
    (proposal) => proposal.role === 'preserve',
  ).length;
  const correctPreserveProposals = accepted.filter(
    (proposal) => proposal.role === 'preserve' && isCorrect(proposal),
  ).length;
  const preserved = accepted.filter((proposal) => {
    const expected = fixture.expected.find((item) => item.rowId === proposal.rowId);
    return (
      expected !== undefined &&
      sourceObservationIdsEqual(proposal.sourceObservationIds, expected.sourceObservationIds) &&
      sourceFieldsEqual(proposal.sourceFields, expected.sourceFields)
    );
  }).length;
  const expectedRows = fixture.expected.length;
  return {
    expectedRows,
    modelReferencedRows: referenced.size,
    acceptedProposals: accepted.length,
    correctAcceptedProposals: correct,
    expectedPreserveRows,
    acceptedPreserveProposals,
    correctPreserveProposals,
    modelRecall: expectedRows === 0 ? 0 : referenced.size / expectedRows,
    acceptedEndToEndPrecision: accepted.length === 0 ? 0 : correct / accepted.length,
    exactSourceFactsPreserved: preserved,
    exactSourceValueUnitIntervalPreservation:
      accepted.length === 0 ? 0 : preserved / accepted.length,
    rowsNeedingReview: Math.max(0, expectedRows - correct),
    reviewBurdenRate: expectedRows === 0 ? 0 : Math.max(0, expectedRows - correct) / expectedRows,
    failureCounts: { ...failures },
  };
}

export type ProductionBaselineOptions = {
  readonly transport: OllamaTransport;
  /** The CLI supplies the loopback Ollama identity check; tests inject a fail-closed seam. */
  readonly preflight?: OllamaPreflight;
  readonly fixtures?: readonly V2Fixture[];
  readonly now?: () => number;
  readonly capturedAt?: () => string;
  readonly promptFactory?: ProductionPromptFactory;
  readonly promptBundleVersion?: string;
  readonly formatFactory?: (
    rows: readonly ExtractionSemanticCandidateRow[],
  ) => OllamaSemanticFormat;
  readonly formatVersion?: string;
};

export async function runProductionBaseline(options: ProductionBaselineOptions) {
  const now = options.now ?? (() => performance.now());
  const timings: Timings = { warmInferenceMs: [] };
  const scores: ReturnType<typeof score>[] = [];
  let retryCount = 0;
  const fixtures = options.fixtures ?? productionV2Fixtures;
  if (options.preflight !== undefined) {
    try {
      await options.preflight();
    } catch {
      throw boundedFailure('ollama-identity');
    }
  }
  for (const fixture of fixtures) {
    const accepted: {
      rowId: string;
      proposedBiomarkerId: string | null;
      proposedSpecimenType?: string;
      role?: string;
      sourceObservationIds: readonly string[];
      sourceFields?: ExtractionSemanticFieldSelection;
    }[] = [];
    let rows = fixture.rows;
    const referenced = new Set<string>();
    let failures: FailureCounts = { malformedEnvelope: 0, rejectedRows: 0 };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const serialized = serializeSemanticMapperChunk(rows, fixture.language);
      const prompt =
        options.promptFactory?.(fixture.language, serialized, attempt) ??
        (attempt === 0
          ? createSemanticMapperPrompt(fixture.language, serialized)
          : createSemanticMapperRetryPrompt(fixture.language, serialized));
      const started = now();
      let response: string;
      try {
        response = await options.transport({
          model: EVALUATION_MODEL_ALIAS,
          prompt,
          raw: true,
          stream: false,
          think: false,
          format: options.formatFactory?.(rows) ?? OLLAMA_SEMANTIC_FORMAT,
          options: { num_ctx: 2_048, num_predict: 192, temperature: 0, top_p: 1 },
        });
      } catch {
        throw boundedFailure('ollama-transport');
      }
      timings.warmInferenceMs.push(Math.max(0, now() - started));
      const raw = parseResponse(response);
      const state = validateSemanticMapperOutputWithState(raw, rows, productionAliases);
      if (state.malformedEnvelope) failures.malformedEnvelope += 1;
      failures.rejectedRows += state.rejectedRows.length;
      const rowByIds = new Map(
        rows.map((row) => [row.sourceObservationIds.join('\u0000'), row.rowId]),
      );
      for (const proposal of state.proposals) {
        const rowId = rowByIds.get(proposal.sourceObservationIds.join('\u0000'));
        if (rowId !== undefined) referenced.add(rowId);
      }
      accepted.push(
        ...state.proposals.flatMap((proposal) => {
          const rowId = rowByIds.get(proposal.sourceObservationIds.join('\u0000'));
          return rowId === undefined ? [] : [{ ...proposal, rowId }];
        }),
      );
      if (state.rejectedRows.length === 0 || attempt === 1) break;
      retryCount += 1;
      rows = state.rejectedRows;
    }
    scores.push(score(fixture, referenced, accepted, failures));
  }
  const quality = scores.reduce(
    (aggregate, current) => {
      for (const key of [
        'expectedRows',
        'modelReferencedRows',
        'acceptedProposals',
        'correctAcceptedProposals',
        'expectedPreserveRows',
        'acceptedPreserveProposals',
        'correctPreserveProposals',
        'exactSourceFactsPreserved',
        'rowsNeedingReview',
      ] as const)
        aggregate[key] += current[key];
      return aggregate;
    },
    {
      expectedRows: 0,
      modelReferencedRows: 0,
      acceptedProposals: 0,
      correctAcceptedProposals: 0,
      expectedPreserveRows: 0,
      acceptedPreserveProposals: 0,
      correctPreserveProposals: 0,
      exactSourceFactsPreserved: 0,
      rowsNeedingReview: 0,
    },
  );
  const failureCounts = scores.reduce(
    (result, current) => ({
      malformedEnvelope: result.malformedEnvelope + current.failureCounts.malformedEnvelope,
      rejectedRows: result.rejectedRows + current.failureCounts.rejectedRows,
    }),
    { malformedEnvelope: 0, rejectedRows: 0 },
  );
  const report = {
    reportVersion: 'alyte.gemma4-production-contract.aggregate.v1',
    provenance: {
      manifestVersion: 'alyte.local-model.manifest.v1',
      contractVersion: 'alyte.semantic-mapper.production-baseline.v1',
      promptBundleVersion: options.promptBundleVersion ?? SEMANTIC_MAPPER_PROMPT_VERSION,
      fixtureVersion: PRODUCTION_V2_FIXTURE_VERSION,
      formatVersion: options.formatVersion ?? OLLAMA_SEMANTIC_FORMAT_VERSION,
      modelId: productionLocalModelManifest.pack.id,
      modelRepository: productionLocalModelManifest.pack.artifact.repository,
      modelRevision: productionLocalModelManifest.pack.artifact.revision,
      modelFilename: productionLocalModelManifest.pack.artifact.filename,
      modelSha256: productionLocalModelManifest.pack.artifact.sha256,
      runtimeId: productionLocalModelManifest.runtime.id,
      runtimeRepository: productionLocalModelManifest.runtime.repository,
      runtimeRevision: productionLocalModelManifest.runtime.revision,
      schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
      ocrChunkVersion: SEMANTIC_OCR_CHUNK_VERSION,
      catalogueVersion: CATALOGUE_VERSION,
      catalogueSchemaVersion: CATALOGUE_SCHEMA_VERSION,
      contextWindowTokens: SEMANTIC_MAPPER_CONTEXT.maxTokens,
      outputTokenLimit: SEMANTIC_MAPPER_LIMITS.outputTokenLimit,
      maxOutputBytes: SEMANTIC_MAPPER_LIMITS.maxOutputBytes,
      temperature: 0,
      topP: 1,
      thinking: false,
    },
    quality: {
      fixtureCount: fixtures.length,
      languageCount: new Set(fixtures.map((fixture) => fixture.language)).size,
      ...quality,
      modelRecall:
        quality.expectedRows === 0 ? 0 : quality.modelReferencedRows / quality.expectedRows,
      acceptedEndToEndPrecision:
        quality.acceptedProposals === 0
          ? 0
          : quality.correctAcceptedProposals / quality.acceptedProposals,
      exactSourceValueUnitIntervalPreservation:
        quality.acceptedProposals === 0
          ? 0
          : quality.exactSourceFactsPreserved / quality.acceptedProposals,
      reviewBurdenRate:
        quality.expectedRows === 0 ? 0 : quality.rowsNeedingReview / quality.expectedRows,
      failureCounts,
    },
    retryCount,
    devices: [
      {
        deviceClass: 'mac',
        deviceModel: 'mac',
        osVersion: process.platform,
        coldLoadMs: null,
        warmInferenceMsP50: percentile(timings.warmInferenceMs, 0.5),
        warmInferenceMsP95: percentile(timings.warmInferenceMs, 0.95),
        peakMemoryBytes: null,
        thermalState: 'unknown',
        packBytes: productionLocalModelManifest.pack.bytes,
        runtimeBytes: null,
        capturedAt: options.capturedAt?.() ?? new Date().toISOString(),
      },
    ],
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

type AggregateRun = Awaited<ReturnType<typeof runProductionBaseline>>;

function aggregateVariant(report: AggregateRun) {
  return {
    provenance: report.provenance,
    quality: report.quality,
    retryCount: report.retryCount,
    devices: report.devices,
  } as const;
}

/** Runs the unchanged production prompt beside the one evaluator-only compact-key candidate. */
export async function runProductionAB(options: ProductionBaselineOptions) {
  const baseline = await runProductionBaseline({
    ...options,
    promptFactory: undefined,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
  });
  const candidate = await runProductionBaseline({
    ...options,
    promptFactory: (locale, serializedChunk, attempt) =>
      attempt === 0
        ? createCompactKeyCandidatePrompt(locale, serializedChunk)
        : createSemanticMapperRetryPrompt(locale, serializedChunk),
    promptBundleVersion: COMPACT_KEY_CANDIDATE_PROMPT_VERSION,
  });
  const report = {
    reportVersion: 'alyte.gemma4-production-contract.ab.aggregate.v1',
    baseline: aggregateVariant(baseline),
    candidate: aggregateVariant(candidate),
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

/** Runs the unchanged production prompt with the baseline and dynamic row/cell transport schemas. */
export async function runProductionConstrainedAB(options: ProductionBaselineOptions) {
  const baseline = await runProductionBaseline({
    ...options,
    promptFactory: undefined,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
    formatFactory: undefined,
    formatVersion: OLLAMA_SEMANTIC_FORMAT_VERSION,
  });
  const candidate = await runProductionBaseline({
    ...options,
    promptFactory: undefined,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
    formatFactory: createDynamicOllamaSemanticFormat,
    formatVersion: OLLAMA_DYNAMIC_SEMANTIC_FORMAT_VERSION,
  });
  const report = {
    reportVersion: 'alyte.gemma4-production-contract.constrained-ab.aggregate.v1',
    baseline: aggregateVariant(baseline),
    candidate: aggregateVariant(candidate),
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

/** Runs the unchanged production prompt with the final role-safe, distinct-cell transport schema. */
export async function runProductionFinalAB(options: ProductionBaselineOptions) {
  const baseline = await runProductionBaseline({
    ...options,
    promptFactory: undefined,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
    formatFactory: undefined,
    formatVersion: OLLAMA_SEMANTIC_FORMAT_VERSION,
  });
  const candidate = await runProductionBaseline({
    ...options,
    promptFactory: undefined,
    promptBundleVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
    formatFactory: createRoleSafeDistinctOllamaSemanticFormat,
    formatVersion: OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_VERSION,
  });
  const report = {
    reportVersion: 'alyte.gemma4-production-contract.final-ab.aggregate.v1',
    baseline: aggregateVariant(baseline),
    candidate: aggregateVariant(candidate),
  } as const;
  assertAggregatePrivacy(report);
  return report;
}

export function loopbackTransport(
  endpoint = 'http://127.0.0.1:11434/api/generate',
): OllamaTransport {
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
      throw boundedFailure('ollama-unavailable');
    }
    if (!response.ok) throw boundedFailure('ollama-response');
    let body: { response?: unknown };
    try {
      body = (await response.json()) as { response?: unknown };
    } catch {
      throw boundedFailure('ollama-payload');
    }
    if (typeof body.response !== 'string') throw boundedFailure('ollama-payload');
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
    .filter((line) => line.startsWith('FROM '));
  const matches = fromLines.flatMap((line) => {
    const match = /^FROM\s+\/(?:[^\s/]+\/)*blobs\/sha256-([a-f0-9]{64})$/u.exec(line);
    return match === null ? [] : [match[1]!];
  });
  return matches.length === 1 && matches[0] === expectedDigest;
}

/**
 * Resolve the fixed alias through Ollama itself. A sidecar or the alias string is not an
 * identity proof: the actual /api/show metadata must carry the pinned artifact hash.
 */
export function loopbackModelPreflight(
  endpoint = 'http://127.0.0.1:11434/api/generate',
): OllamaPreflight {
  const generateUrl = loopbackUrl(endpoint);
  const showUrl = new URL('/api/show', generateUrl.origin);
  return async () => {
    let response: Response;
    try {
      response = await fetch(showUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: EVALUATION_MODEL_ALIAS }),
      });
    } catch {
      throw boundedFailure('ollama-identity');
    }
    if (!response.ok) throw boundedFailure('ollama-identity');
    let metadata: unknown;
    try {
      metadata = await response.json();
    } catch {
      throw boundedFailure('ollama-identity');
    }
    if (!hasExactPinnedBlobFromLine(metadata, EXPECTED_MODEL.sha256)) {
      throw boundedFailure('ollama-identity');
    }
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void (async () => {
    const output = argument('--output');
    const endpoint = argument('--endpoint') ?? 'http://127.0.0.1:11434/api/generate';
    if (output === undefined || !isExternalAggregatePath(output))
      throw boundedFailure('output-path');
    const report = await runProductionBaseline({
      transport: loopbackTransport(endpoint),
      preflight: loopbackModelPreflight(endpoint),
    });
    if (!isExternalAggregatePath(output)) throw boundedFailure('output-path');
    writeFileSync(resolve(output), `${JSON.stringify(report)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`completed ${productionV2Fixtures.length} fixtures; aggregate written\n`);
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error &&
        /^model-(?:evaluation|preparation)-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-evaluation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}
