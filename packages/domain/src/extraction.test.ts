import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExtractionConfirmationPlan,
  decodeVisionOCRResult,
  groupObservationsIntoRows,
  parseComparatorValue,
  parseLabDate,
  type ExtractionAliasEntry,
} from './extraction.js';

const aliases: readonly ExtractionAliasEntry[] = [
  {
    id: 'biomarker.ldl_c',
    aliases: ['LDL-C', 'LDL-Cholesterin'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mmol/L', 'mg/dL'],
  },
];

describe('local extraction domain', () => {
  it('rejects untrusted OCR contract data outside normalized bounds', () => {
    assert.throws(
      () =>
        decodeVisionOCRResult({
          contractVersion: 'alyte.vision.ocr.v1',
          pageIndex: 0,
          orientation: 0,
          observations: [{ text: 'LDL-C', boundingBox: { x: 0.9, y: 0, width: 0.2, height: 0.1 } }],
        }),
      /bounding box/,
    );
  });

  it('parses German decimal/comparator/date formats and keeps unsupported rows reviewable', () => {
    assert.deepEqual(parseComparatorValue('< 3,8'), {
      kind: 'bounded',
      comparator: '<',
      value: 3.8,
    });
    assert.deepEqual(parseLabDate('22.08.2026', 'de-DE'), { kind: 'known', value: '2026-08-22' });
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'label',
          text: 'LDL-Cholesterin',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.25, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: 0.99 },
        },
        {
          id: 'value',
          text: '3,8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.5, y: 0.2, width: 0.2, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: 0.99 },
        },
        {
          id: 'unknown',
          text: 'Mystery Marker 2,1 mg/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.3, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-22' }, specimenType: 'blood' },
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(rows[1]?.proposedBiomarkerId, null);
    assert.equal(rows[1]?.reviewState, 'needs-review');
    assert.equal(rows[0]?.source.pageIndex, 0);
  });

  it('preserves a laboratory reference interval and flag separately from the measured value', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'r',
          text: 'LDL-C 3,8 mmol/L 0-3,0 H',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
          pageIndex: 1,
          orientation: 90,
          recognition: { level: 'accurate', language: 'de', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-22' }, specimenType: 'blood' },
    );
    assert.equal(rows[0]?.sourceValueString, '3,8');
    assert.equal(rows[0]?.sourceReferenceInterval, '0-3,0');
    assert.equal(rows[0]?.sourceFlag, 'H');
    assert.equal(rows[0]?.proposedUnit, 'mmol/L');
  });

  it('builds stable grouped confirmation plans without interpolating source rows', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'r1',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: null, internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'missing' }, specimenType: 'blood' },
    );
    const draft = {
      id: 'draft-1',
      reportId: 'report-1',
      state: 'draft' as const,
      ocrContractVersion: 'alyte.vision.ocr.v1' as const,
      parserVersion: 'alyte.local-parser.v1' as const,
      collectionDate: { kind: 'missing' as const },
      rows,
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      confirmedAt: null,
    };
    const plan = buildExtractionConfirmationPlan(draft, {
      record: () => 'record-1',
      measurement: () => 'measurement-1',
    });
    assert.equal(plan.records.length, 1);
    assert.equal(plan.records[0]?.collectionDate.kind, 'missing');
    assert.equal(plan.records[0]?.measurements[0]?.source.pageIndex, 0);
  });
});
