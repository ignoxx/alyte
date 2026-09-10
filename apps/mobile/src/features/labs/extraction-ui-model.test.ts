import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractionDraftRow } from '@alyte/domain';
import { t } from '../../localization';
import {
  buildExtractionReviewSections,
  canConfirmExtraction,
  canConfirmCurrentExtraction,
  extractionConfirmationDestination,
  extractionConfirmationPresentation,
  extractionConfirmationSummary,
  extractionBlockingRowIds,
  extractionDraftActionError,
  extractionDecisionPresentation,
  extractionDecisionRequiresSubmission,
  extractionNeedsResolution,
  extractionReviewQueueIncludes,
  extractionReviewCounts,
  extractionSourcePresentation,
  extractionSourcePreviewRequestAllowed,
  extractionUnitOptions,
  filterExtractionRows,
  labDateFromPickerValue,
  nextExtractionBlockingRowId,
  pickerValueFromLabDate,
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

test('confirmation opens one created Lab Record and returns to Labs for multiple records', () => {
  assert.deepEqual(extractionConfirmationDestination([{ id: 'record-1' }]), {
    kind: 'record',
    route: 'LabRecordDetail',
    recordId: 'record-1',
  });
  assert.deepEqual(extractionConfirmationDestination([{ id: 'record-1' }, { id: 'record-2' }]), {
    kind: 'labs',
  });
  assert.throws(() => extractionConfirmationDestination([]), /No Lab Records were created/);
});

test('source preview activation rejects a rapid double activation', () => {
  assert.equal(
    extractionSourcePreviewRequestAllowed({
      pending: false,
      busy: false,
      artifactKind: 'original',
    }),
    true,
  );
  assert.equal(
    extractionSourcePreviewRequestAllowed({
      pending: true,
      busy: false,
      artifactKind: 'original',
    }),
    false,
  );
  assert.equal(
    extractionSourcePreviewRequestAllowed({
      pending: false,
      busy: false,
      artifactKind: 'sanitized',
    }),
    true,
  );
});

test('source copy follows persisted Original or redacted-copy provenance', () => {
  const original = extractionSourcePresentation(
    row({
      source: {
        ...row().source,
        artifact: { kind: 'original', id: null, hash: 'original-hash' },
      },
    }),
  );
  const sanitized = extractionSourcePresentation(
    row({
      source: {
        ...row().source,
        artifact: { kind: 'sanitized', id: 'sanitized-1', hash: 'sanitized-hash' },
      },
    }),
  );

  assert.deepEqual(original, {
    artifactKind: 'original',
    labelKey: 'labs.extractionOriginalReport',
    regionKey: 'labs.extractionOriginalRegion',
  });
  assert.deepEqual(sanitized, {
    artifactKind: 'sanitized',
    labelKey: 'labs.extractionSanitizedReport',
    regionKey: 'labs.extractionSanitizedPageRegion',
  });
  assert.equal(t(original.labelKey), 'Original Report');
  assert.equal(t(sanitized.labelKey), 'Redacted copy');
  assert.match(t(original.regionKey), /^Original Report/);
  assert.match(t(sanitized.regionKey), /^Redacted copy/);
});

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

test('including a clean uncertain row still crosses the explicit correction boundary', () => {
  const ready = row();
  const uncertain = row({ reviewReasons: ['unsupported-layout'], reviewState: 'needs-review' });

  assert.equal(extractionDecisionRequiresSubmission(ready, 'resolve', false), false);
  assert.equal(extractionDecisionRequiresSubmission(ready, 'resolve', true), true);
  assert.equal(extractionDecisionRequiresSubmission(uncertain, 'resolve', false), true);
  assert.equal(extractionDecisionRequiresSubmission(uncertain, 'preserve', false), true);
  assert.equal(extractionDecisionRequiresSubmission(uncertain, 'skip', true), false);
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
  assert.equal(extractionReviewQueueIncludes(skippedUnsafe), false);
  assert.deepEqual(extractionReviewCounts([skippedUnsafe]), { included: 0, needsReview: 0 });
  assert.deepEqual(filterExtractionRows([skippedUnsafe], '', 'all'), [skippedUnsafe]);
  assert.deepEqual(filterExtractionRows([skippedUnsafe], '', 'needs-review'), []);
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

test('requires reprocessing before an older extraction pipeline can be confirmed', () => {
  assert.equal(canConfirmCurrentExtraction([row()], 'current'), true);
  assert.equal(canConfirmCurrentExtraction([row()], 'older'), false);
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
    needsReview: 0,
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

test('all-skipped drafts expose a safe finish action without creating a record', () => {
  const skipped = row({
    decision: 'skip',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
  });
  const summary = extractionConfirmationSummary([skipped]);
  assert.deepEqual(summary, {
    included: 0,
    needsReview: 0,
    remainingBlockers: 0,
    canConfirm: false,
    blockedReason: 'no-included-rows',
  });
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: false }).action, {
    kind: 'leave',
    label: 'Finish without saving',
    accessibilityLabel:
      'Finish without saving. No results will be added. The Original Report stays available.',
    disabled: false,
  });
  assert.equal(extractionConfirmationPresentation(summary, { busy: true }).action?.disabled, true);
  assert.equal(
    extractionConfirmationPresentation(summary, { busy: false, failure: true }).state,
    'failure',
  );
  assert.equal(
    extractionConfirmationPresentation(summary, { busy: false, failure: true }).action?.label,
    'Finish without saving',
  );
});

test('continuous review keeps source order and advances only through unresolved included rows', () => {
  const first = row({
    id: 'first',
    reviewReasons: ['unsupported-layout'],
    reviewState: 'needs-review',
    decision: 'preserve',
  });
  const ready = row({ id: 'ready' });
  const skipped = row({
    id: 'skipped',
    reviewReasons: ['missing-unit'],
    reviewState: 'needs-review',
    decision: 'skip',
  });
  const last = row({
    id: 'last',
    reviewReasons: ['missing-unit'],
    reviewState: 'needs-review',
    decision: 'preserve',
  });
  const rows = [first, ready, skipped, last];
  const queue = extractionBlockingRowIds(rows);

  assert.deepEqual(queue, ['first', 'last']);
  assert.equal(nextExtractionBlockingRowId(rows, queue, 'first'), 'last');
  assert.equal(nextExtractionBlockingRowId([{ ...last, decision: 'skip' }], queue, 'first'), null);
  assert.equal(
    nextExtractionBlockingRowId([{ ...first, decision: 'unresolved' }, last], queue, 'last'),
    'first',
  );
});

test('unit options lead with current, source, and resolved catalogue units without converting', () => {
  assert.deepEqual(
    extractionUnitOptions(
      row({
        proposedUnit: 'mmol/L',
        sourceUnit: 'mmol/L',
        proposedBiomarkerId: 'biomarker.ldl_c' as never,
      }),
    ).suggested,
    ['mmol/L', 'mg/dL'],
  );
  const unmapped = extractionUnitOptions(
    row({ proposedUnit: 'custom/L', sourceUnit: 'custom/L', proposedBiomarkerId: null }),
  );
  assert.deepEqual(unmapped.suggested, ['custom/L']);
  assert.ok(unmapped.common.includes('mg/dL'));
  assert.ok(unmapped.common.includes('U/L'));
});

test('native date-picker values preserve the device-local calendar day', () => {
  const value = pickerValueFromLabDate({ kind: 'known', value: '2025-04-01' });
  assert.equal(value.getFullYear(), 2025);
  assert.equal(value.getMonth(), 3);
  assert.equal(value.getDate(), 1);
  assert.deepEqual(labDateFromPickerValue(value), { kind: 'known', value: '2025-04-01' });

  const today = new Date(2026, 8, 2, 12);
  assert.equal(pickerValueFromLabDate({ kind: 'missing' }, today), today);
});

test('Extraction confirmation presentation maps each state to one concise action', () => {
  const summary = extractionConfirmationSummary([row()]);
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: false }), {
    ...summary,
    state: 'ready',
    action: {
      kind: 'save',
      label: 'Save 1 result',
      accessibilityLabel: 'Save 1 result. 1 included · 0 to check',
      disabled: false,
    },
  });
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: true }), {
    ...summary,
    state: 'busy',
    action: {
      kind: 'save',
      label: 'Saving…',
      accessibilityLabel: 'Saving…. 1 included · 0 to check',
      disabled: true,
    },
  });
  assert.deepEqual(extractionConfirmationPresentation(summary, { busy: false, failure: true }), {
    ...summary,
    state: 'failure',
    action: {
      kind: 'retry',
      label: 'Try again',
      accessibilityLabel: "Try again. Alyte couldn't save these results. 1 included · 0 to check",
      disabled: false,
    },
  });
  assert.equal(extractionConfirmationPresentation(summary, { busy: true }).action?.disabled, true);
  const blocked = extractionConfirmationSummary([
    row({ reviewReasons: ['unsupported-layout'], reviewState: 'needs-review' }),
  ]);
  assert.deepEqual(extractionConfirmationPresentation(blocked, { busy: false }).action, {
    kind: 'review',
    label: 'Check 1 remaining',
    accessibilityLabel: 'Check 1 remaining. 1 included · 1 to check',
    disabled: false,
  });
  assert.deepEqual(extractionConfirmationPresentation(blocked, { busy: false }), {
    ...blocked,
    state: 'blocked',
    action: {
      kind: 'review',
      label: 'Check 1 remaining',
      accessibilityLabel: 'Check 1 remaining. 1 included · 1 to check',
      disabled: false,
    },
  });
  assert.deepEqual(
    extractionConfirmationPresentation(extractionConfirmationSummary([]), { busy: false }).action,
    {
      kind: 'leave',
      label: 'Finish without saving',
      accessibilityLabel:
        'Finish without saving. No results will be added. The Original Report stays available.',
      disabled: false,
    },
  );
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

test('draft action errors keep retry guidance specific to the real failure', () => {
  assert.equal(
    extractionDraftActionError({ reason: 'original-source' }),
    t('labs.extractionProgressSourceError'),
  );
  assert.equal(
    extractionDraftActionError({ reason: 'persistence' }),
    t('labs.extractionPersistenceError'),
  );
  assert.equal(
    extractionDraftActionError(new Error('provider internals')),
    t('labs.extractionRefreshError'),
  );
});
