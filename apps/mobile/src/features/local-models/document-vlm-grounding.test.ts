import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
  reconstructGeometryLattice,
  type VisionTextObservation,
} from '@alyte/domain';
import { groundDocumentVLMRows } from './document-vlm-grounding';

function cell(id: string, text: string, x: number, columnIndex: number): VisionTextObservation {
  return {
    id,
    text,
    boundingBox: { x, y: 0.25, width: 0.16, height: 0.035 },
    pageIndex: 0,
    orientation: 0,
    alternatives: [],
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
    structure: {
      kind: 'table-cell',
      tableId: 'synthetic-results',
      rowIndex: 0,
      columnIndex,
    },
  };
}

test('VLM strings select one source variant but never become the returned source fields', () => {
  const source = [
    cell('label', 'Novel Marker', 0.05, 0),
    cell('value', '7.4', 0.35, 1),
    cell('unit', 'U/L', 0.55, 2),
    cell('reference', '4.0 - 8.0', 0.73, 3),
  ];
  const groups = groupGeometryCandidateWindows(
    buildGeometryCandidateWindows(reconstructGeometryLattice(source), source),
  );
  assert.equal(groups.length, 1);
  const result = groundDocumentVLMRows(
    new Map([
      [
        0,
        [
          {
            label: 'novel marker',
            value: '7.4',
            unit: 'U/L',
            referenceInterval: '4.0 - 8.0',
            flag: null,
          },
        ],
      ],
    ]),
    groups,
    {
      locale: 'en-US',
      collectionDate: { kind: 'known', value: '2026-08-31' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(result.matchedPhysicalRows, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.sourceLabel, 'Novel Marker');
  assert.equal(result.rows[0]!.sourceValueString, '7.4');
  assert.equal(result.rows[0]!.sourceUnit, 'U/L');
  assert.equal(result.rows[0]!.reviewState, 'needs-review');
  assert.equal(result.rows[0]!.proposedBiomarkerId, null);
});

test('cross-row or mismatched result proposals cannot select a source variant', () => {
  const source = [cell('label', 'Marker A', 0.05, 0), cell('value', '7.4', 0.35, 1)];
  const groups = groupGeometryCandidateWindows(
    buildGeometryCandidateWindows(reconstructGeometryLattice(source), source),
  );
  const result = groundDocumentVLMRows(
    new Map([
      [
        0,
        [
          {
            label: 'Marker A',
            value: '9.1',
            unit: null,
            referenceInterval: null,
            flag: null,
          },
        ],
      ],
    ]),
    groups,
    {
      locale: 'en-US',
      collectionDate: { kind: 'missing' },
      collectionDateDefaulted: true,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(result.rows.length, 0);
  assert.equal(result.unmatchedProposals, 1);
});
