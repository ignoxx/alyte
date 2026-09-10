import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  IMPORT_EVALUATION_SCHEMA_VERSION,
  parseExpectedResults,
  parsePipelineResult,
  verifyReportAndGroundTruth,
  type EvaluationMeasurement,
  type ExpectedResults,
  type PipelineResult,
} from './contract';
import { renderAggregateMarkdown, scoreEvaluation, scoreFiles, toSafeAggregate } from './score';

const REPORT_BYTES = Buffer.from('synthetic-evaluation-document');
const REPORT_HASH = createHash('sha256').update(REPORT_BYTES).digest('hex');

function measurement(overrides: Partial<EvaluationMeasurement> = {}): EvaluationMeasurement {
  return {
    id: 'measurement-1',
    sourceLabel: 'Marker Alpha',
    valueString: '10',
    valueType: 'numeric',
    parsedValue: 10,
    comparator: '=',
    unit: 'unit-a',
    referenceInterval: '1-20',
    flag: null,
    collectionDate: '2026-01-01',
    collectionGroup: 'group-a',
    specimen: 'serum',
    page: 1,
    location: null,
    ambiguousFields: [],
    ...overrides,
  };
}

function expected(measurements: readonly EvaluationMeasurement[]): ExpectedResults {
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: 'synthetic',
    reportSha256: REPORT_HASH,
    groundTruthVersion: 1,
    review: {
      status: 'source-checked',
      method: 'synthetic source review',
      reviewedPages: [1],
      notes: [],
    },
    measurements,
  };
}

function pipeline(measurements: readonly EvaluationMeasurement[]): PipelineResult {
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: 'synthetic',
    reportSha256: REPORT_HASH,
    pipeline: { id: 'synthetic-parser', version: 'test', configuration: {}, runtime: {} },
    stages: [
      {
        name: 'parse',
        elapsedMs: 4,
        inputCount: 1,
        outputCount: measurements.length,
        status: 'success',
      },
    ],
    elapsedMs: 5,
    measurements,
    diagnostics: { counts: {}, limitations: [] },
  };
}

test('pairs same-label rows to expose swapped values, units, and dates as wrong associations', () => {
  const expectedRows = [
    measurement({
      id: 'a',
      sourceLabel: 'Marker Alpha',
      valueString: '10',
      parsedValue: 10,
      unit: 'unit-a',
      collectionDate: '2026-01-01',
    }),
    measurement({
      id: 'b',
      sourceLabel: 'Marker Beta',
      valueString: '20',
      parsedValue: 20,
      unit: 'unit-b',
      collectionDate: '2026-02-01',
    }),
  ];
  const pipelineRows = [
    measurement({
      id: 'pa',
      sourceLabel: 'Marker Alpha',
      valueString: '20',
      parsedValue: 20,
      unit: 'unit-b',
      collectionDate: '2026-02-01',
    }),
    measurement({
      id: 'pb',
      sourceLabel: 'Marker Beta',
      valueString: '10',
      parsedValue: 10,
      unit: 'unit-a',
      collectionDate: '2026-01-01',
    }),
  ];
  const result = scoreEvaluation(expected(expectedRows), pipeline(pipelineRows));
  assert.equal(result.missingCount, 0);
  assert.equal(result.spuriousCount, 0);
  assert.equal(result.wrongAssociationCount, 2);
  assert.equal(result.criticalAssociation.correctCount, 0);
  assert.equal(result.criticalAssociation.incorrectCount, 2);
  assert.equal(result.fieldScores.valueString.incorrect, 2);
  assert.equal(result.fieldScores.unit.incorrect, 2);
  assert.equal(result.fieldScores.collectionDate.incorrect, 2);
});

test('keeps full-report scoring as the default and records its full denominator', () => {
  const result = scoreEvaluation(
    expected([measurement()]),
    pipeline([measurement({ id: 'actual' })]),
  );
  assert.deepEqual(result.pageScope, {
    pages: null,
    fullExpectedMeasurementCount: 1,
    scoredExpectedMeasurementCount: 1,
  });
  assert.equal(result.expectedMeasurementCount, 1);
  assert.equal(toSafeAggregate(result).pageScope.scoredExpectedMeasurementCount, 1);
});

test('scores selected pages in memory while retaining the full truth denominator', () => {
  const expectedRows = [
    measurement({ id: 'page-1', sourceLabel: 'Marker Page One', page: 1 }),
    measurement({ id: 'page-3', sourceLabel: 'Marker Page Three', page: 3 }),
  ];
  const result = scoreEvaluation(
    expected(expectedRows),
    pipeline([{ ...expectedRows[1]!, id: 'parsed-page-3' }]),
    { pages: [3, 3] },
  );
  assert.deepEqual(result.pageScope, {
    pages: [3],
    fullExpectedMeasurementCount: 2,
    scoredExpectedMeasurementCount: 1,
  });
  assert.equal(result.expectedMeasurementCount, 1);
  assert.equal(result.missingCount, 0);
  assert.equal(result.spuriousCount, 0);
  assert.equal(result.matches[0]?.expectedIndex, 1);
  assert.equal(result.matches[0]?.fields.sourceLabel.expected, 'Marker Page Three');
  const aggregate = toSafeAggregate(result);
  assert.deepEqual(aggregate.pageScope.pages, [3]);
  assert.match(renderAggregateMarkdown([aggregate]), /pages 3 \(1\/2\)/u);
});

test('rejects pipeline rows outside a selected page scope instead of hiding them', () => {
  const expectedRows = [
    measurement({ id: 'page-1', sourceLabel: 'Marker Page One', page: 1 }),
    measurement({ id: 'page-3', sourceLabel: 'Marker Page Three', page: 3 }),
  ];
  assert.throws(
    () =>
      scoreEvaluation(
        expected(expectedRows),
        pipeline(expectedRows.map((row) => ({ ...row, id: `parsed-${row.id}` }))),
        { pages: [3] },
      ),
    /outside the selected page scope/u,
  );
  assert.throws(
    () =>
      scoreEvaluation(
        expected(expectedRows),
        pipeline([{ ...expectedRows[1]!, id: 'parsed-null-page', page: null }]),
        { pages: [3] },
      ),
    /outside the selected page scope/u,
  );
});

test('rejects empty, zero, fractional, and unsafe page selections', () => {
  const expectedRow = measurement({ page: 3 });
  const pipelineRow = pipeline([{ ...expectedRow, id: 'parsed' }]);
  for (const pages of [[], [0], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(
      () => scoreEvaluation(expected([expectedRow]), pipelineRow, { pages }),
      /positive integer pages/u,
    );
  }
});

test('counts extra exact source occurrences as duplicates while retaining bounded and categorical rows', () => {
  const bounded = measurement({
    id: 'bounded',
    sourceLabel: 'Marker Bound',
    valueString: '<5',
    valueType: 'bounded',
    parsedValue: 5,
    comparator: '<',
    canonicalBiomarkerId: null,
  });
  const categorical = measurement({
    id: 'categorical',
    sourceLabel: 'Marker State',
    valueString: 'Present',
    valueType: 'categorical',
    parsedValue: 'Present',
    canonicalBiomarkerId: 'biomarker.state',
  });
  const result = scoreEvaluation(
    expected([bounded, categorical]),
    pipeline([
      { ...bounded, id: 'parsed-bounded-1' },
      { ...bounded, id: 'parsed-bounded-2' },
      { ...categorical, id: 'parsed-categorical', canonicalBiomarkerId: null },
    ]),
  );
  assert.equal(result.missingCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.spuriousCount, 0);
  assert.equal(result.mapping.evaluatedCount, 2);
  assert.equal(result.mapping.correctCount, 1);
  assert.equal(result.mapping.unevaluatedCount, 0);
  assert.equal(result.mapping.unsupportedCount, 1);
  assert.equal(result.mapping.pipelineMappedCount, 0);
  assert.equal(result.mapping.pipelineUnmappedCount, 2);
  assert.equal(result.mapping.pipelineCanonicalFieldAbsentCount, 0);
  assert.equal(result.fieldScores.valueType.correct, 2);
});

test('distinguishes unevaluated mapping fields from reviewed unsupported mappings', () => {
  const absent = measurement({ id: 'absent' });
  const unsupported = measurement({ id: 'unsupported', canonicalBiomarkerId: null });
  const mapped = measurement({ id: 'mapped', canonicalBiomarkerId: 'biomarker.alpha' });
  const result = scoreEvaluation(
    expected([absent, unsupported, mapped]),
    pipeline([
      { ...absent, id: 'parsed-absent' },
      { ...unsupported, id: 'parsed-unsupported' },
      { ...mapped, id: 'parsed-mapped', canonicalBiomarkerId: null },
    ]),
  );
  assert.equal(result.mapping.evaluatedCount, 2);
  assert.equal(result.mapping.correctCount, 1);
  assert.equal(result.mapping.incorrectCount, 0);
  assert.equal(result.mapping.unsupportedCount, 1);
  assert.equal(result.mapping.unevaluatedCount, 1);
  assert.equal(result.mapping.pipelineMappedCount, 0);
  assert.equal(result.mapping.pipelineUnmappedCount, 2);
  assert.equal(result.mapping.pipelineCanonicalFieldAbsentCount, 1);

  const falsePositive = scoreEvaluation(
    expected([unsupported]),
    pipeline([
      { ...unsupported, id: 'parsed-false-positive', canonicalBiomarkerId: 'biomarker.alpha' },
    ]),
  );
  assert.equal(falsePositive.mapping.evaluatedCount, 1);
  assert.equal(falsePositive.mapping.correctCount, 0);
  assert.equal(falsePositive.mapping.incorrectCount, 1);
  assert.equal(falsePositive.mapping.unsupportedCount, 0);
});

test('scores explicit trend eligibility booleans without treating absence as false', () => {
  const eligible = measurement({ id: 'eligible', trendEligible: true });
  const ineligible = measurement({ id: 'ineligible', trendEligible: false });
  const result = scoreEvaluation(
    expected([eligible, ineligible]),
    pipeline([
      { ...eligible, id: 'parsed-eligible', trendEligible: true },
      { ...ineligible, id: 'parsed-ineligible', trendEligible: false },
    ]),
  );
  assert.equal(result.trendEligibility.evaluatedCount, 2);
  assert.equal(result.trendEligibility.correctCount, 2);
  assert.equal(result.trendEligibility.incorrectCount, 0);
  assert.equal(result.trendEligibility.unevaluatedCount, 0);

  const mismatch = scoreEvaluation(
    expected([eligible, ineligible]),
    pipeline([
      { ...eligible, id: 'parsed-ineligible', trendEligible: false },
      { ...ineligible, id: 'parsed-eligible', trendEligible: true },
    ]),
  );
  assert.equal(mismatch.trendEligibility.correctCount, 0);
  assert.equal(mismatch.trendEligibility.incorrectCount, 2);
});

test('keeps missing parser trend eligibility unevaluated', () => {
  const expectedRows = [
    measurement({ id: 'expected-true', trendEligible: true }),
    measurement({ id: 'expected-false', trendEligible: false }),
  ];
  const result = scoreEvaluation(
    expected(expectedRows),
    pipeline([
      { ...expectedRows[0]!, id: 'parsed-null', trendEligible: null },
      (() => {
        const { trendEligible, ...withoutTrend } = expectedRows[1]!;
        void trendEligible;
        return { ...withoutTrend, id: 'parsed-absent' };
      })(),
    ]),
  );
  assert.equal(result.trendEligibility.evaluatedCount, 0);
  assert.equal(result.trendEligibility.correctCount, 0);
  assert.equal(result.trendEligibility.incorrectCount, 0);
  assert.equal(result.trendEligibility.unevaluatedCount, 2);
});

test('classifies a novel output as spurious before counting only its repeats as duplicates', () => {
  const expectedRow = measurement({ id: 'expected' });
  const novel = measurement({
    id: 'novel-1',
    sourceLabel: 'Marker Novel',
    valueString: '99',
    parsedValue: 99,
  });
  const unique = scoreEvaluation(expected([expectedRow]), pipeline([novel]));
  assert.equal(unique.spuriousCount, 1);
  assert.equal(unique.duplicateCount, 0);
  const repeated = scoreEvaluation(
    expected([expectedRow]),
    pipeline([novel, { ...novel, id: 'novel-2' }]),
  );
  assert.equal(repeated.spuriousCount, 1);
  assert.equal(repeated.duplicateCount, 1);
});

test('keeps ambiguous dates out of correctness while counting an invented resolved date', () => {
  const expectedRow = measurement({
    id: 'ambiguous-date',
    collectionDate: null,
    ambiguousFields: ['collectionDate'],
  });
  const result = scoreEvaluation(
    expected([expectedRow]),
    pipeline([{ ...expectedRow, id: 'parsed', collectionDate: '2026-03-01' }]),
  );
  assert.equal(result.fieldScores.collectionDate.denominator, 0);
  assert.equal(result.fieldScores.collectionDate.unresolved, 1);
  assert.equal(result.criticalAssociation.unresolvedCount, 1);
  assert.equal(result.correctionBurden.inventedAmbiguousFieldCount, 1);
  assert.equal(result.correctionBurden.inventedAmbiguousCollectionDateCount, 1);
});

test('does not label a missing unit as a wrong association', () => {
  const expectedRow = measurement({ id: 'unit-known', unit: 'unit-a' });
  const result = scoreEvaluation(
    expected([expectedRow]),
    pipeline([{ ...expectedRow, id: 'parsed-without-unit', unit: null }]),
  );
  assert.equal(result.fieldScores.unit.incorrect, 1);
  assert.equal(result.wrongAssociationCount, 0);
  assert.equal(result.recoveredMeasurementCount, 1);
  assert.equal(result.outputMeasurementCount, 1);
});

test('scores collection grouping by pairwise membership instead of literal local ids', () => {
  const expectedRows = [
    measurement({ id: 'group-a1', sourceLabel: 'Marker A', collectionGroup: 'source-serum' }),
    measurement({ id: 'group-a2', sourceLabel: 'Marker B', collectionGroup: 'source-serum' }),
    measurement({ id: 'group-b', sourceLabel: 'Marker C', collectionGroup: 'source-urine' }),
  ];
  const pipelineRows = [
    { ...expectedRows[0]!, id: 'parsed-a1', collectionGroup: 'parser-group-1' },
    { ...expectedRows[1]!, id: 'parsed-a2', collectionGroup: 'parser-group-2' },
    { ...expectedRows[2]!, id: 'parsed-b', collectionGroup: 'parser-group-2' },
  ];
  const result = scoreEvaluation(expected(expectedRows), pipeline(pipelineRows));
  assert.equal(result.fieldScores.collectionGroup.denominator, 0);
  assert.equal(result.groupAssociation.correctCount, 1);
  assert.equal(result.groupAssociation.incorrectCount, 2);
});

test('does not score hash-mismatched or draft ground truth', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-import-eval-'));
  const reportPath = join(directory, 'report.pdf');
  writeFileSync(reportPath, REPORT_BYTES);
  const reviewed = expected([]);
  assert.equal(verifyReportAndGroundTruth(reportPath, reviewed, 'synthetic'), REPORT_HASH);
  assert.throws(
    () =>
      verifyReportAndGroundTruth(
        reportPath,
        { ...reviewed, reportSha256: '0'.repeat(64) },
        'synthetic',
      ),
    /report hash does not match ground truth/u,
  );
  assert.throws(
    () =>
      verifyReportAndGroundTruth(
        reportPath,
        { ...reviewed, review: { ...reviewed.review, status: 'draft' } },
        'synthetic',
      ),
    /ground truth is not source-checked/u,
  );
});

test('rejects standalone score inputs and outputs that resolve outside the private root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-import-score-paths-'));
  const privateRoot = join(directory, 'private');
  const reportPath = join(privateRoot, 'reports', 'report.pdf');
  const expectedPath = join(privateRoot, 'ground-truth', 'report.json');
  const pipelinePath = join(privateRoot, 'runs', 'pipeline.json');
  mkdirSync(join(privateRoot, 'reports'), { recursive: true });
  mkdirSync(join(privateRoot, 'ground-truth'), { recursive: true });
  mkdirSync(join(privateRoot, 'runs'), { recursive: true });
  writeFileSync(reportPath, REPORT_BYTES);
  writeFileSync(expectedPath, JSON.stringify(expected([])));
  writeFileSync(pipelinePath, JSON.stringify(pipeline([])));

  const base = {
    reportPath,
    reportId: 'synthetic',
    expectedPath,
    pipelinePath,
    privateRoot,
  };
  assert.throws(
    () => scoreFiles({ ...base, pipelinePath: join(directory, 'outside-pipeline.json') }),
    /private root/u,
  );

  const outside = join(directory, 'outside');
  mkdirSync(outside);
  const escapedOutputDirectory = join(privateRoot, 'runs', 'escaped');
  symlinkSync(outside, escapedOutputDirectory);
  assert.throws(
    () => scoreFiles({ ...base, outputPath: join(escapedOutputDirectory, 'score.json') }),
    /private root/u,
  );

  const danglingOutputDirectory = join(privateRoot, 'runs', 'dangling');
  symlinkSync(join(directory, 'missing-target'), danglingOutputDirectory);
  assert.throws(
    () => scoreFiles({ ...base, outputPath: join(danglingOutputDirectory, 'score.json') }),
    /private root/u,
  );

  const outputPath = join(privateRoot, 'scores', 'report.score.json');
  scoreFiles({ ...base, outputPath });
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(privateRoot, 'scores')).mode & 0o777, 0o700);
});

test('binds standalone aggregate output to the exact expected truth file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-import-score-binding-'));
  const privateRoot = join(directory, 'private');
  const reportPath = join(privateRoot, 'reports', 'report.pdf');
  const expectedPath = join(privateRoot, 'ground-truth', 'report.json');
  const pipelinePath = join(privateRoot, 'runs', 'pipeline.json');
  const aggregateOutputPath = join(privateRoot, 'aggregate', 'report.aggregate.json');
  mkdirSync(join(privateRoot, 'reports'), { recursive: true });
  mkdirSync(join(privateRoot, 'ground-truth'), { recursive: true });
  mkdirSync(join(privateRoot, 'runs'), { recursive: true });
  writeFileSync(reportPath, REPORT_BYTES);
  writeFileSync(expectedPath, JSON.stringify(expected([])));
  writeFileSync(pipelinePath, JSON.stringify(pipeline([])));

  const result = scoreFiles({
    reportPath,
    reportId: 'synthetic',
    expectedPath,
    pipelinePath,
    aggregateOutputPath,
    privateRoot,
  });
  const expectedFileSha256 = createHash('sha256').update(readFileSync(expectedPath)).digest('hex');
  assert.equal(result.aggregate.groundTruthSha256, expectedFileSha256);
  assert.equal(result.aggregate.groundTruthVersion, 1);
  const persisted = JSON.parse(readFileSync(aggregateOutputPath, 'utf8')) as {
    readonly groundTruthSha256?: string;
    readonly groundTruthVersion?: number;
  };
  assert.equal(persisted.groundTruthSha256, expectedFileSha256);
  assert.equal(persisted.groundTruthVersion, 1);
});

test('aggregate projection contains counts and timings without measurement fields', () => {
  const result = scoreEvaluation(
    expected([measurement()]),
    pipeline([measurement({ id: 'actual' })]),
  );
  const aggregate = toSafeAggregate(result);
  const serialized = JSON.stringify(aggregate);
  assert.equal(serialized.includes('Marker Alpha'), false);
  assert.equal(serialized.includes('unit-a'), false);
  assert.equal(serialized.includes('10'), false);
  assert.equal(aggregate.counts.correctMeasurements, 1);
  assert.match(renderAggregateMarkdown([aggregate]), /synthetic-parser/u);
});

test('contract rejects duplicate measurement identifiers', () => {
  const row = measurement();
  assert.throws(
    () => parseExpectedResults(expected([row, row])),
    /measurement ids must be unique/u,
  );
  assert.throws(
    () => parsePipelineResult(pipeline([row, { ...row }])),
    /measurement ids must be unique/u,
  );
});
