import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeometryCandidateVariantAsProvisional,
  parseGeometryRowAsProvisional,
  parseGeometryRowIntoExtractionRows,
  type GeometryExtractionRowOptions,
} from './geometry-extraction.js';
import { reconstructGeometryLattice, type GeometrySourceObservation } from './geometry.js';
import { buildGeometryCandidateWindows } from './geometry-candidate-windows.js';
import {
  groupObservationsIntoRows,
  type ExtractionAliasEntry,
  type VisionTextObservation,
} from './extraction.js';

const aliases: readonly ExtractionAliasEntry[] = [
  {
    id: 'biomarker.ldl_c',
    aliases: ['LDL-C', 'LDL cholesterol'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mmol/L', 'mg/dL'],
  },
];

function observation(
  id: string,
  text: string,
  x: number,
  rowIndex: number,
  columnIndex: number,
  overrides: Partial<VisionTextObservation> = {},
): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x, y: 0.2 + rowIndex * 0.12, width: 0.14, height: 0.035 },
    pageIndex: 0,
    orientation: 0,
    structure: {
      kind: 'table-cell',
      tableId: 'synthetic-results',
      rowIndex,
      columnIndex,
    },
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
    ...overrides,
  };
}

function physicalRow(observations: readonly VisionTextObservation[], rowIndex = 0) {
  const source = observations.map((item): GeometrySourceObservation => ({
    id: item.id,
    text: item.text,
    boundingBox: item.boundingBox,
    pageIndex: item.pageIndex,
    ...(item.spans === undefined ? {} : { spans: item.spans }),
    ...(item.sourceSpan?.parentObservationId === undefined
      ? {}
      : { parentId: item.sourceSpan.parentObservationId }),
    ...(item.orientation === undefined ? {} : { orientation: item.orientation }),
    ...(item.structure === undefined ? {} : { structure: item.structure }),
  }));
  const row = reconstructGeometryLattice(source).rows.find((candidate) =>
    candidate.cells.some((cell) => cell.sourceObservationId === observations[0]?.id),
  );
  assert.ok(row, `row ${rowIndex} should be reconstructed`);
  return row;
}

function options(observations: readonly VisionTextObservation[], locale = 'en-US') {
  return {
    observations,
    locale,
    aliases,
    specimenType: 'serum' as const,
    collectionDate: { kind: 'known' as const, value: '2026-08-22' },
  } satisfies GeometryExtractionRowOptions;
}

describe('geometry-qualified extraction rows', () => {
  it('creates a review-only draft from one exact split-row candidate variant', () => {
    const looseStructure = {
      kind: 'text' as const,
      tableId: null,
      rowIndex: null,
      columnIndex: null,
    };
    const source = [
      observation('split-window-label', 'Novel biomarker', 0.08, 0, 0, {
        structure: looseStructure,
        boundingBox: { x: 0.08, y: 0.2, width: 0.24, height: 0.03 },
      }),
      observation('split-window-value', '3,8', 0.42, 0, 1, {
        structure: looseStructure,
        boundingBox: { x: 0.42, y: 0.245, width: 0.1, height: 0.03 },
        recognition: { level: 'accurate', language: 'lt', internalConfidence: null },
      }),
    ];
    const lattice = reconstructGeometryLattice(source);
    const variant = buildGeometryCandidateWindows(lattice, source)[0];
    assert.ok(variant);
    assert.equal(
      groupObservationsIntoRows(variant.observations, options(source, 'lt-LT')).length,
      0,
    );

    const provisional = parseGeometryCandidateVariantAsProvisional(variant, {
      locale: 'lt-LT',
      aliases,
      specimenType: 'serum',
      collectionDate: { kind: 'known', value: '2026-08-22' },
    });

    assert.ok(provisional);
    assert.equal(provisional.physicalRowId, variant.physicalRowId);
    assert.equal(provisional.row.decision, 'preserve');
    assert.equal(provisional.row.reviewState, 'needs-review');
    assert.deepEqual(provisional.row.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(provisional.row.source.raw?.label, 'Novel biomarker');
    assert.equal(provisional.row.source.raw?.value, '3,8');
    assert.deepEqual(provisional.row.source.observationIds, variant.sourceObservationIds);
    assert.deepEqual(provisional.row.source.observations, variant.observations);
    assert.deepEqual(provisional.fieldCellIds, variant.provisionalSourceFields);
  });

  it('keeps source-role ambiguity visible and rejects forged candidate provenance', () => {
    const source = [
      observation('variant-label-far', 'Marker beta', 0.04, 0, 0),
      observation('variant-label-near', 'Marker alpha', 0.22, 0, 1),
      observation('variant-value', '7.2', 0.5, 0, 2),
    ];
    const lattice = reconstructGeometryLattice(source);
    const variant = buildGeometryCandidateWindows(lattice, source)[0];
    assert.ok(variant);
    assert.deepEqual(variant.ambiguousSourceRoles, ['label']);

    const provisional = parseGeometryCandidateVariantAsProvisional(variant, {
      locale: 'en-US',
      aliases,
      specimenType: 'serum',
    });
    assert.ok(provisional);
    assert.ok(provisional.row.reviewReasons.includes('unsupported-layout'));

    const forgedField = {
      ...variant,
      provisionalSourceFields: {
        ...variant.provisionalSourceFields,
        unit: 'variant-label-far',
      },
    };
    assert.equal(
      parseGeometryCandidateVariantAsProvisional(forgedField, {
        locale: 'en-US',
        aliases,
      }),
      null,
    );

    const forgedObservation = {
      ...variant,
      observations: variant.observations.map((item) =>
        item.id === variant.anchorCellId ? { ...item, text: '9.9' } : item,
      ),
    };
    assert.equal(
      parseGeometryCandidateVariantAsProvisional(forgedObservation, {
        locale: 'en-US',
        aliases,
      }),
      null,
    );

    assert.equal(
      parseGeometryCandidateVariantAsProvisional(
        { ...variant, rowId: 'forged-candidate-row' },
        { locale: 'en-US', aliases },
      ),
      null,
    );

    const forgedSpan = {
      ...variant,
      observations: variant.observations.map((item) =>
        item.id === variant.anchorCellId && item.sourceSpan !== undefined
          ? {
              ...item,
              sourceSpan: { ...item.sourceSpan, parentObservationId: 'wrong-parent' },
            }
          : item,
      ),
    };
    assert.equal(
      parseGeometryCandidateVariantAsProvisional(forgedSpan, {
        locale: 'en-US',
        aliases,
      }),
      null,
    );
  });

  it('rejects a bounded window whose complete physical preimage exceeds the contract', () => {
    const source = [
      observation('oversized-label', 'Novel biomarker', 0.01, 0, 0),
      observation('oversized-value', '7.2', 0.18, 0, 1),
      ...Array.from({ length: 24 }, (_, index) =>
        observation(
          `oversized-note-${index}`,
          `annotation${String.fromCharCode(65 + (index % 26))}`,
          0.3 + index * 0.025,
          0,
          index + 2,
          { boundingBox: { x: 0.3 + index * 0.025, y: 0.2, width: 0.02, height: 0.03 } },
        ),
      ),
    ];
    const lattice = reconstructGeometryLattice(source);
    const variant = buildGeometryCandidateWindows(lattice, source).find(
      (candidate) => candidate.anchorCellId === 'oversized-value',
    );
    assert.ok(variant);
    assert.equal(
      parseGeometryCandidateVariantAsProvisional(variant, {
        locale: 'en-US',
        aliases,
      }),
      null,
    );
  });

  it('keeps an unfamiliar English biomarker as a provisional source-linked row', () => {
    const observations = [
      observation('unknown-label', 'Novel biomarker', 0.08, 0, 0),
      observation('unknown-value', '>3.8', 0.42, 0, 1),
    ];
    const row = physicalRow(observations);
    const provisional = parseGeometryRowAsProvisional(row, options(observations));

    assert.ok(provisional);
    assert.equal(provisional.kind, 'geometry-provisional');
    assert.equal(provisional.row.proposedBiomarkerId, null);
    assert.deepEqual(provisional.row.proposedValue, {
      kind: 'bounded',
      comparator: '>',
      value: 3.8,
    });
    assert.equal(provisional.row.sourceValueString, '>3.8');
    assert.equal(provisional.row.sourceUnit, null);
    assert.equal(provisional.row.sourceReferenceInterval, null);
    assert.equal(provisional.row.sourceFlag, null);
    assert.equal(provisional.row.decision, 'preserve');
    assert.ok(provisional.row.reviewReasons.includes('unsupported-alias'));
    assert.deepEqual(
      provisional.row.source.observationIds,
      observations.map((item) => item.id),
    );
    assert.deepEqual(
      provisional.row.source.observations?.map((item) => item.text),
      observations.map((item) => item.text),
    );
    assert.deepEqual(
      provisional.row.source.observations?.map((item) => item.boundingBox),
      observations.map((item) => item.boundingBox),
    );
    assert.deepEqual(
      provisional.row.source.observationIds,
      provisional.row.source.observations?.map((item) => item.id),
    );
    for (const sourceObservation of provisional.row.source.observations ?? []) {
      assert.ok(sourceObservation.sourceSpan);
      assert.equal(sourceObservation.sourceSpan?.parentObservationId, sourceObservation.id);
      assert.equal(sourceObservation.sourceSpan?.text, sourceObservation.text);
      assert.equal(sourceObservation.sourceSpan?.parentText, sourceObservation.text);
      assert.equal(sourceObservation.sourceSpan?.start, 0);
      assert.equal(sourceObservation.sourceSpan?.end, sourceObservation.text.length);
    }
    assert.equal(provisional.fieldCellIds.label, 'unknown-label');
    assert.equal(provisional.fieldCellIds.value, 'unknown-value');
  });

  it('admits an exact label/value row reconstructed from second parent bands', () => {
    const looseStructure = {
      kind: 'text' as const,
      tableId: null,
      rowIndex: null,
      columnIndex: null,
    };
    const labelParent = observation('second-band-label', 'Heading\nNovel biomarker', 0.08, 0, 0, {
      structure: looseStructure,
      boundingBox: { x: 0.08, y: 0.1, width: 0.24, height: 0.14 },
      spans: [
        {
          id: 'second-band-label-heading',
          parentObservationId: 'second-band-label',
          start: 0,
          end: 7,
          text: 'Heading',
          boundingBox: { x: 0.08, y: 0.1, width: 0.18, height: 0.035 },
        },
        {
          id: 'second-band-label-result',
          parentObservationId: 'second-band-label',
          start: 8,
          end: 23,
          text: 'Novel biomarker',
          boundingBox: { x: 0.08, y: 0.22, width: 0.24, height: 0.035 },
        },
      ],
    });
    const valueParent = observation('second-band-value', 'Status\n3.8', 0.42, 0, 1, {
      structure: looseStructure,
      boundingBox: { x: 0.42, y: 0.1, width: 0.14, height: 0.14 },
      spans: [
        {
          id: 'second-band-value-heading',
          parentObservationId: 'second-band-value',
          start: 0,
          end: 6,
          text: 'Status',
          boundingBox: { x: 0.42, y: 0.1, width: 0.14, height: 0.035 },
        },
        {
          id: 'second-band-value-result',
          parentObservationId: 'second-band-value',
          start: 7,
          end: 10,
          text: '3.8',
          boundingBox: { x: 0.42, y: 0.22, width: 0.1, height: 0.035 },
        },
      ],
    });
    const parents = [labelParent, valueParent];
    const lattice = reconstructGeometryLattice(
      parents.map((parent) => ({
        id: parent.id,
        text: parent.text,
        boundingBox: parent.boundingBox,
        pageIndex: parent.pageIndex,
        ...(parent.structure === undefined ? {} : { structure: parent.structure }),
        ...(parent.spans === undefined ? {} : { spans: parent.spans }),
      })),
    );
    const resultRow = lattice.rows.find((row) =>
      row.cells.some((cell) => cell.text === 'Novel biomarker'),
    );
    assert.ok(resultRow);
    assert.equal(resultRow.yBandCount, 1);

    const provisional = parseGeometryRowAsProvisional(resultRow, {
      ...options(parents),
      resultTableContext: true,
    });

    assert.ok(provisional);
    assert.deepEqual(provisional.row.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(provisional.row.source.raw?.label, 'Novel biomarker');
    assert.equal(provisional.row.source.raw?.value, '3.8');
  });

  it('leaves a known row in the deterministic branch without rewriting its source', () => {
    const observations = [
      observation('known-label', 'LDL-C', 0.08, 0, 0),
      observation('known-value', '3,8', 0.42, 0, 1, {
        recognition: { level: 'accurate', language: 'lt', internalConfidence: null },
      }),
      observation('known-unit', 'mmol/L', 0.6, 0, 2),
    ];
    const row = physicalRow(observations);
    const result = parseGeometryRowIntoExtractionRows(row, options(observations, 'lt-LT'));

    assert.equal(result.provisionalRows.length, 0);
    assert.equal(result.deterministicRows.length, 1);
    const deterministic = result.deterministicRows[0]!;
    assert.equal(deterministic.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(deterministic.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.deepEqual(
      deterministic.source.observationIds,
      observations.map((item) => item.id),
    );
    assert.deepEqual(
      deterministic.source.observations?.map((item) => item.text),
      ['LDL-C', '3,8', 'mmol/L'],
    );
  });

  it('returns exactly the ordinary parser rows on the deterministic branch', () => {
    const observations = [
      observation('ordinary-label', 'LDL-C', 0.08, 0, 0),
      observation('ordinary-value', '3.8', 0.42, 0, 1),
      observation('ordinary-unit', 'mmol/L', 0.6, 0, 2),
    ];
    const parserOptions = {
      locale: 'en-US',
      collectionDate: { kind: 'known' as const, value: '2026-08-22' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      specimenType: 'serum' as const,
      aliases,
      artifact: null,
    };
    const row = physicalRow(observations);
    const ordinary = groupObservationsIntoRows(
      row.cells.map((cell) => ({
        ...observations.find((item) => item.id === cell.sourceObservationId)!,
        id: cell.id,
        text: cell.text,
        boundingBox: cell.boundingBox,
        sourceSpan: {
          id: `${cell.id}:source`,
          parentObservationId: cell.sourceObservationId,
          start: cell.sourceStart,
          end: cell.sourceEnd,
          text: cell.text,
          boundingBox: cell.boundingBox,
          parentText: cell.text,
        },
      })),
      parserOptions,
    );
    const result = parseGeometryRowIntoExtractionRows(row, options(observations));
    assert.deepEqual(result.deterministicRows, ordinary);
    assert.equal(result.provisionalRows.length, 0);
  });

  it('keeps exact comparator, reference, and flag cells in the ordinary branch', () => {
    const observations = [
      observation('bounded-label', 'LDL-C', 0.08, 0, 0),
      observation('bounded-value', '≥3,8', 0.42, 0, 1),
      observation('bounded-unit', 'mmol/L', 0.6, 0, 2),
      observation('bounded-reference', '1,2-4,0', 0.74, 0, 3),
      observation('bounded-flag', 'H', 0.9, 0, 4, {
        boundingBox: { x: 0.9, y: 0.2, width: 0.05, height: 0.035 },
      }),
    ];
    const row = physicalRow(observations);
    const result = parseGeometryRowIntoExtractionRows(row, options(observations, 'lt-LT'));

    assert.equal(result.provisionalRows.length, 0);
    assert.equal(result.deterministicRows.length, 1);
    const deterministic = result.deterministicRows[0]!;
    assert.deepEqual(deterministic.proposedValue, { kind: 'bounded', comparator: '>', value: 3.8 });
    assert.equal(deterministic.sourceReferenceInterval, '1,2-4,0');
    assert.equal(deterministic.sourceFlag, 'H');
  });

  it('preserves a Lithuanian decimal comma and exact field provenance for an unfamiliar row', () => {
    const observations = [
      observation('lt-unknown-label', 'Nežinomas žymuo', 0.08, 0, 0, {
        recognition: { level: 'accurate', language: 'lt', internalConfidence: null },
      }),
      observation('lt-unknown-value', '3,8', 0.42, 0, 1, {
        recognition: { level: 'accurate', language: 'lt', internalConfidence: null },
      }),
    ];
    const row = physicalRow(observations);
    const provisional = parseGeometryRowAsProvisional(row, options(observations, 'lt-LT'));

    assert.ok(provisional);
    assert.deepEqual(provisional.row.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(provisional.row.source.raw?.value, '3,8');
    assert.equal(provisional.row.source.raw?.label, 'Nežinomas žymuo');
    assert.equal(provisional.row.source.raw?.unit, null);
    assert.equal(provisional.row.source.observations?.[1]?.sourceSpan?.parentText, '3,8');
  });

  it('preserves supported exact-cell categorical results without interpreting them', () => {
    for (const [locale, label, value] of [
      ['en-US', 'Novel assay', 'not detected'],
      ['en-US', 'Culture response', 'resistant'],
      ['de-DE', 'Unbekannter Marker', 'nicht nachgewiesen'],
      ['de-DE', 'Kulturantwort', 'empfindlich'],
      ['lt-LT', 'Nežinomas žymuo', 'neaptikta'],
    ] as const) {
      const observations = [
        observation(`categorical-label-${locale}`, label, 0.08, 0, 0),
        observation(`categorical-value-${locale}`, value, 0.42, 0, 1),
      ];
      const row = physicalRow(observations);
      const result = parseGeometryRowIntoExtractionRows(row, options(observations, locale));

      assert.equal(result.provisionalRows.length, 0, locale);
      assert.equal(result.deterministicRows.length, 1, locale);
      const parsed = result.deterministicRows[0]!;
      assert.deepEqual(parsed.proposedValue, { kind: 'categorical', value }, locale);
      assert.equal(parsed.sourceValueString, value, locale);
      assert.equal(parsed.proposedBiomarkerId, null, locale);
    }
  });

  it('rejects arbitrary value prose and a combined value-unit cell from the provisional path', () => {
    for (const value of ['3.8 collected 2026-08-22', 'positive according to report']) {
      const observations = [
        observation(`prose-label-${value}`, 'Novel biomarker', 0.08, 0, 0),
        observation(`prose-value-${value}`, value, 0.42, 0, 1),
      ];
      const row = physicalRow(observations);
      const result = parseGeometryRowIntoExtractionRows(row, options(observations));
      assert.equal(result.provisionalRows.length, 0, value);
    }

    const combined = [
      observation('combined-label', 'Novel biomarker', 0.08, 0, 0),
      observation('combined-value-unit', '3.8 mmol/L', 0.42, 0, 1),
    ];
    const combinedResult = parseGeometryRowIntoExtractionRows(
      physicalRow(combined),
      options(combined),
    );
    assert.equal(combinedResult.provisionalRows.length, 0);
  });

  it('rejects a known alias when the row is unshaped', () => {
    for (const label of ['LDL-C', 'LDL-C result']) {
      const observations = [
        observation(`known-unshaped-label-${label}`, label, 0.08, 0, 0),
        observation(`known-unshaped-value-${label}`, 'awaiting review', 0.42, 0, 1),
      ];
      const result = parseGeometryRowIntoExtractionRows(
        physicalRow(observations),
        options(observations),
      );
      assert.deepEqual(result, { deterministicRows: [], provisionalRows: [] }, label);
    }
  });

  it('keeps token-split provenance positional and rejects corrupted parent spans', () => {
    const parentText = 'Novel biomarker 3.8';
    const parent = observation('split-parent', parentText, 0.08, 0, 0, {
      structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
      boundingBox: { x: 0.08, y: 0.2, width: 0.45, height: 0.035 },
      spans: [
        {
          id: 'split-label',
          parentObservationId: 'split-parent',
          start: 0,
          end: 15,
          text: 'Novel biomarker',
          boundingBox: { x: 0.08, y: 0.2, width: 0.25, height: 0.035 },
        },
        {
          id: 'split-value',
          parentObservationId: 'split-parent',
          start: 16,
          end: 19,
          text: '3.8',
          boundingBox: { x: 0.42, y: 0.2, width: 0.08, height: 0.035 },
        },
      ],
    });
    const row = physicalRow([parent]);
    const provisional = parseGeometryRowAsProvisional(row, {
      ...options([parent]),
      resultTableContext: true,
    });

    assert.ok(provisional);
    const sourceObservations = provisional.row.source.observations ?? [];
    assert.deepEqual(
      provisional.row.source.observationIds,
      sourceObservations.map((item) => item.id),
    );
    assert.deepEqual(
      sourceObservations.map((item) => item.text),
      ['Novel biomarker', '3.8'],
    );
    for (const sourceObservation of sourceObservations) {
      const span = sourceObservation.sourceSpan;
      assert.ok(span);
      assert.equal(span?.parentObservationId, parent.id);
      assert.equal(span?.parentText, parent.text);
      assert.equal(span?.text, parent.text.slice(span?.start ?? -1, span?.end ?? -1));
      assert.equal(Number.isInteger(span?.start), true);
      assert.equal(Number.isInteger(span?.end), true);
      assert.equal((span?.start ?? 0) >= 0, true);
      assert.equal((span?.end ?? 0) <= parent.text.length, true);
    }

    const badParent = {
      ...row,
      cells: row.cells.map((cell, index) =>
        index === 0 ? { ...cell, parentId: 'wrong-parent' } : cell,
      ),
    };
    assert.equal(parseGeometryRowAsProvisional(badParent, options([parent])), null);

    const badSpan = {
      ...row,
      cells: row.cells.map((cell, index) =>
        index === 1 ? { ...cell, sourceEnd: parent.text.length + 1 } : cell,
      ),
    };
    assert.equal(parseGeometryRowAsProvisional(badSpan, options([parent])), null);

    const overlapping = {
      ...row,
      cells: [
        ...row.cells,
        {
          ...row.cells[1]!,
          id: 'overlapping-child',
          sourceStart: 14,
          sourceEnd: 19,
          text: parent.text.slice(14, 19),
        },
      ],
    };
    assert.equal(parseGeometryRowAsProvisional(overlapping, options([parent])), null);
  });

  it('requires result-table or sibling evidence for an unadorned unknown numeric row', () => {
    const observations = [
      observation('loose-label', 'Novel biomarker', 0.08, 0, 0, {
        structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
      }),
      observation('loose-value', '3.8', 0.42, 0, 1, {
        structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
      }),
    ];
    const row = physicalRow(observations);
    assert.equal(parseGeometryRowAsProvisional(row, options(observations)), null);
    const withEvidence = parseGeometryRowAsProvisional(row, {
      ...options(observations),
      resultTableContext: true,
    });
    assert.ok(withEvidence);
  });

  it('fails closed for ambiguous values, unresolved geometry, and duplicate cells', () => {
    const ambiguousObservations = [
      observation('ambiguous-label', 'Novel biomarker', 0.08, 0, 0),
      observation('ambiguous-value-a', '3.8', 0.42, 0, 1),
      observation('ambiguous-value-b', '4.1', 0.52, 0, 2),
      observation('ambiguous-unit', 'mmol/L', 0.7, 0, 3),
    ];
    const ambiguous = physicalRow(ambiguousObservations);
    assert.equal(parseGeometryRowAsProvisional(ambiguous, options(ambiguousObservations)), null);

    const unresolvedObservation = observation('unresolved', 'Novel biomarker 3.8', 0.08, 0, 0);
    const unresolvedLattice = reconstructGeometryLattice([
      {
        id: unresolvedObservation.id,
        text: unresolvedObservation.text,
        pageIndex: 0,
        boundingBox: { x: 0.08, y: 0.2, width: 0.7, height: 0.2 },
        spans: [
          {
            start: 0,
            end: 5,
            text: 'Novel',
            boundingBox: { x: 0.08, y: 0.2, width: 0.1, height: 0.03 },
          },
          {
            start: 6,
            end: 15,
            text: 'biomarker',
            boundingBox: { x: 0.08, y: 0.3, width: 0.2, height: 0.03 },
          },
          {
            start: 16,
            end: 19,
            text: '3.8',
            boundingBox: { x: 0.08, y: 0.4, width: 0.1, height: 0.03 },
          },
        ],
      },
    ]);
    const unresolved = unresolvedLattice.rows[0]!;
    assert.equal(parseGeometryRowAsProvisional(unresolved, options([unresolvedObservation])), null);

    const goodObservations = [
      observation('good-label', 'Novel biomarker', 0.08, 0, 0),
      observation('good-value', '3.8', 0.42, 0, 1),
    ];
    const good = physicalRow(goodObservations);
    const duplicate = {
      ...good,
      cells: [...good.cells, { ...good.cells[0]!, id: 'duplicate-cell' }],
    };
    assert.equal(parseGeometryRowAsProvisional(duplicate, options(goodObservations)), null);
  });

  it('does not turn multilingual metadata, headings, or footers into provisional rows', () => {
    for (const [label, value, locale] of [
      ['Laboratory Results', '2026', 'en-US'],
      ['Report generated', '2026', 'en-US'],
      ['Page', '1', 'en-US'],
      ['Probenentnahme Datum', '2026', 'de-DE'],
      ['Patientenkennung', '2026', 'de-DE'],
      ['Mėginio paėmimo data', '2026', 'lt-LT'],
      ['Paciento numeris', '2026', 'lt-LT'],
    ] as const) {
      const observations = [
        observation(`heading-${label}`, label, 0.08, 0, 0),
        observation(`heading-value-${label}`, value, 0.42, 0, 1),
      ];
      const row = physicalRow(observations);
      assert.equal(parseGeometryRowAsProvisional(row, options(observations, locale)), null, label);
    }
  });
});
