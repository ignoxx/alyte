import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalId,
  type IntakeEvent,
  type LabRecord,
  type LabReport,
  type Measurement,
} from '@alyte/domain';
import type { IntakeCloudJob } from '../intake/outbox';
import { intakeEventMenuActions } from '../intake/ui';
import {
  buildHomeLabViewModel,
  getHomeMeasuredChangeColumnCount,
  homeHasLocalHistory,
  isUnfinishedLabReport,
  sortHomeTimeline,
} from './home-model';

test('Home biomarker cards use two columns only when width and Dynamic Type allow it', () => {
  assert.equal(getHomeMeasuredChangeColumnCount(393, 1), 2);
  assert.equal(getHomeMeasuredChangeColumnCount(440, 1.29), 2);
  assert.equal(getHomeMeasuredChangeColumnCount(375, 1), 1);
  assert.equal(getHomeMeasuredChangeColumnCount(440, 1.3), 1);
  assert.equal(getHomeMeasuredChangeColumnCount(Number.NaN, Number.NaN), 1);
});

function event(
  id: string,
  localDate: string,
  occurredAt: string,
  sourceMediaPath: string | null = null,
): IntakeEvent {
  return {
    id,
    eventType: 'food',
    occurredAt,
    localDate,
    origin: 'manual',
    provenance: 'user-entered',
    reviewState: 'confirmed',
    analysisInclusion: 'included',
    notes: null,
    sourceMediaPath,
    sourceMediaHash: null,
    sourceMediaSize: null,
    sourceMediaProtection: null,
    copiedFromEventId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    components: [],
  };
}

const queuedJob = {
  id: 'job-1',
  eventId: 'with-image',
  operation: 'intake-image',
  mediaPath: '/protected/image',
  state: 'queued',
  consentPolicyVersion: 'fixture',
  failureCategory: null,
  createdAt: '2026-08-22T09:00:00.000Z',
  updatedAt: '2026-08-22T09:00:00.000Z',
  submittedAt: null,
  cancelledAt: null,
} satisfies IntakeCloudJob;

function measurement(
  id: string,
  recordId: string,
  biomarkerId: string | null,
  value: number,
  reviewState: Measurement['reviewState'] = 'confirmed',
  unit = 'mg/dL',
  specimenType: Measurement['specimenType'] = 'serum',
): Measurement {
  const snapshot = {
    label:
      biomarkerId === null
        ? 'Source-only marker'
        : biomarkerId.replace('biomarker.', '').toUpperCase(),
    value: { kind: 'numeric' as const, value },
    valueString: String(value),
    unit,
    referenceInterval: null,
    flag: null,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId: biomarkerId === null ? null : canonicalId(biomarkerId),
    specimenType,
    panelLabel: null,
    original: snapshot,
    originalState: {
      biomarkerId: biomarkerId === null ? null : canonicalId(biomarkerId),
      specimenType,
      snapshot,
      reviewState,
      provenance: 'extracted',
      source: null,
    },
    current: snapshot,
    provenance: 'extracted',
    reviewState,
    source: null,
    corrections: [],
  };
}

function labRecord(id: string, date: string, measurements: readonly Measurement[]): LabRecord {
  return {
    id,
    labReportId: `report-${id}`,
    collectionDate: { kind: 'known', value: date },
    specimenType: 'serum',
    laboratoryName: 'Synthetic Laboratory',
    notes: null,
    createdAt: `${date}T12:00:00.000Z`,
    updatedAt: `${date}T12:00:00.000Z`,
    measurements,
  };
}

function report(id: string, recordId: string, date: string): LabReport {
  return {
    id,
    sourceType: 'pdf',
    originalFilename: `${id}.pdf`,
    mimeType: 'application/pdf',
    byteSize: null,
    sourceHash: null,
    originalPath: '/protected/report.pdf',
    importState: 'imported',
    deletionState: 'none',
    deletionRequestedAt: null,
    deletionError: null,
    failureReason: null,
    encrypted: true,
    pageCount: 1,
    createdAt: `${date}T12:00:00.000Z`,
    updatedAt: `${date}T12:00:00.000Z`,
    importedAt: `${date}T12:00:00.000Z`,
    pages: [],
    labRecordIds: [recordId],
  };
}

test('Home keeps the requested day timeline newest first', () => {
  const records = [
    event('older', '2026-08-22', '2026-08-22T08:00:00.000Z'),
    event('newer', '2026-08-22', '2026-08-22T09:00:00.000Z'),
    event('latest', '2026-08-22', '2026-08-22T11:00:00.000Z'),
  ];

  assert.deepEqual(
    sortHomeTimeline(records).map((record) => record.id),
    ['latest', 'newer', 'older'],
  );
});

test('Home only calls the first-use state empty when both local histories are empty', () => {
  assert.equal(homeHasLocalHistory([], 0), false);
  assert.equal(
    homeHasLocalHistory([event('prior', '2026-08-21', '2026-08-21T09:00:00.000Z')], 0),
    true,
  );
  assert.equal(homeHasLocalHistory([], 1), true);
});

test('Home menu keeps destructive and uncommon actions out of the row', () => {
  const record = event('with-image', '2026-08-22', '2026-08-22T09:00:00.000Z', '/protected/image');

  assert.deepEqual(intakeEventMenuActions(record, queuedJob), [
    'edit',
    'cancel-analysis',
    'toggle-inclusion',
    'remove-image',
    'delete',
  ]);
  assert.deepEqual(
    intakeEventMenuActions(event('plain', '2026-08-22', '2026-08-22T09:00:00.000Z'), null),
    ['edit', 'toggle-inclusion', 'delete'],
  );
});

test('Quiet Home prioritizes the latest local report and keeps the overview to four changes', () => {
  const first = labRecord('first', '2026-01-01', [
    measurement('first-ldl', 'first', 'biomarker.ldl_c', 100),
    measurement('first-hdl', 'first', 'biomarker.hdl_c', 50),
    measurement('first-triglycerides', 'first', 'biomarker.triglycerides', 120),
    measurement('first-total', 'first', 'biomarker.total_cholesterol', 180),
    measurement('first-glucose', 'first', 'biomarker.glucose', 90),
    measurement(
      'first-hemoglobin',
      'first',
      'biomarker.hemoglobin',
      140,
      'confirmed',
      'g/L',
      'blood',
    ),
    measurement('first-ferritin', 'first', 'biomarker.ferritin', 48, 'confirmed', 'ng/mL'),
    measurement('first-hba1c', 'first', 'biomarker.hba1c', 5.4, 'confirmed', '%', 'blood'),
  ]);
  const latest = labRecord('latest', '2026-08-18', [
    measurement('latest-ldl', 'latest', 'biomarker.ldl_c', 110),
    measurement('latest-hdl', 'latest', 'biomarker.hdl_c', 55),
    measurement('latest-triglycerides', 'latest', 'biomarker.triglycerides', 100),
    measurement('latest-total', 'latest', 'biomarker.total_cholesterol', 170),
    measurement('latest-glucose', 'latest', 'biomarker.glucose', 92),
    measurement(
      'latest-hemoglobin',
      'latest',
      'biomarker.hemoglobin',
      142,
      'confirmed',
      'g/L',
      'blood',
    ),
    measurement('latest-ferritin', 'latest', 'biomarker.ferritin', 52, 'confirmed', 'ng/mL'),
    measurement('latest-hba1c', 'latest', 'biomarker.hba1c', 5.5, 'confirmed', '%', 'blood'),
  ]);
  const model = buildHomeLabViewModel(
    [
      report('latest-report', 'latest', '2026-08-18'),
      report('first-report', 'first', '2026-01-01'),
    ],
    [first, latest],
  );

  assert.equal(model.latestReport?.id, 'latest-report');
  assert.equal(model.latestRecord?.id, 'latest');
  assert.deepEqual(
    model.recentReports.map((row) => row.id),
    ['latest-report', 'first-report'],
  );
  assert.equal(model.measuredChanges.length, 4);
});

test('Quiet Home keeps unfinished import and review work visible without creating a change', () => {
  const record = labRecord('review', '2026-08-18', [
    measurement('review-ldl', 'review', 'biomarker.ldl_c', 100, 'needs-review'),
  ]);
  const interrupted = {
    ...report('interrupted', 'review', '2026-08-18'),
    importState: 'interrupted' as const,
  };
  const model = buildHomeLabViewModel([interrupted], [record]);

  assert.equal(model.pendingImports.length, 1);
  assert.equal(model.reviewCount, 1);
  assert.equal(model.measuredChanges.length, 0);
});

test('Quiet Home includes an open persisted Extraction Draft before a Lab Record exists', () => {
  const model = buildHomeLabViewModel(
    [report('draft-report', 'missing-record', '2026-08-18')],
    [],
    1,
  );

  assert.equal(model.latestReport?.id, 'draft-report');
  assert.equal(model.latestReport?.measurementCount, 0);
  assert.equal(model.openDraftCount, 1);
  assert.equal(model.recentRecords.length, 0);
});

test('Home classifies an imported source without a confirmed Lab Record as unfinished', () => {
  const imported = {
    ...report('unfinished-report', 'missing-record', '2026-08-18'),
    labRecordIds: [],
  };
  const model = buildHomeLabViewModel([imported], []);

  assert.equal(isUnfinishedLabReport(imported), true);
  assert.deepEqual(
    model.unfinishedReports.map((item) => item.id),
    ['unfinished-report'],
  );
  assert.deepEqual(
    model.pendingImports.map((item) => item.id),
    ['unfinished-report'],
  );
  assert.equal(model.latestReport?.measurementCount, 0);
  assert.equal(model.measuredChanges.length, 0);
});

test('Home keeps confirmed measurements visible while a newer report awaits review', () => {
  const confirmedRecord = labRecord('confirmed', '2026-08-18', [
    measurement('confirmed-ldl', 'confirmed', 'biomarker.ldl_c', 110),
  ]);
  const confirmedReport = report('confirmed-report', confirmedRecord.id, '2026-08-18');
  const openReport = {
    ...report('new-open-report', 'missing-record', '2026-08-20'),
    labRecordIds: [],
  };
  const model = buildHomeLabViewModel([confirmedReport, openReport], [confirmedRecord], 1, [
    { reportId: openReport.id, draftId: 'open-draft' },
  ]);

  assert.deepEqual(
    model.latestMeasurements.map((item) => item.id),
    ['confirmed-ldl'],
  );
  assert.deepEqual(
    model.unfinishedReports.map((item) => item.id),
    [openReport.id],
  );
});

test('Home previews the newest saved results without repeating review badges on every value', () => {
  const reviewedRecord = labRecord('reviewed', '2026-08-18', [
    measurement('reviewed-ldl', 'reviewed', 'biomarker.ldl_c', 110),
  ]);
  const pendingRecord = labRecord('pending', '2026-08-20', [
    measurement('pending-marker', 'pending', null, 7.2, 'needs-review', 'custom/L'),
  ]);
  const model = buildHomeLabViewModel(
    [
      report('reviewed-report', reviewedRecord.id, '2026-08-18'),
      report('pending-report', pendingRecord.id, '2026-08-20'),
    ],
    [reviewedRecord, pendingRecord],
  );

  assert.deepEqual(
    model.latestMeasurements.map((item) => item.id),
    ['pending-marker'],
  );
  assert.equal(model.latestMeasurements[0]?.reviewState, 'needs-review');
  assert.equal(model.measurementCount, 1);
  assert.equal(model.totalMeasurementCount, 2);
  assert.equal(model.latestReviewRecordId, 'pending');
});

test('Home does not classify an imported source linked to a confirmed Lab Record as unfinished', () => {
  const confirmed = report('confirmed-report', 'confirmed-record', '2026-08-18');
  const record = labRecord('confirmed-record', '2026-08-18', [
    measurement('confirmed-ldl', 'confirmed-record', 'biomarker.ldl_c', 110),
  ]);
  const model = buildHomeLabViewModel([confirmed], [record]);

  assert.equal(isUnfinishedLabReport(confirmed), false);
  assert.deepEqual(model.unfinishedReports, []);
});

test('Home shows every saved result once and keeps review uncertainty at the group level', () => {
  const mapped = measurement('mapped', 'latest', 'biomarker.ldl_c', 110);
  const unmappedBase = measurement('unmapped', 'latest', null, 7.2, 'needs-review', 'custom/L');
  const unmapped: Measurement = {
    ...unmappedBase,
    source: {
      pageIndex: 12,
      orientation: 0,
      boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
    },
  };
  const record = labRecord('latest', '2026-08-18', [mapped, unmapped]);
  const model = buildHomeLabViewModel([report('latest-report', record.id, '2026-08-18')], [record]);

  assert.equal(model.measurementCount, 1);
  assert.equal(model.totalMeasurementCount, 2);
  assert.equal(model.biomarkerCount, 1);
  assert.deepEqual(
    model.latestMeasurements.map(({ label, biomarkerId, sourcePage, reviewState }) => ({
      label,
      biomarkerId,
      sourcePage,
      reviewState,
    })),
    [
      {
        label: 'LDL-C',
        biomarkerId: 'biomarker.ldl_c',
        sourcePage: null,
        reviewState: 'confirmed',
      },
      {
        label: 'Source-only marker',
        biomarkerId: null,
        sourcePage: 13,
        reviewState: 'needs-review',
      },
    ],
  );
  assert.equal(model.reviewCount, 1);
  assert.equal(model.latestReviewRecordId, 'latest');
  assert.equal(model.reportCount, 1);
  assert.equal(model.latestMeasurementReportId, 'latest-report');
});

test('Home uses the newest reviewed manual record instead of an older report', () => {
  const older = labRecord('older', '2026-08-18', [
    measurement('older-ldl', 'older', 'biomarker.ldl_c', 110),
  ]);
  const manual = {
    ...labRecord('manual', '2026-08-20', [
      measurement('manual-ldl', 'manual', 'biomarker.ldl_c', 105),
    ]),
    labReportId: null,
  };
  const model = buildHomeLabViewModel(
    [report('older-report', older.id, '2026-08-18')],
    [older, manual],
  );

  assert.deepEqual(
    model.latestMeasurements.map((item) => item.recordId),
    ['manual'],
  );
  assert.equal(model.latestMeasurementReportId, null);
});

test('Home keeps an open Extraction Draft actionable after its report gains a confirmed record', () => {
  const confirmed = report('confirmed-report', 'confirmed-record', '2026-08-18');
  const record = labRecord('confirmed-record', '2026-08-18', [
    measurement('confirmed-ldl', 'confirmed-record', 'biomarker.ldl_c', 110),
  ]);
  const model = buildHomeLabViewModel([confirmed], [record], 1, [
    { reportId: confirmed.id, draftId: 'open-draft' },
  ]);

  assert.deepEqual(
    model.unfinishedReports.map((item) => item.id),
    [confirmed.id],
  );
  assert.deepEqual(model.openDrafts, [{ reportId: confirmed.id, draftId: 'open-draft' }]);
  assert.deepEqual(model.pendingImports, []);
});

test('Home keeps a Lab Record discoverable after its Original Report is deleted', () => {
  const record = labRecord('surviving-record', '2026-08-18', []);
  const deletedReport = {
    ...report('deleted-report', record.id, '2026-08-18'),
    importState: 'deleted' as const,
  };
  const model = buildHomeLabViewModel([deletedReport], [record]);

  assert.equal(model.latestReport, null);
  assert.equal(model.latestRecord?.id, record.id);
  assert.deepEqual(
    model.recentRecords.map((item) => item.id),
    [record.id],
  );
});

test('Home keeps failed and interrupted sources actionable without treating them as measured', () => {
  const failed = {
    ...report('failed-report', 'missing-failed-record', '2026-08-18'),
    importState: 'failed' as const,
  };
  const interrupted = {
    ...report('interrupted-report', 'missing-interrupted-record', '2026-08-19'),
    importState: 'interrupted' as const,
  };
  const model = buildHomeLabViewModel([failed, interrupted], []);

  assert.deepEqual(
    model.unfinishedReports.map((item) => item.id),
    ['interrupted-report', 'failed-report'],
  );
  assert.deepEqual(
    model.pendingImports.map((item) => item.id),
    ['interrupted-report', 'failed-report'],
  );
  assert.equal(model.measuredChanges.length, 0);
});

test('Quiet Home keeps manual records in record history instead of report sections', () => {
  const manual = {
    ...labRecord('manual', '2026-08-19', []),
    labReportId: null,
    laboratoryName: null,
  };
  const sourceRecord = labRecord('source', '2026-08-20', []);
  const sourceReport = report('source-report', sourceRecord.id, '2026-08-20');

  const manualOnly = buildHomeLabViewModel([], [manual]);
  assert.equal(manualOnly.latestReport, null);
  assert.equal(manualOnly.recentReports.length, 0);
  assert.equal(manualOnly.recentRecords[0]?.id, 'manual');
  assert.equal(manualOnly.recentRecords[0]?.title, null);

  const mixed = buildHomeLabViewModel([sourceReport], [sourceRecord, manual]);
  assert.equal(mixed.latestReport?.id, 'source-report');
  assert.deepEqual(
    mixed.recentReports.map((row) => row.id),
    ['source-report'],
  );
  assert.deepEqual(
    mixed.recentRecords.map((row) => row.id),
    ['manual'],
  );
});

test('Home summary rows preserve the source identity needed by their detail destinations', () => {
  const sourceRecord = labRecord('source', '2026-08-20', []);
  const manualRecord = {
    ...labRecord('manual', '2026-08-19', []),
    labReportId: null,
    laboratoryName: null,
  };
  const sourceReport = report('source-report', sourceRecord.id, '2026-08-20');

  const model = buildHomeLabViewModel([sourceReport], [sourceRecord, manualRecord]);

  assert.deepEqual(
    model.recentReports.map(({ kind, id }) => ({ kind, id })),
    [{ kind: 'report', id: 'source-report' }],
  );
  assert.deepEqual(
    model.recentRecords.map(({ kind, id }) => ({ kind, id })),
    [{ kind: 'record', id: 'manual' }],
  );
});

test('Quiet Home compares the latest compatible point with its immediate predecessor', () => {
  const records = [
    labRecord('first', '2026-01-01', [measurement('first-ldl', 'first', 'biomarker.ldl_c', 100)]),
    labRecord('middle', '2026-04-01', [
      measurement('middle-ldl', 'middle', 'biomarker.ldl_c', 200),
    ]),
    labRecord('latest', '2026-08-18', [
      measurement('latest-ldl', 'latest', 'biomarker.ldl_c', 150),
    ]),
  ];

  const model = buildHomeLabViewModel([], records);
  assert.equal(
    model.measuredChanges.find((change) => change.biomarkerId === 'biomarker.ldl_c')?.direction,
    'decreased',
  );
});
