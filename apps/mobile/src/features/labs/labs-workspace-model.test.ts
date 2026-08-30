import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabRecord, LabReport } from '@alyte/domain';
import { buildLabsWorkspaceModel } from './labs-workspace-model';

function report(overrides: Partial<LabReport> & Pick<LabReport, 'id'>): LabReport {
  const { id, ...rest } = overrides;
  return {
    id,
    sourceType: 'pdf',
    originalFilename: `${overrides.id}.pdf`,
    originalFilePath: `/protected/${overrides.id}.pdf`,
    originalSha256: overrides.id.padEnd(64, '0'),
    originalByteCount: 100,
    pageCount: 1,
    importState: 'imported',
    labRecordIds: ['record'],
    sanitizedReportIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failure: null,
    ...rest,
  } as LabReport;
}

function record(id: string, date: string | null): LabRecord {
  return {
    id,
    collectionDate: date === null ? { kind: 'missing' } : { kind: 'known', value: date },
    specimenType: 'blood',
    laboratoryName: null,
    notes: null,
    labReportId: null,
    sourceState: 'manual',
    measurements: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as LabRecord;
}

test('open drafts lead the attention queue and do not duplicate their source report', () => {
  const draftReport = report({ id: 'draft', labRecordIds: [] });
  const interrupted = report({ id: 'interrupted', importState: 'interrupted', labRecordIds: [] });
  const model = buildLabsWorkspaceModel(
    [interrupted, draftReport],
    [],
    [{ reportId: draftReport.id, draftId: 'draft-id' }],
  );

  assert.deepEqual(
    model.attention.map((item) => [item.kind, item.report.id]),
    [
      ['review-draft', 'draft'],
      ['continue-report', 'interrupted'],
    ],
  );
});

test('completed reports stay out of attention and records use newest known date first', () => {
  const complete = report({ id: 'complete' });
  const model = buildLabsWorkspaceModel(
    [complete],
    [record('missing', null), record('new', '2026-06-15'), record('old', '2026-01-15')],
    [],
  );

  assert.equal(model.attention.length, 0);
  assert.deepEqual(
    model.records.map((item) => item.id),
    ['new', 'old', 'missing'],
  );
});
