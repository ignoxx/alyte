import assert from 'node:assert/strict';
import test from 'node:test';
import { attachCollectionDateMetadata } from './metadata-attachment';
import type { EvaluationMeasurement } from './contract';
import type { MetadataObservation } from './metadata-proposals';

const sourceDate: MetadataObservation = {
  id: 'source-date',
  text: 'Date Collected: 2025-04-01',
  pageIndex: 0,
  boundingBox: { x: 0.1, y: 0.05, width: 0.3, height: 0.02 },
  locale: null,
};

function measurement(overrides: Partial<EvaluationMeasurement> = {}): EvaluationMeasurement {
  return {
    id: 'measurement-1',
    sourceLabel: 'Analyte',
    valueString: '42',
    valueType: 'numeric',
    parsedValue: 42,
    comparator: null,
    unit: null,
    referenceInterval: null,
    flag: null,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: 1,
    location: null,
    ambiguousFields: ['collectionDate', 'specimen'],
    unresolvedFields: ['collectionDate', 'specimen'],
    ...overrides,
  };
}

test('attaches a known same-page date and source IDs while preserving collection group', () => {
  const result = attachCollectionDateMetadata([measurement()], [sourceDate]);
  const attached = result.measurements[0]!;
  assert.equal(attached.collectionDate, '2025-04-01');
  assert.equal(attached.collectionGroup, null);
  assert.deepEqual(attached.sourceIds, ['source-date']);
  assert.deepEqual(attached.ambiguousFields, ['specimen']);
  assert.deepEqual(attached.unresolvedFields, ['specimen']);
  assert.equal(result.diagnostics.attachedMeasurementCount, 1);
});

test('does not broadcast a page date to another page or non-page scope', () => {
  const differentPage = attachCollectionDateMetadata([measurement({ page: 2 })], [sourceDate]);
  assert.equal(differentPage.measurements[0]?.collectionDate, null);
  assert.equal(differentPage.diagnostics.skippedMeasurementCount, 1);

  const bodyDate: MetadataObservation = {
    ...sourceDate,
    id: 'body-date',
    boundingBox: { ...sourceDate.boundingBox, y: 0.4 },
  };
  const body = attachCollectionDateMetadata([measurement()], [bodyDate]);
  assert.equal(body.measurements[0]?.collectionDate, null);
});

test('does not overwrite a conflicting existing date and marks the conflict unresolved', () => {
  const result = attachCollectionDateMetadata(
    [measurement({ collectionDate: '2025-05-01', sourceIds: ['existing-source'] })],
    [sourceDate],
  );
  const conflicted = result.measurements[0]!;
  assert.equal(conflicted.collectionDate, '2025-05-01');
  assert.deepEqual(conflicted.sourceIds, ['existing-source']);
  assert.deepEqual(conflicted.ambiguousFields, ['collectionDate', 'specimen']);
  assert.deepEqual(conflicted.unresolvedFields, ['collectionDate', 'specimen']);
  assert.equal(result.diagnostics.conflictCount, 1);
});

test('validates an existing matching date and removes stale unresolved markers', () => {
  const result = attachCollectionDateMetadata(
    [measurement({ collectionDate: '2025-04-01', sourceIds: ['existing-source'] })],
    [sourceDate],
  );
  assert.deepEqual(result.measurements[0]?.sourceIds, ['existing-source', 'source-date']);
  assert.deepEqual(result.measurements[0]?.ambiguousFields, ['specimen']);
  assert.deepEqual(result.measurements[0]?.unresolvedFields, ['specimen']);
  assert.equal(result.diagnostics.matchingMeasurementCount, 1);
});
