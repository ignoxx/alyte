import test from 'node:test';
import assert from 'node:assert/strict';
import { collectComparison, renderComparisonMarkdown } from './collect-comparison';

function aggregate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: 'lt',
    reportSha256: 'a'.repeat(64),
    status: 'complete',
    pipeline: { id: 'native', version: 'v1' },
    counts: {
      expectedMeasurements: 10,
      producedMeasurements: 8,
      recoveredMeasurements: 6,
      matchedMeasurements: 7,
      exactSourceTupleMatches: 6,
      correctMeasurements: 5,
      missing: 4,
      spurious: 1,
      duplicates: 1,
      wrongAssociations: 3,
    },
    criticalAssociation: { correctCount: 5, incorrectCount: 1, unresolvedCount: 1, denominator: 6 },
    labelValueAssociation: {
      correctCount: 6,
      incorrectCount: 1,
      unresolvedCount: 0,
      denominator: 7,
    },
    fieldScores: {
      sourceLabel: { correct: 7, incorrect: 0, unresolved: 0, denominator: 7 },
      valueString: { correct: 6, incorrect: 1, unresolved: 0, denominator: 7 },
      secretHealthField: { unresolved: 99 },
    },
    correctionBurden: {
      changedFieldCount: 2,
      expectedAmbiguousFieldCount: 1,
      pipelineUnresolvedFieldCount: 3,
      unresolvedFieldCount: 2,
      unexpectedPopulatedFieldCount: 0,
      inventedAmbiguousFieldCount: 0,
      inventedAmbiguousCollectionDateCount: 0,
      privateHealthProxy: 99,
    },
    elapsedMs: 123,
    stageTimings: [{ stageIndex: 0, elapsedMs: 100, status: 'success' }],
    diagnostics: { totalCount: 9 },
    ...overrides,
  };
}

test('collects compatible pipelines into safe rows and preserves strict denominators', () => {
  const comparison = collectComparison([
    aggregate(),
    aggregate({
      pipeline: { id: 'vision', version: 'v2' },
      provenance: { codeVersion: 'abc', sourceSha256: 'b'.repeat(64), ignored: 'health' },
    }),
  ]);
  assert.equal(comparison.aggregateInputCount, 2);
  assert.equal(comparison.pipelines.length, 2);
  assert.equal(comparison.pipelines[0]?.counts.recoveredLabelValue, 6);
  assert.equal(comparison.pipelines[0]?.counts.fullyCorrectCritical, 5);
  assert.equal(comparison.pipelines[0]?.associations.fullyCorrectCritical.denominator, 6);
  assert.equal(comparison.pipelines[0]?.counts.wrongOtherAssociationsLowerBound, 2);
  assert.deepEqual(comparison.pipelines[1]?.provenance, {
    codeVersion: 'abc',
    sourceSha256: 'b'.repeat(64),
  });
  const markdown = renderComparisonMarkdown(comparison);
  assert.match(markdown, /Fully correct critical/);
  assert.match(markdown, /strict critical-row count/);
  assert.doesNotMatch(markdown, /ignored/);
  assert.doesNotMatch(JSON.stringify(comparison), /secretHealthField|privateHealthProxy/);
  assert.doesNotMatch(markdown, /secretHealthField|privateHealthProxy/);
});

test('rejects incompatible report hashes, expected counts, and duplicate identities', () => {
  assert.throws(
    () => collectComparison([aggregate(), aggregate({ reportSha256: 'b'.repeat(64) })]),
    /incompatible report hashes/,
  );
  assert.throws(
    () =>
      collectComparison([
        aggregate(),
        aggregate({ counts: { ...(aggregate().counts as object), expectedMeasurements: 11 } }),
      ]),
    /incompatible report hashes/,
  );
  assert.throws(() => collectComparison([aggregate(), aggregate()]), /duplicate pipeline identity/);
});

test('rejects incompatible explicit expected sets', () => {
  assert.throws(
    () =>
      collectComparison([
        aggregate({ expectedSetId: 'set-a' }),
        aggregate({ pipeline: { id: 'other', version: 'v1' }, expectedSetId: 'set-b' }),
      ]),
    /incompatible expected sets/,
  );
});

test('accepts per-report aggregate wrappers with their own expected-set hash', () => {
  const wrap = (
    reportId: string,
    reportSha256: string,
    groundTruthSha256: string,
    pipelineId: string,
  ) => ({
    schemaVersion: 'alyte.import-eval.v1',
    reportId,
    reportSha256,
    groundTruthSha256,
    pipelines: [aggregate({ reportId, reportSha256, pipeline: { id: pipelineId, version: 'v1' } })],
  });
  const result = collectComparison([
    wrap('lt', 'a'.repeat(64), 'b'.repeat(64), 'native'),
    wrap('en', 'c'.repeat(64), 'd'.repeat(64), 'native'),
  ]);
  assert.equal(result.reportIdentities.length, 2);
  assert.equal(result.pipelines.length, 2);
});
