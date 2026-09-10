import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeometryCandidateWindows,
  geometryResultAnchorKind,
  groupGeometryCandidateWindows,
  GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS,
  GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS,
  GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROW_GAP,
  decodeVisionOCRResult,
  reconstructGeometryLattice,
  type GeometrySourceObservation,
  type VisionTextObservation,
} from './index.js';

type TestObservation = VisionTextObservation & {
  readonly context?: GeometrySourceObservation['context'];
};

function observation(
  id: string,
  text: string,
  x: number,
  y: number,
  overrides: Partial<TestObservation> = {},
): TestObservation {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x, y, width: 0.16, height: 0.03 },
    pageIndex: 0,
    orientation: 0,
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
    ...overrides,
  };
}

function tableCell(
  id: string,
  text: string,
  x: number,
  rowIndex: number,
  columnIndex: number,
  overrides: Partial<TestObservation> = {},
): TestObservation {
  return observation(id, text, x, 0.2 + rowIndex * 0.08, {
    structure: { kind: 'table-cell', tableId: 'results', rowIndex, columnIndex },
    ...overrides,
  });
}

function geometryObservations(observations: readonly TestObservation[]) {
  return observations as readonly GeometrySourceObservation[];
}

describe('geometry source-selector candidate windows', () => {
  it('creates one bounded candidate for each scalar result anchor in one physical row', () => {
    const source = [
      tableCell('label', 'LDL-C', 0.05, 0, 0),
      tableCell('first-value', '3.8', 0.36, 0, 1),
      tableCell('unit', 'mmol/L', 0.5, 0, 2),
      tableCell('second-value', '4.1', 0.7, 0, 3),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidates = buildGeometryCandidateWindows(lattice, source);

    assert.deepEqual(
      candidates.map((candidate) => [candidate.anchorCellId, candidate.anchorKind]),
      [
        ['first-value', 'numeric'],
        ['second-value', 'numeric'],
      ],
    );
    for (const candidate of candidates) {
      assert.equal(candidate.sourceObservationIds.length, candidate.observations.length);
      assert.ok(candidate.sourceObservationIds.includes(candidate.anchorCellId));
      assert.ok(candidate.observations.some((item) => item.text === 'LDL-C'));
      assert.ok(candidate.observations.length <= GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS);
      assert.equal(candidate.provisionalSourceFields.label, 'label');
      assert.equal(candidate.provisionalSourceFields.value, candidate.anchorCellId);
      assert.equal(candidate.provisionalSourceFields.unit, 'unit');
      assert.deepEqual(candidate.ambiguousSourceRoles, []);
    }
    assert.equal(new Set(candidates.map((candidate) => candidate.physicalRowId)).size, 1);
    const groups = groupGeometryCandidateWindows(candidates);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.anchorCellIds, ['first-value', 'second-value']);
    assert.deepEqual(groups[0]?.sourceObservationIds, [
      'label',
      'first-value',
      'unit',
      'second-value',
    ]);
    assert.equal(groups[0]?.withinInputBounds, true);
  });

  it('preserves the leading analyte label instead of a nearer method fragment', () => {
    const source = [
      tableCell('analyte-label', 'Marker beta', 0.02, 0, 0),
      tableCell('method-fragment', 'Immunoassay method', 0.2, 0, 1),
      tableCell('value', '7.2', 0.5, 0, 2),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidate = buildGeometryCandidateWindows(lattice, source)[0];

    assert.ok(candidate);
    assert.equal(candidate.provisionalSourceFields.label, 'analyte-label');
    assert.equal(candidate.provisionalSourceFields.value, 'value');
    assert.deepEqual(candidate.ambiguousSourceRoles, ['label']);

    const forged = {
      ...candidate,
      provisionalSourceFields: {
        ...candidate.provisionalSourceFields,
        label: 'not-a-source-cell',
      },
    };
    assert.deepEqual(groupGeometryCandidateWindows([forged]), []);
  });

  it('declares label ambiguity introduced by a retained but non-selectable support cell', () => {
    const source = [
      tableCell('supported-label', 'Marker beta', 0.02, 0, 0),
      tableCell('supported-value', '7.2', 0.5, 0, 1),
      tableCell('supporting-prose', 'This is a comment', 0.68, 0, 2),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidate = buildGeometryCandidateWindows(lattice, source)[0];

    assert.ok(candidate);
    assert.deepEqual(candidate.sourceObservationIds, [
      'supported-label',
      'supported-value',
      'supporting-prose',
    ]);
    assert.equal(candidate.provisionalSourceFields.label, 'supported-label');
    assert.deepEqual(candidate.ambiguousSourceRoles, ['label']);
  });

  it('keeps a long analyte label whose center remains left of the result', () => {
    const source = [
      tableCell('long-label', 'Estimated filtration marker', 0.05, 0, 0, {
        boundingBox: { x: 0.05, y: 0.2, width: 0.55, height: 0.03 },
      }),
      tableCell('long-label-value', '83.7', 0.5, 0, 1, {
        boundingBox: { x: 0.5, y: 0.2, width: 0.1, height: 0.03 },
      }),
    ];

    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidate = buildGeometryCandidateWindows(lattice, source)[0];

    assert.ok(candidate);
    assert.equal(candidate.provisionalSourceFields.label, 'long-label');
    assert.equal(candidate.provisionalSourceFields.value, 'long-label-value');
  });

  it('keeps an oversized physical row as one bounded group instead of splitting inference', () => {
    const source = [tableCell('large-label', 'Uncatalogued marker', 0.01, 0, 0)];
    for (let index = 0; index < GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS + 1; index += 1) {
      source.push(
        tableCell(`large-value-${index}`, `${index + 1}`, 0.03 + index * 0.03, 0, index + 1),
      );
    }
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const windows = buildGeometryCandidateWindows(lattice, source);
    const groups = groupGeometryCandidateWindows(windows);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.variants.length, GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS + 1);
    assert.equal(groups[0]?.withinInputBounds, false);
    assert.equal(new Set(groups[0]?.variants.map((variant) => variant.physicalRowId)).size, 1);
  });

  it('bounds a single-anchor group by the complete physical preimage', () => {
    const source = [
      tableCell('wide-single-label', 'Uncatalogued marker', 0.01, 0, 0),
      tableCell('wide-single-value', '7.2', 0.03, 0, 1),
      ...Array.from({ length: GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS }, (_, index) =>
        tableCell(`wide-single-note-${index}`, `note-${index}`, 0.06 + index * 0.03, 0, index + 2),
      ),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const windows = buildGeometryCandidateWindows(lattice, source);
    const groups = groupGeometryCandidateWindows(windows);

    assert.equal(windows.length, 1);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.withinInputBounds, false);
  });

  it('rejects a colliding opaque identity when its exact physical-row preimage differs', () => {
    const source = [
      tableCell('collision-label-a', 'Marker A', 0.05, 0, 0),
      tableCell('collision-value-a', '3.8', 0.45, 0, 1),
      tableCell('collision-label-b', 'Marker B', 0.05, 1, 0),
      tableCell('collision-value-b', '4.1', 0.45, 1, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const windows = buildGeometryCandidateWindows(lattice, source);
    assert.equal(windows.length, 2);
    const [first, second] = windows;
    assert.ok(first);
    assert.ok(second);

    const corrupt = [
      first,
      {
        ...second,
        physicalRowId: first.physicalRowId,
        physicalRowKey: first.physicalRowKey,
      },
    ];
    assert.deepEqual(groupGeometryCandidateWindows(corrupt), []);

    const forgedPreimage = {
      ...second,
      physicalRowId: first.physicalRowId,
      physicalRowKey: first.physicalRowKey,
      physicalRowCells: first.physicalRowCells,
    };
    assert.deepEqual(groupGeometryCandidateWindows([first, forgedPreimage]), []);
  });

  it('deduplicates an exact repeated anchor variant without merging a cross-row preimage', () => {
    const source = [
      tableCell('duplicate-label', 'Marker', 0.05, 0, 0),
      tableCell('duplicate-value', '3.8', 0.45, 0, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const windows = buildGeometryCandidateWindows(lattice, source);
    assert.equal(windows.length, 1);
    const groups = groupGeometryCandidateWindows([windows[0]!, windows[0]!]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.variants.length, 1);
  });

  it('keeps large synthetic grouping bounded and deterministic', () => {
    const rowCount = 512;
    const source = Array.from({ length: rowCount }, (_, rowIndex) => [
      tableCell(`large-synthetic-label-${rowIndex}`, `Marker ${rowIndex}`, 0.05, rowIndex, 0),
      tableCell(`large-synthetic-value-${rowIndex}`, `${rowIndex + 1}`, 0.45, rowIndex, 1),
    ]).flat();
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const windows = buildGeometryCandidateWindows(lattice, source);
    const groups = groupGeometryCandidateWindows([...windows].reverse());

    assert.equal(groups.length, rowCount);
    assert.equal(
      groups.every((group) => group.withinInputBounds),
      true,
    );
    assert.equal(new Set(groups.map((group) => group.physicalRowId)).size, rowCount);
    assert.deepEqual(
      groups.map((group) => group.sourceObservationIds[1]),
      Array.from({ length: rowCount }, (_, rowIndex) => `large-synthetic-value-${rowIndex}`),
    );
  });

  it('joins a label and value split across one tightly adjacent OCR row', () => {
    const source = [
      observation('split-label', 'Ferritin', 0.06, 0.2),
      observation('split-value', '42', 0.43, 0.245),
      observation('split-unit', 'ng/mL', 0.57, 0.245),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    assert.equal(lattice.rows.length, 2);

    const candidates = buildGeometryCandidateWindows(lattice, source);
    assert.equal(candidates.length, 1);
    assert.deepEqual(
      candidates[0]?.observations.map((item) => item.text),
      ['Ferritin', '42', 'ng/mL'],
    );
    assert.equal(candidates[0]?.context.pageIndex, 0);
  });

  it('anchors Lithuanian grouped decimals with spaces, NBSP, and dot grouping', () => {
    const source = [
      tableCell('lt-label-space', 'Bendras cholesterolis', 0.05, 0, 0),
      tableCell('lt-value-space', '1 234,56', 0.45, 0, 1),
      tableCell('lt-label-nbsp', 'Trigliceridai', 0.05, 1, 0),
      tableCell('lt-value-nbsp', '1\u00a0234,56', 0.45, 1, 1),
      tableCell('lt-label-dot', 'Gliukozė', 0.05, 2, 0),
      tableCell('lt-value-dot', '1.234,56', 0.45, 2, 1),
      tableCell('lt-label-narrow-nbsp', 'Feritinas', 0.05, 3, 0),
      tableCell('lt-value-narrow-nbsp', '1\u202f234,56', 0.45, 3, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidates = buildGeometryCandidateWindows(lattice, source);

    assert.deepEqual(
      candidates.map((candidate) => candidate.anchorCellId),
      ['lt-value-space', 'lt-value-nbsp', 'lt-value-dot', 'lt-value-narrow-nbsp'],
    );
  });

  it('does not bridge a distant label row or a row that already has another result anchor', () => {
    const distantSource = [
      observation('distant-label', 'Ferritin', 0.06, 0.2),
      observation('distant-value', '42', 0.43, 0.31),
    ];
    const distantLattice = reconstructGeometryLattice(geometryObservations(distantSource));
    assert.equal(buildGeometryCandidateWindows(distantLattice, distantSource).length, 0);

    const competingSource = [
      observation('competing-label', 'Ferritin', 0.06, 0.2),
      observation('competing-value', '42', 0.43, 0.2),
      observation('next-value', '43', 0.43, 0.245),
    ];
    const competingLattice = reconstructGeometryLattice(geometryObservations(competingSource));
    assert.equal(buildGeometryCandidateWindows(competingLattice, competingSource).length, 1);
    assert.equal(
      buildGeometryCandidateWindows(competingLattice, competingSource)[0]?.anchorCellId,
      'competing-value',
    );
  });

  it('never joins cells across page, table, section, specimen, or collection-date context', () => {
    const context = {
      sectionId: 'blood',
      specimenKey: 'serum',
      collectionDateKey: '2026-08-20',
    };
    const source = [
      observation('label-page-a', 'Unknown marker', 0.05, 0.2, { context }),
      observation('value-page-b', '3.8', 0.43, 0.2, { pageIndex: 1, context }),
      observation('label-table-a', 'Another marker', 0.05, 0.3, {
        context: { ...context, tableId: 'table-a' },
      }),
      observation('value-table-b', '4.2', 0.43, 0.3, {
        context: { ...context, tableId: 'table-b' },
      }),
      observation('label-section-a', 'Third marker', 0.05, 0.4, { context }),
      observation('value-section-b', '5.2', 0.43, 0.4, {
        context: { ...context, sectionId: 'chemistry' },
      }),
      observation('label-specimen-a', 'Fourth marker', 0.05, 0.5, { context }),
      observation('value-specimen-b', '6.2', 0.43, 0.5, {
        context: { ...context, specimenKey: 'plasma' },
      }),
      observation('label-date-a', 'Fifth marker', 0.05, 0.6, { context }),
      observation('value-date-b', '7.2', 0.43, 0.6, {
        context: { ...context, collectionDateKey: '2026-08-21' },
      }),
    ];

    const lattice = reconstructGeometryLattice(geometryObservations(source));
    assert.equal(buildGeometryCandidateWindows(lattice, source).length, 0);
  });

  it('does not skip an intervening physical row from another context', () => {
    const context = {
      sectionId: 'chemistry',
      specimenKey: 'serum',
      collectionDateKey: '2026-08-20',
    };
    const source = [
      observation('split-label', 'Ferritin', 0.05, 0.2, { context }),
      observation('intervening-other-context', 'Panel header', 0.05, 0.24, {
        context: { ...context, sectionId: 'lipids' },
      }),
      observation('split-value', '42', 0.45, 0.28, { context }),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));

    assert.equal(buildGeometryCandidateWindows(lattice, source).length, 0);
  });

  it('keeps each source-selector row at six distinct exact cells', () => {
    const source = [
      tableCell('label', 'Uncatalogued biomarker', 0.02, 0, 0),
      tableCell('value', '7.2', 0.2, 0, 1),
      tableCell('unit', 'mg/L', 0.35, 0, 2),
      tableCell('reference', '4-8', 0.48, 0, 3),
      tableCell('flag', 'H', 0.61, 0, 4),
      tableCell('extra-one', 'assay', 0.73, 0, 5),
      tableCell('extra-two', 'comment', 0.84, 0, 6),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidates = buildGeometryCandidateWindows(lattice, source);

    assert.equal(candidates.length, 1);
    assert.ok(candidates[0]!.observations.length <= GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS);
    assert.equal(
      new Set(candidates[0]!.sourceObservationIds).size,
      candidates[0]!.sourceObservationIds.length,
    );
    assert.ok(candidates[0]!.observations.some((item) => item.text === 'Uncatalogued biomarker'));
    assert.ok(candidates[0]!.observations.some((item) => item.text === '7.2'));
  });

  it('deduplicates a repeated physical row and preserves unsupported categorical results', () => {
    const source = [
      tableCell('marker', 'Uncatalogued antibody', 0.05, 0, 0),
      tableCell('result', 'Negative', 0.45, 0, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const repeated = { ...lattice, rows: [lattice.rows[0]!, lattice.rows[0]!] };
    const candidates = buildGeometryCandidateWindows(repeated, source);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.anchorKind, 'categorical');
    assert.equal(
      candidates[0]?.observations.find((item) => item.id === 'result')?.text,
      'Negative',
    );
    assert.equal(
      candidates[0]?.observations.find((item) => item.id === 'marker')?.text,
      'Uncatalogued antibody',
    );
  });

  it('recognizes the complete downstream categorical vocabulary without adding prose values', () => {
    const categoricalValues = [
      'not detected',
      'positive',
      'negative',
      'detected',
      'normal',
      'abnormal',
      'present',
      'non-reactive',
      'resistant',
      'no growth',
      'nicht nachgewiesen',
      'nicht nachweisbar',
      'nachgewiesen',
      'positiv',
      'negativ',
      'auffällig',
      'unauffällig',
      'vorhanden',
      'empfindlich',
      'intermediär',
      'kein wachstum',
      'teigiamas',
      'neigiamas',
      'aptikta',
      'neaptikta',
      'nenustatyta',
      'normalus',
      'nenormalus',
    ];
    const source = categoricalValues.flatMap((value, index) => [
      tableCell(`categorical-label-${index}`, `Marker ${index}`, 0.05, index, 0),
      tableCell(`categorical-value-${index}`, value, 0.45, index, 1),
    ]);
    const lattice = reconstructGeometryLattice(geometryObservations(source));

    assert.deepEqual(
      buildGeometryCandidateWindows(lattice, source).map((candidate) => candidate.anchorCellId),
      categoricalValues.map((_, index) => `categorical-value-${index}`),
    );
    assert.equal(geometryResultAnchorKind('organism may be present'), null);
    assert.equal(geometryResultAnchorKind('S'), null);
    assert.equal(geometryResultAnchorKind('R'), null);
    assert.equal(geometryResultAnchorKind('I'), null);
  });

  it('blocks metadata/header/footer labels and date-like numeric anchors', () => {
    const source = [
      tableCell('header-label', 'Value', 0.05, 0, 0),
      tableCell('header-value', '1', 0.45, 0, 1),
      tableCell('date-label', 'Date', 0.05, 1, 0),
      tableCell('date-value', '2026-08-20', 0.45, 1, 1),
      tableCell('footer-label', 'Page', 0.05, 2, 0),
      tableCell('footer-value', '1', 0.45, 2, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));

    assert.deepEqual(buildGeometryCandidateWindows(lattice, source), []);
  });

  it('blocks multilingual prose and metadata cells while keeping analyte labels eligible', () => {
    const source = [
      tableCell('english-prose-label', 'This is a comment', 0.05, 0, 0),
      tableCell('english-prose-value', '3.8', 0.45, 0, 1),
      tableCell('german-metadata-label', 'Referenzbereich', 0.05, 1, 0),
      tableCell('german-metadata-value', '3.8', 0.45, 1, 1),
      tableCell('lithuanian-prose-label', 'Tyrimo rezultatai', 0.05, 2, 0),
      tableCell('lithuanian-prose-value', '3,8', 0.45, 2, 1),
      tableCell('company-code-label', 'Įmonės kodas, licencijos Nr.', 0.05, 3, 0),
      tableCell('company-code-value', '300887021', 0.45, 3, 1),
      tableCell('valid-label', 'C reaktyvusis baltymas', 0.05, 4, 0),
      tableCell('valid-value', '3,8', 0.45, 4, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));

    assert.deepEqual(
      buildGeometryCandidateWindows(lattice, source).map((candidate) => candidate.anchorCellId),
      ['valid-value'],
    );
  });

  it('rejects malformed cell parent, bounds, and source text provenance', () => {
    const source = [
      tableCell('label', 'Ferritin', 0.05, 0, 0),
      tableCell('value', '42', 0.45, 0, 1),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const row = lattice.rows[0]!;
    const tamper = (patch: Partial<(typeof row.cells)[number]>) => ({
      ...lattice,
      rows: [
        {
          ...row,
          cells: row.cells.map((cell) => (cell.id === 'value' ? { ...cell, ...patch } : cell)),
        },
      ],
    });

    assert.deepEqual(
      buildGeometryCandidateWindows(tamper({ parentId: 'wrong-parent' }), source),
      [],
    );
    assert.deepEqual(buildGeometryCandidateWindows(tamper({ sourceEnd: 99 }), source), []);
    assert.deepEqual(buildGeometryCandidateWindows(tamper({ text: '43' }), source), []);
  });

  it('preserves token-derived source spans and produces stable IDs and order', () => {
    const parentText = 'Ferritin 42 ng/mL';
    const source = [
      observation('parent', parentText, 0.05, 0.2, {
        spans: [
          {
            id: 'label-span',
            parentObservationId: 'parent',
            start: 0,
            end: 8,
            text: 'Ferritin',
            boundingBox: { x: 0.05, y: 0.2, width: 0.2, height: 0.03 },
          },
          {
            id: 'value-span',
            parentObservationId: 'parent',
            start: 9,
            end: 11,
            text: '42',
            boundingBox: { x: 0.3, y: 0.2, width: 0.08, height: 0.03 },
          },
          {
            id: 'unit-span',
            parentObservationId: 'parent',
            start: 12,
            end: 17,
            text: 'ng/mL',
            boundingBox: { x: 0.4, y: 0.2, width: 0.12, height: 0.03 },
          },
        ],
      }),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const first = buildGeometryCandidateWindows(lattice, source);
    const second = buildGeometryCandidateWindows(lattice, source);

    assert.deepEqual(
      first.map((candidate) => candidate.rowId),
      second.map((candidate) => candidate.rowId),
    );
    assert.equal(first.length, 1);
    const value = first[0]!.observations.find((item) => item.text === '42')!;
    assert.equal(value.id, 'parent:9:11');
    assert.equal(value.sourceSpan?.parentObservationId, 'parent');
    assert.equal(value.sourceSpan?.parentText, parentText);
    assert.equal(value.sourceSpan?.text, parentText.slice(9, 11));
    assert.equal(value.text, parentText.slice(value.sourceSpan!.start, value.sourceSpan!.end));
    assert.equal(value.spans, undefined);
    assert.ok(first[0]!.rowId.startsWith('gw-'));
    assert.ok(first[0]!.rowId.length <= 96);
    assert.equal(first[0]!.rowId.includes('parent:9:11'), false);
    assert.ok(first[0]!.physicalRowId.startsWith('pr-'));
    assert.equal(first[0]!.physicalRowId.includes('parent'), false);
    const group = groupGeometryCandidateWindows(first)[0]!;
    assert.equal(
      group.observations.find((item) => item.text === '42')?.sourceSpan?.parentText,
      parentText,
    );

    assert.doesNotThrow(() =>
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v4',
        pageIndex: 0,
        orientation: 0,
        observations: first[0]!.observations,
      }),
    );
  });

  it('drops parent token spans when a full-text span receives a derived cell identity', () => {
    const source = [
      tableCell('label', 'Ferritin', 0.05, 0, 0),
      tableCell('single-token-value', '42', 0.4, 0, 1, {
        spans: [
          {
            id: 'single-token-value-span',
            parentObservationId: 'single-token-value',
            start: 0,
            end: 2,
            text: '42',
            boundingBox: { x: 0.4, y: 0.2, width: 0.08, height: 0.03 },
          },
        ],
      }),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));
    const candidate = buildGeometryCandidateWindows(lattice, source)[0];
    assert.ok(candidate);
    const value = candidate.observations.find((item) => item.text === '42');
    assert.ok(value);
    assert.equal(value.id, 'single-token-value:0:2');
    assert.equal(value.spans, undefined);
    assert.equal(value.sourceSpan?.parentObservationId, 'single-token-value');
    assert.doesNotThrow(() =>
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v4',
        pageIndex: 0,
        orientation: 0,
        observations: candidate.observations,
      }),
    );
  });

  it('enforces the hard maximum adjacency gap even when a caller requests a wider window', () => {
    const source = [
      observation('label', 'Ferritin', 0.05, 0.2),
      observation('value', '42', 0.45, 0.28),
    ];
    const lattice = reconstructGeometryLattice(geometryObservations(source));

    assert.deepEqual(
      buildGeometryCandidateWindows(lattice, source, {
        maxAdjacentRowGap: GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROW_GAP + 0.001,
      }),
      [],
    );
  });
});
