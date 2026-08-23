import type { ExtractionDraftRow, ExtractionRowDecision } from '@alyte/domain';

export type ExtractionDecisionPresentation = {
  readonly label: 'kept' | 'skipped' | 'resolved' | 'needs-decision';
  /** Review decisions stay visually neutral; they are not provenance or inclusion states. */
  readonly tone: 'neutral';
};

export function extractionDecisionPresentation(
  decision: ExtractionRowDecision,
): ExtractionDecisionPresentation {
  switch (decision) {
    case 'preserve':
      return { label: 'kept', tone: 'neutral' };
    case 'skip':
      return { label: 'skipped', tone: 'neutral' };
    case 'resolve':
      return { label: 'resolved', tone: 'neutral' };
    case 'unresolved':
      return { label: 'needs-decision', tone: 'neutral' };
  }
}

export function canConfirmExtraction(
  rows: readonly Pick<ExtractionDraftRow, 'decision'>[],
): boolean {
  return rows.length > 0 && rows.every((row) => row.decision !== 'unresolved');
}
