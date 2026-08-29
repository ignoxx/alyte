import assert from 'node:assert/strict';
import test from 'node:test';
import { findForbiddenWording } from '@alyte/catalogue';
import type { Measurement } from '@alyte/domain';
import { t } from '../../localization';
import {
  correctionDraftIsDirty,
  correctionInput,
  deletionFacts,
  formatLabRecordMeasurementAccessibilityLabel,
  getLabRecordDetailRowLayout,
  labRecordSupportReasonLocalizationKeys,
  measurementDraft,
} from './record-detail-model';

const measurement = {
  id: 'm1',
  labRecordId: 'r1',
  biomarkerId: null,
  specimenType: 'blood',
  panelLabel: null,
  original: {
    label: 'Synthetic',
    value: { kind: 'numeric', value: 1 },
    valueString: '1',
    unit: 'u',
    referenceInterval: null,
    flag: null,
  },
  originalState: {} as Measurement['originalState'],
  current: {
    label: 'Synthetic',
    value: { kind: 'numeric', value: 1 },
    valueString: '1',
    unit: 'u',
    referenceInterval: null,
    flag: null,
  },
  provenance: 'extracted',
  reviewState: 'confirmed',
  source: null,
  corrections: [],
} satisfies Measurement;

test('correction validation preserves a draft until it can produce a service input', () => {
  const draft = measurementDraft(measurement);
  assert.equal(correctionDraftIsDirty(draft, draft), false);
  assert.equal(correctionDraftIsDirty(draft, { ...draft, flag: 'synthetic flag' }), true);
  assert.equal(correctionInput({ ...draft, value: 'not numeric' }, measurement, 'reason'), null);
  assert.deepEqual(correctionInput({ ...draft, value: '2,5' }, measurement, 'reason')?.value, {
    kind: 'numeric',
    value: 2.5,
  });
});

test('record measurement rows stack at accessibility Dynamic Type sizes', () => {
  assert.equal(getLabRecordDetailRowLayout(1), 'inline');
  assert.equal(getLabRecordDetailRowLayout(1.29), 'inline');
  assert.equal(getLabRecordDetailRowLayout(1.3), 'stacked');
  assert.equal(getLabRecordDetailRowLayout(Number.NaN), 'inline');
});

test('record measurement accessibility labels keep the value and unit together', () => {
  assert.equal(formatLabRecordMeasurementAccessibilityLabel('HbA1c', '5.6', '%'), 'HbA1c, 5.6 %');
  assert.equal(
    formatLabRecordMeasurementAccessibilityLabel('Ferritin', '18', null),
    'Ferritin, 18',
  );
  assert.equal(
    formatLabRecordMeasurementAccessibilityLabel('Unknown biomarker', '', ''),
    'Unknown biomarker',
  );
});

test('deletion facts are derived only from the service plan', () => {
  assert.deepEqual(
    deletionFacts({
      scope: 'source-only',
      recordId: 'r1',
      reportId: 'p1',
      measurementIdsDeleted: [],
      linkedRecordIdsAffectedBySourceDeletion: ['r2'],
      recordRemains: true,
      sourceRemains: false,
    }),
    [
      { kind: 'measurements-remain' },
      { kind: 'record-remains' },
      { kind: 'source-deleted' },
      { kind: 'linked-records-source-deleted', count: 1 },
    ],
  );
});

test('every Lab Record preserved-only support reason has localized detail copy', () => {
  for (const [reason, localizationKey] of Object.entries(labRecordSupportReasonLocalizationKeys)) {
    const copy = t(localizationKey);
    assert.notEqual(copy, localizationKey, `${reason} must resolve to user-facing copy`);
    assert.notEqual(copy.trim(), '', `${reason} must not resolve to blank copy`);
    assert.equal(findForbiddenWording(copy), null, `${reason} must pass the wording guard`);
  }

  const methodCopy = t(labRecordSupportReasonLocalizationKeys['incompatible-method']);
  assert.match(methodCopy, /Preserved only/);
  assert.match(methodCopy, /not compared/);
});
