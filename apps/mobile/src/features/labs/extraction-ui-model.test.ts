import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractionDraftRow } from '@alyte/domain';
import {
  buildExtractionReviewSections,
  canConfirmExtraction,
  extractionConfirmationLayout,
  extractionConfirmationPresentation,
  extractionConfirmationSummary,
  extractionDecisionPresentation,
  extractionNeedsResolution,
  extractionReviewCounts,
  filterExtractionRows,
  sourceRegionPresentation,
} from './extraction-ui-model';

function row(overrides: Partial<ExtractionDraftRow> = {}): ExtractionDraftRow {
  return {
    id: 'row-1',
    order: 0,
    panelLabel: 'Lipids',
    sourceText: 'LDL Cholesterin 118 mg/dL <115 H',
    sourceLabel: 'LDL Cholesterin',
    sourceValue: { kind: 'numeric', value: 118 },
    sourceValueString: '118',
    sourceUnit: 'mg/dL',
    sourceReferenceInterval: '<115',
    sourceFlag: 'H',
    source: {
      pageIndex: 1,
      orientation: 0,
      observationIds: ['observation-1'],
      boundingBox: { x: 0.12, y: 0.34, width: 0.62, height: 0.05 },
    },
    collectionDateContext: null,
    proposedLabel: 'LDL cholesterol',
    proposedValue: { kind: 'numeric', value: 118 },
    proposedUnit: 'mg/dL',
    proposedReferenceInterval: '<115',
    proposedFlag: 'H',
    proposedBiomarkerId: 'biomarker.ldl_c' as never,
    proposedSpecimenType: 'serum',
    collectionDate: { kind: 'known', value: '2026-08-20' },
    reviewReasons: [],
    reviewState: 'ready',
    decision: 'resolve',
    ...overrides,
  };
}

test('Extraction decisions use neutral review presentation instead of provenance tones', () => {
  assert.deepEqual(extractionDecisionPresentation('preserve'), {
    label: 'kept',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('skip'), {
    label: 'skipped',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('resolve'), {
    label: 'resolved',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('unresolved'), {
    label: 'needs-decision',
    tone: 'neutral',
  });
});

test('Extraction confirmation includes valid rows by default and gates only true required ambiguity', () => {
  assert.equal(canConfirmExtraction([]), false);
  assert.equal(canConfirmExtraction([row({ decision: 'unresolved' })]), true);
  const ambiguous = row({
    decision: 'unresolved',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
  });
  assert.equal(extractionNeedsResolution(ambiguous), true);
  assert.equal(canConfirmExtraction([ambiguous]), false);
  const skippedUnsafe = row({
    id: 'skipped-unsafe',
    decision: 'skip',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
  });
  assert.equal(extractionNeedsResolution(skippedUnsafe), true);
  assert.deepEqual(extractionReviewCounts([skippedUnsafe]), { included: 0, needsReview: 1 });
  assert.deepEqual(filterExtractionRows([skippedUnsafe], '', 'all'), [skippedUnsafe]);
  assert.deepEqual(filterExtractionRows([skippedUnsafe], '', 'needs-review'), [skippedUnsafe]);
  assert.equal(canConfirmExtraction([row(), skippedUnsafe]), true);
  assert.equal(
    canConfirmExtraction([
      row({ id: 'kept', decision: 'preserve', reviewReasons: ['unsupported-alias'] }),
      row({ id: 'skipped', decision: 'skip' }),
      row({ id: 'resolved', decision: 'resolve' }),
    ]),
    true,
  );
  for (const reason of [
    'missing-label',
    'missing-value',
    'unparseable-value',
    'missing-unit',
    'incompatible-unit',
    'unsupported-layout',
  ] as const) {
    assert.equal(
      extractionNeedsResolution(
        row({ decision: 'unresolved', reviewReasons: [reason], reviewState: 'needs-review' }),
      ),
      true,
    );
  }
  assert.equal(
    extractionNeedsResolution(
      row({
        decision: 'unresolved',
        reviewReasons: ['unsupported-alias'],
        reviewState: 'needs-review',
      }),
    ),
    false,
  );
  assert.equal(
    extractionNeedsResolution(
      row({
        decision: 'preserve',
        reviewReasons: ['ambiguous-assay', 'unsupported-layout'],
        reviewState: 'needs-review',
      }),
    ),
    true,
  );
});

test('Extraction confirmation separates review attention from exact included-row blockers', () => {
  const ready = row({ id: 'ready', decision: 'resolve' });
  const skippedNeedsReview = row({
    id: 'skipped',
    decision: 'skip',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
  });
  const includedNeedsReview = row({
    id: 'blocking',
    decision: 'unresolved',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
  });

  assert.deepEqual(extractionConfirmationSummary([]), {
    included: 0,
    needsReview: 0,
    remainingBlockers: 0,
    canConfirm: false,
    blockedReason: 'no-included-rows',
  });
  assert.deepEqual(extractionConfirmationSummary([ready]), {
    included: 1,
    needsReview: 0,
    remainingBlockers: 0,
    canConfirm: true,
    blockedReason: null,
  });
  assert.deepEqual(extractionConfirmationSummary([ready, row({ id: 'ready-2' })]), {
    included: 2,
    needsReview: 0,
    remainingBlockers: 0,
    canConfirm: true,
    blockedReason: null,
  });
  assert.deepEqual(extractionConfirmationSummary([ready, skippedNeedsReview]), {
    included: 1,
    needsReview: 1,
    remainingBlockers: 0,
    canConfirm: true,
    blockedReason: null,
  });
  assert.deepEqual(extractionConfirmationSummary([ready, includedNeedsReview]), {
    included: 2,
    needsReview: 1,
    remainingBlockers: 1,
    canConfirm: false,
    blockedReason: 'rows-need-resolution',
  });
});

test('Extraction confirmation presentation keeps ready, busy, failure, and blocked states stable', () => {
  const summary = extractionConfirmationSummary([row()]);
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: false }), {
    ...summary,
    state: 'ready',
    statusLabel: 'Ready to confirm.',
    disabled: false,
  });
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: true }), {
    ...summary,
    state: 'busy',
    statusLabel: 'Confirming Lab Records…',
    disabled: true,
  });
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: false, failure: true }), {
    ...summary,
    state: 'failure',
    statusLabel: 'Confirmation failed. Try again.',
    disabled: false,
  });
  assert.equal(extractionConfirmationPresentation(summary, { busy: true }).disabled, true);
  const blocked = extractionConfirmationSummary([
    row({ reviewReasons: ['unsupported-layout'], reviewState: 'needs-review' }),
  ]);
  assert.deepEqual(extractionConfirmationPresentation(blocked, { busy: false }), {
    ...blocked,
    state: 'blocked',
    statusLabel: '1 included row(s) still need resolution.',
    disabled: true,
  });
});

test('Extraction confirmation stacks before XL text can hide either visible count', () => {
  assert.equal(extractionConfirmationLayout(1, 390), 'inline');
  assert.equal(extractionConfirmationLayout(1.3, 390), 'stacked');
  assert.equal(extractionConfirmationLayout(1, 359), 'stacked');
});

test('groups compact rows by Lab Record and panel while keeping date and specimen in headers', () => {
  const rows = [
    row(),
    row({ id: 'row-2', order: 1, panelLabel: 'Lipids', proposedLabel: 'HDL cholesterol' }),
    row({
      id: 'row-3',
      order: 2,
      panelLabel: null,
      proposedLabel: 'Vitamin D',
      proposedSpecimenType: 'plasma',
    }),
  ];
  const sections = buildExtractionReviewSections(rows);
  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.collectionDateLabel, '2026-08-20');
  assert.equal(sections[0]?.specimenType, 'serum');
  assert.equal(sections[0]?.panels[0]?.label, 'Lipids');
  assert.equal(sections[0]?.panels[0]?.rows.length, 2);
  assert.equal(sections[1]?.panels[0]?.label, null);
});

test('search and Needs Review filter inspect canonical, original, value, flag, range, and panel', () => {
  const ready = row();
  const ambiguous = row({
    id: 'row-2',
    panelLabel: 'Metabolic',
    proposedLabel: 'Glucose',
    sourceLabel: 'Glukose',
    sourceValueString: '126',
    proposedValue: { kind: 'numeric', value: 126 },
    proposedFlag: null,
    proposedReferenceInterval: '70-99',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
    decision: 'unresolved',
  });
  assert.deepEqual(filterExtractionRows([ready, ambiguous], 'glukose', 'all'), [ambiguous]);
  assert.deepEqual(filterExtractionRows([ready, ambiguous], '70-99', 'needs-review'), [ambiguous]);
  assert.deepEqual(filterExtractionRows([ready, ambiguous], '', 'needs-review'), [ambiguous]);
});

test('View in Report preserves the stored sanitized page and exact normalized region', () => {
  assert.deepEqual(sourceRegionPresentation(row()), {
    pageIndex: 1,
    boundingBox: { x: 0.12, y: 0.34, width: 0.62, height: 0.05 },
  });
});
