import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePhysicalRows, type PhysicalRowEvaluationCounts } from './physical-row-evaluation';

describe('physical-row evaluation', () => {
  it('reports aggregate admission and review metrics without source payloads', () => {
    const result = evaluatePhysicalRows({
      physicalRowCount: 4,
      anchorVariantCount: 7,
      rawReferencedPhysicalRows: 3,
      admittedPhysicalRowCount: 2,
      correctAdmittedPhysicalRowCount: 1,
      reviewGroupCount: 2,
      rejectedDuplicateConsumptionCount: 3,
      wrongValueOrSourceViolationCount: 1,
    });

    assert.deepEqual(result, {
      physicalRowCount: 4,
      anchorVariantCount: 7,
      rawReferencedPhysicalRows: 3,
      admittedPhysicalRowCount: 2,
      correctAdmittedPhysicalRowCount: 1,
      reviewGroupCount: 2,
      rejectedDuplicateConsumptionCount: 3,
      wrongValueOrSourceViolationCount: 1,
      rawPhysicalRowRecall: 0.75,
      physicalRowRecall: 0.25,
      reviewablePrecision: 0.2,
      reviewBurdenRate: 0.5,
    });
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        'admittedPhysicalRowCount',
        'anchorVariantCount',
        'correctAdmittedPhysicalRowCount',
        'physicalRowCount',
        'rawPhysicalRowRecall',
        'rawReferencedPhysicalRows',
        'rejectedDuplicateConsumptionCount',
        'reviewBurdenRate',
        'reviewGroupCount',
        'reviewablePrecision',
        'physicalRowRecall',
        'wrongValueOrSourceViolationCount',
      ].sort(),
    );
    assert.equal('sourceObservationIds' in result, false);
    assert.equal('rawModelOutput' in result, false);
  });

  it('keeps every duplicate-consumption rejection in the aggregate', () => {
    const counts: PhysicalRowEvaluationCounts = {
      physicalRowCount: 2,
      anchorVariantCount: 5,
      rawReferencedPhysicalRows: 2,
      admittedPhysicalRowCount: 1,
      correctAdmittedPhysicalRowCount: 1,
      reviewGroupCount: 1,
      rejectedDuplicateConsumptionCount: 4,
      wrongValueOrSourceViolationCount: 0,
    };
    const result = evaluatePhysicalRows(counts);
    assert.equal(result.rejectedDuplicateConsumptionCount, 4);
    assert.equal(result.reviewablePrecision, 0.2);
  });

  it('fails closed for invalid counts and uses zero ratios for empty corpora', () => {
    const empty = evaluatePhysicalRows({
      physicalRowCount: 0,
      anchorVariantCount: 0,
      rawReferencedPhysicalRows: 0,
      admittedPhysicalRowCount: 0,
      correctAdmittedPhysicalRowCount: 0,
      reviewGroupCount: 0,
      rejectedDuplicateConsumptionCount: 0,
      wrongValueOrSourceViolationCount: 0,
    });
    assert.equal(empty.rawPhysicalRowRecall, 0);
    assert.equal(empty.physicalRowRecall, 0);
    assert.equal(empty.reviewablePrecision, 0);
    assert.equal(empty.reviewBurdenRate, 0);
    assert.throws(
      () => evaluatePhysicalRows({ ...empty, physicalRowCount: -1 }),
      /invalid_physical_row_evaluation_count:physicalRowCount/,
    );
    assert.throws(
      () => evaluatePhysicalRows({ ...empty, anchorVariantCount: 1.5 }),
      /invalid_physical_row_evaluation_count:anchorVariantCount/,
    );
    assert.throws(
      () =>
        evaluatePhysicalRows({
          ...empty,
          physicalRowCount: 1,
          admittedPhysicalRowCount: 1,
          correctAdmittedPhysicalRowCount: 2,
        }),
      /invalid_physical_row_evaluation_relationship/,
    );
    assert.throws(
      () =>
        evaluatePhysicalRows({
          ...empty,
          physicalRowCount: 1,
          admittedPhysicalRowCount: 1,
          reviewGroupCount: 1,
        }),
      /invalid_physical_row_evaluation_relationship/,
    );
  });
});
