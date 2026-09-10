import { dirname } from 'node:path';
import {
  assertPipelineIdentity,
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  readExpectedResults,
  readJsonFile,
  securePrivateFile,
  type EvaluationMeasurement,
  type ExpectedResults,
  type PipelineResult,
  sha256File,
  verifyReportAndGroundTruth,
  writeJsonFile,
} from './contract';

export const SCORE_FIELDS = [
  'sourceLabel',
  'valueString',
  'valueType',
  'parsedValue',
  'comparator',
  'unit',
  'referenceInterval',
  'flag',
  'collectionDate',
  'collectionGroup',
  'specimen',
  'page',
] as const;

export const CRITICAL_FIELDS = [
  'sourceLabel',
  'valueString',
  'valueType',
  'parsedValue',
  'comparator',
  'unit',
  'collectionDate',
] as const;

export type ScoreField = (typeof SCORE_FIELDS)[number];
export type CriticalField = (typeof CRITICAL_FIELDS)[number];
export type FieldStatus = 'correct' | 'incorrect' | 'unresolved';

export type ScoreOptions = {
  /** Score only expected rows whose source page is included. */
  readonly pages?: readonly number[];
};

export type PageScope = {
  /** Null means the complete report; a non-null list is canonicalized ascending. */
  readonly pages: readonly number[] | null;
  /** Count in the sealed truth file before applying the optional page scope. */
  readonly fullExpectedMeasurementCount: number;
  /** Row denominator after applying the optional page scope. */
  readonly scoredExpectedMeasurementCount: number;
};

type MatchReason =
  'exact-source-tuple' | 'same-source-label-page' | 'same-source-label-date' | 'same-source-label';

type FieldResult = {
  readonly status: FieldStatus;
  readonly expected: unknown;
  readonly actual: unknown;
};

type MeasurementMatch = {
  readonly expectedIndex: number;
  readonly pipelineIndex: number;
  readonly reason: MatchReason;
  readonly fields: Readonly<Record<ScoreField, FieldResult>>;
  readonly criticalCorrect: boolean;
};

export type FieldScore = {
  readonly correct: number;
  readonly incorrect: number;
  readonly unresolved: number;
  readonly denominator: number;
};

export type DetailedScore = {
  readonly schemaVersion: 'alyte.import-eval.v1';
  readonly reportId: string;
  readonly reportSha256: string;
  readonly pipeline: {
    readonly id: string;
    readonly version: string;
  };
  readonly status: 'complete';
  readonly pageScope: PageScope;
  readonly expectedMeasurementCount: number;
  readonly outputMeasurementCount: number;
  readonly recoveredMeasurementCount: number;
  readonly matchedMeasurementCount: number;
  readonly exactSourceTupleMatchCount: number;
  readonly correctMeasurementCount: number;
  readonly missingCount: number;
  readonly spuriousCount: number;
  readonly duplicateCount: number;
  readonly wrongAssociationCount: number;
  readonly fieldScores: Readonly<Record<ScoreField, FieldScore>>;
  readonly criticalAssociation: {
    readonly correctCount: number;
    readonly incorrectCount: number;
    readonly unresolvedCount: number;
    readonly denominator: number;
  };
  readonly labelValueAssociation: {
    readonly correctCount: number;
    readonly incorrectCount: number;
    readonly unresolvedCount: number;
    readonly denominator: number;
  };
  readonly groupAssociation: {
    readonly correctCount: number;
    readonly incorrectCount: number;
    readonly unresolvedCount: number;
    readonly denominator: number;
  };
  readonly mapping: {
    readonly evaluatedCount: number;
    readonly correctCount: number;
    readonly incorrectCount: number;
    readonly unsupportedCount: number;
    readonly unevaluatedCount: number;
    readonly pipelineMappedCount: number;
    readonly pipelineUnmappedCount: number;
    readonly pipelineCanonicalFieldAbsentCount: number;
  };
  readonly trendEligibility: {
    readonly evaluatedCount: number;
    readonly correctCount: number;
    readonly incorrectCount: number;
    readonly unevaluatedCount: number;
  };
  readonly correctionBurden: {
    readonly changedFieldCount: number;
    readonly expectedAmbiguousFieldCount: number;
    readonly pipelineUnresolvedFieldCount: number;
    readonly unresolvedFieldCount: number;
    readonly unexpectedPopulatedFieldCount: number;
    readonly inventedAmbiguousFieldCount: number;
    readonly inventedAmbiguousCollectionDateCount: number;
  };
  readonly elapsedMs: number;
  readonly stageTimings: readonly {
    readonly elapsedMs: number;
    readonly status: string;
  }[];
  readonly diagnostics: {
    readonly totalCount: number;
  };
  readonly matches: readonly MeasurementMatch[];
  readonly missingMeasurementIds: readonly string[];
  readonly spuriousMeasurementIds: readonly string[];
};

export type SafeAggregate = {
  readonly schemaVersion: 'alyte.import-eval.v1';
  readonly reportId: string;
  readonly reportSha256: string;
  /** Present on scoreFiles output; pure toSafeAggregate remains source-independent. */
  readonly groundTruthSha256?: string;
  readonly groundTruthVersion?: ExpectedResults['groundTruthVersion'];
  readonly pipeline: {
    readonly id: string;
    readonly version: string;
  };
  readonly status: 'complete';
  readonly pageScope: PageScope;
  readonly counts: {
    readonly expectedMeasurements: number;
    readonly producedMeasurements: number;
    readonly recoveredMeasurements: number;
    readonly matchedMeasurements: number;
    readonly exactSourceTupleMatches: number;
    readonly correctMeasurements: number;
    readonly missing: number;
    readonly spurious: number;
    readonly duplicates: number;
    readonly wrongAssociations: number;
  };
  readonly criticalAssociation: DetailedScore['criticalAssociation'];
  readonly labelValueAssociation: DetailedScore['labelValueAssociation'];
  readonly groupAssociation: DetailedScore['groupAssociation'];
  readonly fieldScores: Readonly<Record<ScoreField, FieldScore>>;
  readonly mapping: DetailedScore['mapping'];
  readonly trendEligibility: DetailedScore['trendEligibility'];
  readonly correctionBurden: DetailedScore['correctionBurden'];
  readonly elapsedMs: number;
  readonly stageTimings: readonly {
    readonly stageIndex: number;
    readonly elapsedMs: number;
    readonly status: string;
  }[];
  readonly diagnostics: DetailedScore['diagnostics'];
};

function normaliseText(value: string | null, lowerCase = false): string | null {
  if (value === null) return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return lowerCase ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function normaliseScalar(value: unknown, field: ScoreField): unknown {
  if (typeof value === 'string') return normaliseText(value, field === 'sourceLabel');
  return value;
}

function scalarEqual(left: unknown, right: unknown, field: ScoreField): boolean {
  return Object.is(normaliseScalar(left, field), normaliseScalar(right, field));
}

function fieldValue(measurement: EvaluationMeasurement, field: ScoreField): unknown {
  return measurement[field];
}

function fieldIsAmbiguous(measurement: EvaluationMeasurement, field: ScoreField): boolean {
  const fields = new Set(measurement.ambiguousFields.map((item) => item.trim()));
  if (fields.has(field)) return true;
  const aliases: Partial<Record<ScoreField, readonly string[]>> = {
    sourceLabel: ['label'],
    valueString: ['value'],
    referenceInterval: ['interval', 'range'],
    collectionDate: ['date'],
  };
  return aliases[field]?.some((alias) => fields.has(alias)) ?? false;
}

function fieldResult(
  expected: EvaluationMeasurement,
  actual: EvaluationMeasurement,
  field: ScoreField,
): FieldResult {
  const expectedValue = fieldValue(expected, field);
  const actualValue = fieldValue(actual, field);
  if (field === 'collectionGroup' || fieldIsAmbiguous(expected, field)) {
    return { status: 'unresolved', expected: expectedValue, actual: actualValue };
  }
  return {
    status: scalarEqual(expectedValue, actualValue, field) ? 'correct' : 'incorrect',
    expected: expectedValue,
    actual: actualValue,
  };
}

function sourceTupleKey(measurement: EvaluationMeasurement): string {
  return [
    normaliseText(measurement.sourceLabel, true),
    measurement.page ?? 'null',
    normaliseText(measurement.valueString),
  ].join('\u0000');
}

function sourceLabelPageKey(measurement: EvaluationMeasurement): string {
  return [normaliseText(measurement.sourceLabel, true), measurement.page ?? 'null'].join('\u0000');
}

function sourceLabelDateKey(measurement: EvaluationMeasurement): string | null {
  if (measurement.collectionDate === null) return null;
  return [
    normaliseText(measurement.sourceLabel, true),
    normaliseText(measurement.collectionDate),
  ].join('\u0000');
}

function candidatePriority(
  expected: EvaluationMeasurement,
  actual: EvaluationMeasurement,
  index: number,
): number {
  let score = 0;
  if (
    expected.collectionDate !== null &&
    scalarEqual(expected.collectionDate, actual.collectionDate, 'collectionDate')
  )
    score += 100;
  if (expected.specimen !== null && scalarEqual(expected.specimen, actual.specimen, 'specimen'))
    score += 10;
  if (expected.page === actual.page) score += 5;
  if (expected.unit !== null && scalarEqual(expected.unit, actual.unit, 'unit')) score += 2;
  return score * 1_000_000 - index;
}

function chooseCandidate(
  expected: EvaluationMeasurement,
  pipeline: readonly EvaluationMeasurement[],
  candidates: readonly number[],
): number | undefined {
  if (candidates.length === 0) return undefined;
  return candidates.reduce(
    (best, index) => {
      if (best === undefined) return index;
      return candidatePriority(expected, pipeline[index]!, index) >
        candidatePriority(expected, pipeline[best]!, best)
        ? index
        : best;
    },
    undefined as number | undefined,
  );
}

function matchMeasurements(
  expected: readonly EvaluationMeasurement[],
  pipeline: readonly EvaluationMeasurement[],
): {
  readonly matches: readonly MeasurementMatch[];
  readonly unmatchedExpected: readonly number[];
  readonly unmatchedPipeline: readonly number[];
} {
  const unmatchedExpected = new Set(expected.map((_, index) => index));
  const unmatchedPipeline = new Set(pipeline.map((_, index) => index));
  const matches: MeasurementMatch[] = [];

  const pair = (expectedIndex: number, pipelineIndex: number, reason: MatchReason): void => {
    const expectedMeasurement = expected[expectedIndex]!;
    const actualMeasurement = pipeline[pipelineIndex]!;
    const fields = Object.fromEntries(
      SCORE_FIELDS.map((field) => [
        field,
        fieldResult(expectedMeasurement, actualMeasurement, field),
      ]),
    ) as Record<ScoreField, FieldResult>;
    const criticalStatuses = CRITICAL_FIELDS.map((field) => fields[field].status);
    matches.push({
      expectedIndex,
      pipelineIndex,
      reason,
      fields,
      criticalCorrect: criticalStatuses.every((status) => status === 'correct'),
    });
    unmatchedExpected.delete(expectedIndex);
    unmatchedPipeline.delete(pipelineIndex);
  };

  const exactGroups = new Map<string, number[]>();
  for (const index of unmatchedPipeline) {
    const key = sourceTupleKey(pipeline[index]!);
    const group = exactGroups.get(key) ?? [];
    group.push(index);
    exactGroups.set(key, group);
  }
  for (const expectedIndex of [...unmatchedExpected]) {
    const expectedMeasurement = expected[expectedIndex]!;
    const key = sourceTupleKey(expectedMeasurement);
    const candidates = exactGroups.get(key)?.filter((index) => unmatchedPipeline.has(index)) ?? [];
    const selected = chooseCandidate(expectedMeasurement, pipeline, candidates);
    if (selected !== undefined) pair(expectedIndex, selected, 'exact-source-tuple');
  }

  const pairByKey = (
    keyFor: (measurement: EvaluationMeasurement) => string | null,
    reason: MatchReason,
  ): void => {
    const groups = new Map<string, number[]>();
    for (const index of unmatchedPipeline) {
      const key = keyFor(pipeline[index]!);
      if (key === null) continue;
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    }
    for (const expectedIndex of [...unmatchedExpected]) {
      const key = keyFor(expected[expectedIndex]!);
      if (key === null) continue;
      const candidates = groups.get(key)?.filter((index) => unmatchedPipeline.has(index)) ?? [];
      const selected = chooseCandidate(expected[expectedIndex]!, pipeline, candidates);
      if (selected !== undefined) pair(expectedIndex, selected, reason);
    }
  };

  pairByKey(sourceLabelPageKey, 'same-source-label-page');
  pairByKey(sourceLabelDateKey, 'same-source-label-date');
  pairByKey((measurement) => normaliseText(measurement.sourceLabel, true), 'same-source-label');

  return {
    matches,
    unmatchedExpected: [...unmatchedExpected],
    unmatchedPipeline: [...unmatchedPipeline],
  };
}

function emptyFieldScores(): Record<ScoreField, FieldScore> {
  return Object.fromEntries(
    SCORE_FIELDS.map((field) => [
      field,
      { correct: 0, incorrect: 0, unresolved: 0, denominator: 0 },
    ]),
  ) as Record<ScoreField, FieldScore>;
}

function addFieldResult(
  scores: Record<ScoreField, FieldScore>,
  field: ScoreField,
  result: FieldResult,
): void {
  const current = scores[field];
  scores[field] = {
    correct: current.correct + (result.status === 'correct' ? 1 : 0),
    incorrect: current.incorrect + (result.status === 'incorrect' ? 1 : 0),
    unresolved: current.unresolved + (result.status === 'unresolved' ? 1 : 0),
    denominator: current.denominator + (result.status === 'unresolved' ? 0 : 1),
  };
}

function totalDiagnosticCount(pipeline: PipelineResult): number {
  return Object.values(pipeline.diagnostics.counts).reduce((sum, count) => sum + count, 0);
}

function normalizePageSelection(pages: readonly number[] | undefined): readonly number[] | null {
  if (pages === undefined) return null;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('selected page scope must contain one or more positive integer pages');
  }
  const uniquePages = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error('selected page scope must contain one or more positive integer pages');
    }
    uniquePages.add(page);
  }
  return [...uniquePages].sort((left, right) => left - right);
}

function assertPipelineWithinPageScope(
  pipeline: readonly EvaluationMeasurement[],
  pages: readonly number[] | null,
): void {
  if (pages === null) return;
  const selectedPages = new Set(pages);
  if (
    pipeline.some(
      (measurement) => measurement.page === null || !selectedPages.has(measurement.page),
    )
  ) {
    throw new Error('pipeline output contains a measurement outside the selected page scope');
  }
}

export function scoreEvaluation(
  expected: ExpectedResults,
  pipeline: PipelineResult,
  options: ScoreOptions = {},
): DetailedScore {
  if (expected.reportId !== pipeline.reportId || expected.reportSha256 !== pipeline.reportSha256) {
    throw new Error('pipeline result identity does not match evaluation input');
  }
  const selectedPages = normalizePageSelection(options.pages);
  assertPipelineWithinPageScope(pipeline.measurements, selectedPages);
  const expectedOriginalIndices: number[] = [];
  for (let index = 0; index < expected.measurements.length; index += 1) {
    const measurement = expected.measurements[index]!;
    if (
      selectedPages === null ||
      (measurement.page !== null && selectedPages.includes(measurement.page))
    ) {
      expectedOriginalIndices.push(index);
    }
  }
  const expectedMeasurements = expectedOriginalIndices.map(
    (index) => expected.measurements[index]!,
  );
  const pageScope: PageScope = {
    pages: selectedPages,
    fullExpectedMeasurementCount: expected.measurements.length,
    scoredExpectedMeasurementCount: expectedMeasurements.length,
  };
  const matched = matchMeasurements(expectedMeasurements, pipeline.measurements);
  const fieldScores = emptyFieldScores();
  let exactSourceTupleMatchCount = 0;
  let correctMeasurementCount = 0;
  let wrongAssociationCount = 0;
  let changedFieldCount = 0;
  let expectedAmbiguousFieldCount = 0;
  let pipelineUnresolvedFieldCount = 0;
  let inventedAmbiguousFieldCount = 0;
  let inventedAmbiguousCollectionDateCount = 0;
  let unexpectedPopulatedFieldCount = 0;
  let criticalCorrectCount = 0;
  let criticalIncorrectCount = 0;
  let criticalUnresolvedCount = 0;
  let mappingEvaluatedCount = 0;
  let mappingCorrectCount = 0;
  let mappingIncorrectCount = 0;
  let mappingUnsupportedCount = 0;
  let mappingUnevaluatedCount = 0;
  let pipelineMappedCount = 0;
  let pipelineUnmappedCount = 0;
  let pipelineCanonicalFieldAbsentCount = 0;
  let trendEvaluatedCount = 0;
  let trendCorrectCount = 0;
  let trendIncorrectCount = 0;
  let trendUnevaluatedCount = 0;
  let groupCorrectCount = 0;
  let groupIncorrectCount = 0;
  let groupUnresolvedCount = 0;
  let labelValueCorrectCount = 0;
  let labelValueIncorrectCount = 0;
  let labelValueUnresolvedCount = 0;

  for (const expectedMeasurement of expectedMeasurements) {
    expectedAmbiguousFieldCount += expectedMeasurement.ambiguousFields.length;
  }
  for (const actualMeasurement of pipeline.measurements) {
    pipelineUnresolvedFieldCount += actualMeasurement.unresolvedFields?.length ?? 0;
  }

  for (const match of matched.matches) {
    if (match.reason === 'exact-source-tuple') exactSourceTupleMatchCount += 1;
    for (const field of SCORE_FIELDS) {
      const result = match.fields[field];
      addFieldResult(fieldScores, field, result);
      if (result.status === 'incorrect') changedFieldCount += 1;
      if (result.expected === null && result.actual !== null) {
        unexpectedPopulatedFieldCount += 1;
        if (result.status === 'unresolved') {
          inventedAmbiguousFieldCount += 1;
          if (field === 'collectionDate') inventedAmbiguousCollectionDateCount += 1;
        }
      }
    }
    const criticalStatuses = CRITICAL_FIELDS.map((field) => match.fields[field].status);
    if (criticalStatuses.every((status) => status === 'correct')) {
      criticalCorrectCount += 1;
      correctMeasurementCount += 1;
    } else if (criticalStatuses.some((status) => status === 'unresolved')) {
      criticalUnresolvedCount += 1;
    } else {
      criticalIncorrectCount += 1;
    }
    const hasNonNullCriticalMismatch = CRITICAL_FIELDS.some((field) => {
      const result = match.fields[field];
      // A missing unit/value/date is a missing field, not evidence that the parser attached a
      // different field to this row. Count an association as wrong only when both source and
      // parser supplied conflicting values (or a non-null source label differs).
      return result.status === 'incorrect' && result.expected !== null && result.actual !== null;
    });
    if (hasNonNullCriticalMismatch) wrongAssociationCount += 1;

    const labelValueStatuses = [match.fields.sourceLabel.status, match.fields.valueString.status];
    if (labelValueStatuses.every((status) => status === 'correct')) labelValueCorrectCount += 1;
    else if (labelValueStatuses.some((status) => status === 'unresolved'))
      labelValueUnresolvedCount += 1;
    else labelValueIncorrectCount += 1;

    const expectedCanonical = expectedMeasurements[match.expectedIndex]!.canonicalBiomarkerId;
    const actualCanonical = pipeline.measurements[match.pipelineIndex]!.canonicalBiomarkerId;
    const expectedCanonicalFieldPresent = Object.hasOwn(
      expectedMeasurements[match.expectedIndex]!,
      'canonicalBiomarkerId',
    );
    if (actualCanonical === undefined) {
      pipelineCanonicalFieldAbsentCount += 1;
      mappingUnevaluatedCount += 1;
    } else if (actualCanonical === null) {
      pipelineUnmappedCount += 1;
      if (!expectedCanonicalFieldPresent) {
        mappingUnevaluatedCount += 1;
      } else if (expectedCanonical === null) {
        mappingEvaluatedCount += 1;
        mappingCorrectCount += 1;
      } else {
        mappingEvaluatedCount += 1;
        mappingUnsupportedCount += 1;
      }
    } else {
      pipelineMappedCount += 1;
      if (!expectedCanonicalFieldPresent) {
        mappingUnevaluatedCount += 1;
      } else if (expectedCanonical === null) {
        mappingEvaluatedCount += 1;
        mappingIncorrectCount += 1;
      } else {
        mappingEvaluatedCount += 1;
        if (actualCanonical === expectedCanonical) mappingCorrectCount += 1;
        else mappingIncorrectCount += 1;
      }
    }
    const expectedTrend = expectedMeasurements[match.expectedIndex]!.trendEligible;
    const actualTrend = pipeline.measurements[match.pipelineIndex]!.trendEligible;
    if (
      expectedTrend === undefined ||
      expectedTrend === null ||
      actualTrend === undefined ||
      actualTrend === null
    ) {
      trendUnevaluatedCount += 1;
    } else {
      trendEvaluatedCount += 1;
      if (actualTrend === expectedTrend) trendCorrectCount += 1;
      else trendIncorrectCount += 1;
    }
  }

  for (let left = 0; left < matched.matches.length; left += 1) {
    for (let right = left + 1; right < matched.matches.length; right += 1) {
      const leftMatch = matched.matches[left]!;
      const rightMatch = matched.matches[right]!;
      const expectedLeft = expectedMeasurements[leftMatch.expectedIndex]!.collectionGroup;
      const expectedRight = expectedMeasurements[rightMatch.expectedIndex]!.collectionGroup;
      const actualLeft = pipeline.measurements[leftMatch.pipelineIndex]!.collectionGroup;
      const actualRight = pipeline.measurements[rightMatch.pipelineIndex]!.collectionGroup;
      if (
        expectedLeft === null ||
        expectedRight === null ||
        actualLeft === null ||
        actualRight === null
      ) {
        groupUnresolvedCount += 1;
      } else if ((expectedLeft === expectedRight) === (actualLeft === actualRight)) {
        groupCorrectCount += 1;
      } else {
        groupIncorrectCount += 1;
      }
    }
  }

  const exactKeyExpectedCounts = new Map<string, number>();
  for (const item of expectedMeasurements) {
    const key = sourceTupleKey(item);
    exactKeyExpectedCounts.set(key, (exactKeyExpectedCounts.get(key) ?? 0) + 1);
  }
  const exactKeyPipelineCounts = new Map<string, number>();
  for (const item of pipeline.measurements) {
    const key = sourceTupleKey(item);
    exactKeyPipelineCounts.set(key, (exactKeyPipelineCounts.get(key) ?? 0) + 1);
  }
  let duplicateCount = 0;
  for (const [key, count] of exactKeyPipelineCounts) {
    const expectedCount = exactKeyExpectedCounts.get(key) ?? 0;
    // One novel source tuple is a spurious output. Only additional occurrences of that tuple
    // are duplicates; a mismatched value that was paired by label/page is never a duplicate.
    duplicateCount += Math.max(0, count - Math.max(1, expectedCount));
  }
  const spuriousCount = Math.max(0, matched.unmatchedPipeline.length - duplicateCount);

  return {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: expected.reportId,
    reportSha256: expected.reportSha256,
    pipeline: { id: pipeline.pipeline.id, version: pipeline.pipeline.version },
    status: 'complete',
    pageScope,
    expectedMeasurementCount: expectedMeasurements.length,
    outputMeasurementCount: pipeline.measurements.length,
    recoveredMeasurementCount: labelValueCorrectCount,
    matchedMeasurementCount: matched.matches.length,
    exactSourceTupleMatchCount,
    correctMeasurementCount,
    missingCount: matched.unmatchedExpected.length,
    spuriousCount,
    duplicateCount,
    wrongAssociationCount,
    fieldScores,
    criticalAssociation: {
      correctCount: criticalCorrectCount,
      incorrectCount: criticalIncorrectCount,
      unresolvedCount: criticalUnresolvedCount,
      denominator: criticalCorrectCount + criticalIncorrectCount,
    },
    labelValueAssociation: {
      correctCount: labelValueCorrectCount,
      incorrectCount: labelValueIncorrectCount,
      unresolvedCount: labelValueUnresolvedCount,
      denominator: labelValueCorrectCount + labelValueIncorrectCount,
    },
    groupAssociation: {
      correctCount: groupCorrectCount,
      incorrectCount: groupIncorrectCount,
      unresolvedCount: groupUnresolvedCount,
      denominator: groupCorrectCount + groupIncorrectCount,
    },
    mapping: {
      evaluatedCount: mappingEvaluatedCount,
      correctCount: mappingCorrectCount,
      incorrectCount: mappingIncorrectCount,
      unsupportedCount: mappingUnsupportedCount,
      unevaluatedCount: mappingUnevaluatedCount,
      pipelineMappedCount,
      pipelineUnmappedCount,
      pipelineCanonicalFieldAbsentCount,
    },
    trendEligibility: {
      evaluatedCount: trendEvaluatedCount,
      correctCount: trendCorrectCount,
      incorrectCount: trendIncorrectCount,
      unevaluatedCount: trendUnevaluatedCount,
    },
    correctionBurden: {
      changedFieldCount,
      expectedAmbiguousFieldCount,
      pipelineUnresolvedFieldCount,
      unresolvedFieldCount: expectedAmbiguousFieldCount + pipelineUnresolvedFieldCount,
      unexpectedPopulatedFieldCount,
      inventedAmbiguousFieldCount,
      inventedAmbiguousCollectionDateCount,
    },
    elapsedMs: pipeline.elapsedMs,
    stageTimings: pipeline.stages.map((stage) => ({
      elapsedMs: stage.elapsedMs,
      status: stage.status,
    })),
    diagnostics: { totalCount: totalDiagnosticCount(pipeline) },
    matches: matched.matches.map((match) => ({
      ...match,
      expectedIndex: expectedOriginalIndices[match.expectedIndex]!,
    })),
    missingMeasurementIds: matched.unmatchedExpected.map(
      (index) => expectedMeasurements[index]!.id,
    ),
    spuriousMeasurementIds: matched.unmatchedPipeline.map(
      (index) => pipeline.measurements[index]!.id,
    ),
  };
}

const SAFE_TOKEN = /^[a-zA-Z0-9._-]{1,80}$/u;
function safeToken(value: string): string {
  return SAFE_TOKEN.test(value) ? value : 'redacted';
}

function safeStageStatus(value: string): string {
  return SAFE_TOKEN.test(value) ? value : 'other';
}

export function toSafeAggregate(score: DetailedScore): SafeAggregate {
  return {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: safeToken(score.reportId),
    reportSha256: score.reportSha256,
    pipeline: { id: safeToken(score.pipeline.id), version: safeToken(score.pipeline.version) },
    status: score.status,
    pageScope: score.pageScope,
    counts: {
      expectedMeasurements: score.expectedMeasurementCount,
      producedMeasurements: score.outputMeasurementCount,
      recoveredMeasurements: score.recoveredMeasurementCount,
      matchedMeasurements: score.matchedMeasurementCount,
      exactSourceTupleMatches: score.exactSourceTupleMatchCount,
      correctMeasurements: score.correctMeasurementCount,
      missing: score.missingCount,
      spurious: score.spuriousCount,
      duplicates: score.duplicateCount,
      wrongAssociations: score.wrongAssociationCount,
    },
    criticalAssociation: score.criticalAssociation,
    labelValueAssociation: score.labelValueAssociation,
    groupAssociation: score.groupAssociation,
    fieldScores: score.fieldScores,
    mapping: score.mapping,
    trendEligibility: score.trendEligibility,
    correctionBurden: score.correctionBurden,
    elapsedMs: score.elapsedMs,
    stageTimings: score.stageTimings.map((stage, stageIndex) => ({
      stageIndex,
      elapsedMs: stage.elapsedMs,
      status: safeStageStatus(stage.status),
    })),
    diagnostics: score.diagnostics,
  };
}

export function renderAggregateMarkdown(aggregates: readonly SafeAggregate[]): string {
  const lines = [
    '# Import evaluation comparison',
    '',
    '| Report | Pipeline | Scope / denominator | Expected | Produced | Recovered label/value | Correct critical rows | Missing | Spurious | Duplicates | Wrong associations | Time (ms) |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const aggregate of aggregates) {
    const scope =
      aggregate.pageScope.pages === null
        ? `all (${aggregate.pageScope.scoredExpectedMeasurementCount}/${aggregate.pageScope.fullExpectedMeasurementCount})`
        : `pages ${aggregate.pageScope.pages.join(',')} (${aggregate.pageScope.scoredExpectedMeasurementCount}/${aggregate.pageScope.fullExpectedMeasurementCount})`;
    lines.push(
      `| ${safeToken(aggregate.reportId)} | ${safeToken(aggregate.pipeline.id)} | ${scope} | ${aggregate.counts.expectedMeasurements} | ${aggregate.counts.producedMeasurements} | ${aggregate.counts.recoveredMeasurements} | ${aggregate.counts.correctMeasurements} | ${aggregate.counts.missing} | ${aggregate.counts.spurious} | ${aggregate.counts.duplicates} | ${aggregate.counts.wrongAssociations} | ${aggregate.elapsedMs} |`,
    );
  }
  lines.push(
    '',
    'Field scores and correction-burden values are aggregate proxies; they do not represent user time.',
    '',
  );
  return lines.join('\n');
}

export function scoreFiles(options: {
  readonly reportPath: string;
  readonly reportId: string;
  readonly expectedPath: string;
  readonly pipelinePath: string;
  readonly outputPath?: string;
  readonly aggregateOutputPath?: string;
  readonly privateRoot: string;
  readonly pages?: readonly number[];
}): { readonly detailed: DetailedScore; readonly aggregate: SafeAggregate } {
  const reportPath = assertPrivatePath(options.reportPath, options.privateRoot);
  const expectedPath = assertPrivatePath(options.expectedPath, options.privateRoot);
  const pipelinePath = assertPrivatePath(options.pipelinePath, options.privateRoot);
  securePrivateFile(reportPath);
  securePrivateFile(expectedPath);
  securePrivateFile(pipelinePath);
  const outputPath =
    options.outputPath === undefined
      ? undefined
      : assertPrivatePath(options.outputPath, options.privateRoot);
  const aggregateOutputPath =
    options.aggregateOutputPath === undefined
      ? undefined
      : assertPrivatePath(options.aggregateOutputPath, options.privateRoot);
  const expected = readExpectedResults(expectedPath);
  const reportSha256 = verifyReportAndGroundTruth(reportPath, expected, options.reportId);
  const pipeline = parsePipelineResult(readJsonFile(pipelinePath));
  assertPipelineIdentity(pipeline, expected, reportSha256);
  const detailed = scoreEvaluation(expected, pipeline, options);
  const aggregate: SafeAggregate = {
    ...toSafeAggregate(detailed),
    groundTruthSha256: sha256File(expectedPath),
    groundTruthVersion: expected.groundTruthVersion,
  };
  if (outputPath !== undefined) {
    ensurePrivateDirectory(dirname(outputPath));
    writeJsonFile(outputPath, detailed);
  }
  if (aggregateOutputPath !== undefined) {
    ensurePrivateDirectory(dirname(aggregateOutputPath));
    writeJsonFile(aggregateOutputPath, aggregate);
  }
  return { detailed, aggregate };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index >= 0 && value !== undefined ? value : undefined;
}

function parsePageArgument(value: string): readonly number[] {
  const tokens = value.split(',').map((item) => item.trim());
  if (tokens.length === 0 || tokens.some((token) => !/^[1-9]\d*$/u.test(token))) {
    throw new Error('--pages must be a comma-separated list of positive integer pages');
  }
  return tokens.map((token) => Number(token));
}

function main(): void {
  const reportPath = argumentValue('--report');
  const reportId = argumentValue('--report-id');
  const expectedPath = argumentValue('--expected');
  const pipelinePath = argumentValue('--pipeline');
  const privateRoot = argumentValue('--private-root');
  const outputPath = argumentValue('--output');
  const aggregateOutputPath = argumentValue('--aggregate-output');
  const pagesArgument = argumentValue('--pages');
  if (process.argv.includes('--pages') && pagesArgument === undefined) {
    throw new Error('--pages must be a comma-separated list of positive integer pages');
  }
  if (!reportPath || !reportId || !expectedPath || !pipelinePath || !privateRoot) {
    throw new Error(
      '--report, --report-id, --expected, --pipeline, and --private-root are required',
    );
  }
  const result = scoreFiles({
    reportPath,
    reportId,
    expectedPath,
    pipelinePath,
    privateRoot,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(aggregateOutputPath === undefined ? {} : { aggregateOutputPath }),
    ...(pagesArgument === undefined ? {} : { pages: parsePageArgument(pagesArgument) }),
  });
  process.stdout.write(`${JSON.stringify(result.aggregate)}\n`);
}

if (process.argv[1]?.endsWith('/score.ts') === true) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'import evaluation failed');
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}
