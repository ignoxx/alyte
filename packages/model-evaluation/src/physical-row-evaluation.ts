/**
 * Aggregate counts for evaluating physical-row admission.
 *
 * The caller computes these counts at the acceptance boundary, where the source-row identity is
 * still available. This contract intentionally carries counts only: no OCR text, source IDs,
 * prompts, model output, or proposed values can cross the evaluation-report boundary.
 */
export type PhysicalRowEvaluationCounts = {
  readonly physicalRowCount: number;
  readonly anchorVariantCount: number;
  readonly rawReferencedPhysicalRows: number;
  readonly admittedPhysicalRowCount: number;
  readonly correctAdmittedPhysicalRowCount: number;
  readonly reviewGroupCount: number;
  /** Count every rejected duplicate consumption, including repeated attempts for one row. */
  readonly rejectedDuplicateConsumptionCount: number;
  readonly wrongValueOrSourceViolationCount: number;
};

export type PhysicalRowEvaluation = PhysicalRowEvaluationCounts & {
  readonly rawPhysicalRowRecall: number;
  readonly physicalRowRecall: number;
  readonly reviewablePrecision: number;
  readonly reviewBurdenRate: number;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function assertCount(name: keyof PhysicalRowEvaluationCounts, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid_physical_row_evaluation_count:${name}`);
}

/**
 * Build the aggregate-only physical-row evaluation result.
 *
 * `rawReferencedPhysicalRows` is supplied as a count of unique physical rows referenced by raw
 * output. Duplicate consumption is deliberately a separate count and is never folded into that
 * value or discarded while computing the result.
 */
export function evaluatePhysicalRows(counts: PhysicalRowEvaluationCounts): PhysicalRowEvaluation {
  const countNames: readonly (keyof PhysicalRowEvaluationCounts)[] = [
    'physicalRowCount',
    'anchorVariantCount',
    'rawReferencedPhysicalRows',
    'admittedPhysicalRowCount',
    'correctAdmittedPhysicalRowCount',
    'reviewGroupCount',
    'rejectedDuplicateConsumptionCount',
    'wrongValueOrSourceViolationCount',
  ];
  for (const name of countNames) assertCount(name, counts[name]);
  if (
    counts.rawReferencedPhysicalRows > counts.physicalRowCount ||
    counts.admittedPhysicalRowCount > counts.physicalRowCount ||
    counts.correctAdmittedPhysicalRowCount > counts.admittedPhysicalRowCount ||
    counts.reviewGroupCount > counts.physicalRowCount ||
    counts.admittedPhysicalRowCount + counts.reviewGroupCount > counts.physicalRowCount
  )
    throw new Error('invalid_physical_row_evaluation_relationship');

  return {
    physicalRowCount: counts.physicalRowCount,
    anchorVariantCount: counts.anchorVariantCount,
    rawReferencedPhysicalRows: counts.rawReferencedPhysicalRows,
    admittedPhysicalRowCount: counts.admittedPhysicalRowCount,
    correctAdmittedPhysicalRowCount: counts.correctAdmittedPhysicalRowCount,
    reviewGroupCount: counts.reviewGroupCount,
    rejectedDuplicateConsumptionCount: counts.rejectedDuplicateConsumptionCount,
    wrongValueOrSourceViolationCount: counts.wrongValueOrSourceViolationCount,
    rawPhysicalRowRecall: ratio(counts.rawReferencedPhysicalRows, counts.physicalRowCount),
    physicalRowRecall: ratio(counts.correctAdmittedPhysicalRowCount, counts.physicalRowCount),
    reviewablePrecision: ratio(
      counts.correctAdmittedPhysicalRowCount,
      counts.admittedPhysicalRowCount + counts.rejectedDuplicateConsumptionCount,
    ),
    reviewBurdenRate: ratio(counts.reviewGroupCount, counts.physicalRowCount),
  };
}
