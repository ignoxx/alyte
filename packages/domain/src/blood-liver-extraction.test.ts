import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bloodLiverBiomarkers } from '@alyte/catalogue';
import {
  groupObservationsIntoRows,
  type ExtractionAliasEntry,
  type VisionTextObservation,
} from './extraction.js';

const productionAliases: readonly ExtractionAliasEntry[] = bloodLiverBiomarkers.map((entry) => ({
  id: entry.id,
  aliases: entry.aliases,
  specimens: entry.specimens,
  units: entry.units,
  ...(entry.unsafeAliases === undefined ? {} : { unsafeAliases: entry.unsafeAliases }),
  ...(entry.methodPolicy === undefined
    ? {}
    : {
        methodPolicy: {
          version: entry.methodPolicy.version,
          kind: entry.methodPolicy.kind,
          allowedMethods: entry.methodPolicy.allowedMethods,
          unsafePatterns: entry.methodPolicy.unsafePatterns,
          ...(entry.methodPolicy.profiles === undefined
            ? {}
            : { profiles: entry.methodPolicy.profiles }),
        },
      }),
}));

function observation(id: string, text: string, rowIndex: number): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    pageIndex: 0,
    orientation: 0,
    boundingBox: { x: 0.1, y: 0.1 + rowIndex * 0.1, width: 0.8, height: 0.04 },
    structure: {
      kind: 'table-cell',
      tableId: 'blood-liver-panel',
      rowIndex,
      columnIndex: 0,
    },
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
  };
}

describe('blood-count and liver production extraction fixtures', () => {
  it('maps realistic six-family rows through row grouping and method contracts', () => {
    const rows = groupObservationsIntoRows(
      [
        observation('hgb', 'Hemoglobin 14.0 g/dL', 0),
        observation('hct', 'Hematokryt 42 %', 1),
        observation('mcv', 'MCV 89 fL', 2),
        observation('alt', 'ALT IFCC 37 C with P5P 22 U/L', 3),
        observation('ast', 'AST IFCC 37 C with P5P 24 U/L', 4),
        observation('ggt', 'GGT IFCC 37 C with P5P 18 U/L', 5),
      ],
      {
        aliases: productionAliases,
        collectionDate: { kind: 'known', value: '2026-08-24' },
        specimenType: 'blood',
      },
    );

    assert.deepEqual(
      rows.map((row) => [row.proposedBiomarkerId, row.reviewState]),
      [
        ['biomarker.hemoglobin', 'ready'],
        ['biomarker.hematocrit', 'ready'],
        ['biomarker.mcv', 'ready'],
        ['biomarker.alt', 'ready'],
        ['biomarker.ast', 'ready'],
        ['biomarker.ggt', 'ready'],
      ],
    );
  });

  it('fails closed when a row contains sibling analyte labels', () => {
    const [row] = groupObservationsIntoRows([observation('ambiguous', 'ALT / AST 22 U/L', 0)], {
      aliases: productionAliases,
      collectionDate: { kind: 'known', value: '2026-08-24' },
      specimenType: 'serum',
    });
    assert.equal(row?.proposedBiomarkerId, null);
    assert.equal(row?.reviewState, 'needs-review');
    assert.ok(row?.reviewReasons.includes('ambiguous-assay'));
  });
});
