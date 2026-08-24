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
import { buildHomeLabViewModel, homeHasLocalHistory, sortHomeTimeline } from './home-model';

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
  biomarkerId: string,
  value: number,
  reviewState: Measurement['reviewState'] = 'confirmed',
): Measurement {
  const snapshot = {
    label: biomarkerId.replace('biomarker.', '').toUpperCase(),
    value: { kind: 'numeric' as const, value },
    valueString: String(value),
    unit: 'mg/dL',
    referenceInterval: null,
    flag: null,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId: canonicalId(biomarkerId),
    specimenType: 'serum',
    panelLabel: null,
    original: snapshot,
    originalState: {
      biomarkerId: canonicalId(biomarkerId),
      specimenType: 'serum',
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

test('Quiet Home prioritizes the latest local report and caps measured changes at three', () => {
  const first = labRecord('first', '2026-01-01', [
    measurement('first-ldl', 'first', 'biomarker.ldl_c', 100),
    measurement('first-hdl', 'first', 'biomarker.hdl_c', 50),
    measurement('first-triglycerides', 'first', 'biomarker.triglycerides', 120),
    measurement('first-total', 'first', 'biomarker.total_cholesterol', 180),
  ]);
  const latest = labRecord('latest', '2026-08-18', [
    measurement('latest-ldl', 'latest', 'biomarker.ldl_c', 110),
    measurement('latest-hdl', 'latest', 'biomarker.hdl_c', 55),
    measurement('latest-triglycerides', 'latest', 'biomarker.triglycerides', 100),
    measurement('latest-total', 'latest', 'biomarker.total_cholesterol', 170),
  ]);
  const model = buildHomeLabViewModel(
    [
      report('latest-report', 'latest', '2026-08-18'),
      report('first-report', 'first', '2026-01-01'),
    ],
    [first, latest],
  );

  assert.equal(model.latestReport?.id, 'latest-report');
  assert.deepEqual(
    model.recentReports.map((row) => row.id),
    ['latest-report', 'first-report'],
  );
  assert.equal(model.measuredChanges.length, 3);
  assert.deepEqual(model.measuredChanges.map((change) => change.direction).sort(), [
    'decreased',
    'increased',
    'increased',
  ]);
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
