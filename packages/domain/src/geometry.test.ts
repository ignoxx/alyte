import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateGeometryFieldCandidates,
  reconstructGeometryLattice,
  type GeometrySourceObservation,
} from './geometry.js';

function observation(
  id: string,
  text: string,
  x: number,
  y: number,
  overrides: Partial<GeometrySourceObservation> = {},
): GeometrySourceObservation {
  return {
    id,
    text,
    boundingBox: { x, y, width: 0.18, height: 0.035 },
    pageIndex: 0,
    ...overrides,
  };
}

function tableCell(
  id: string,
  text: string,
  x: number,
  rowIndex: number,
  columnIndex: number,
  tableId = 'table',
): GeometrySourceObservation {
  return observation(id, text, x, 0.2 + rowIndex * 0.1, {
    structure: { kind: 'table-cell', tableId, rowIndex, columnIndex },
  });
}

function allPermutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  const result: T[][] = [];
  values.forEach((value, index) => {
    const remainder = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const permutation of allPermutations(remainder)) result.push([value, ...permutation]);
  });
  return result;
}

function latticeSignature(lattice: ReturnType<typeof reconstructGeometryLattice>) {
  return lattice.rows.map((row) => ({
    sourceObservationIds: row.sourceObservationIds,
    parentIds: row.parentIds,
    cells: row.cells.map((cell) => [cell.id, cell.sourceObservationId, cell.text]),
  }));
}

describe('geometry-driven extraction primitives', () => {
  it('seeds valid table rows and columns while preserving exact source cells', () => {
    const lattice = reconstructGeometryLattice([
      tableCell('label', 'LDL-C', 0.08, 0, 0),
      tableCell('value', '3.8', 0.48, 0, 1),
      tableCell('unit', 'mmol/L', 0.68, 0, 2),
      tableCell('range', '1.2-3.4', 0.82, 0, 3),
      tableCell('next-label', 'HDL-C', 0.08, 1, 0),
      tableCell('next-value', '1.4', 0.48, 1, 1),
    ]);

    assert.equal(lattice.rows.length, 2);
    assert.equal(lattice.rows[0]?.seededByTableStructure, true);
    assert.deepEqual(
      lattice.rows[0]?.cells.map((cell) => [cell.id, cell.columnIndex, cell.text]),
      [
        ['label', 0, 'LDL-C'],
        ['value', 1, '3.8'],
        ['unit', 2, 'mmol/L'],
        ['range', 3, '1.2-3.4'],
      ],
    );
    assert.equal(lattice.rows[0]?.cells[0]?.sourceStart, 0);
    assert.equal(lattice.rows[0]?.cells[0]?.sourceEnd, 'LDL-C'.length);
  });

  it('clusters loose x/y cells into physical rows and does not cross hard contexts', () => {
    const context = { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' };
    const lattice = reconstructGeometryLattice([
      observation('label', 'LDL cholesterol', 0.07, 0.2, { context }),
      observation('value', '118', 0.47, 0.202, { context }),
      observation('unit', 'mg/dL', 0.64, 0.2, { context }),
      observation('range', '70-115', 0.79, 0.2, { context }),
      observation('other-page', '3.8', 0.47, 0.2, { pageIndex: 1, context }),
      observation('other-section', 'mmol/L', 0.64, 0.2, {
        context: { ...context, sectionId: 'chemistry' },
      }),
      observation('other-specimen', '1.2-3.4', 0.79, 0.2, {
        context: { ...context, specimenKey: 'plasma' },
      }),
      observation('other-date', 'H', 0.88, 0.2, {
        context: { ...context, collectionDateKey: '2026-08-21' },
      }),
    ]);

    assert.equal(lattice.rows.length, 5);
    assert.deepEqual(
      lattice.rows.find((row) => row.sourceObservationIds.includes('label'))?.sourceObservationIds,
      ['label', 'value', 'unit', 'range'],
    );
    assert.deepEqual(
      lattice.rows
        .filter((row) => !row.sourceObservationIds.includes('label'))
        .map((row) => row.sourceObservationIds)
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
      [['other-date'], ['other-page'], ['other-section'], ['other-specimen']],
    );
  });

  it('does not merge adjacent cells across table sections, specimens, or dates', () => {
    const base = {
      tableId: 'report-table',
      sectionId: 'lipids',
      specimenKey: 'serum',
      collectionDateKey: '2026-08-20',
    };
    const lattice = reconstructGeometryLattice([
      observation('section-a-label', 'LDL-C', 0.08, 0.2, { context: base }),
      observation('section-a-value', '3.8', 0.5, 0.2, { context: base }),
      observation('section-b-unit', 'mmol/L', 0.68, 0.2, {
        context: { ...base, sectionId: 'chemistry' },
      }),
      observation('other-specimen', '1.4', 0.5, 0.2, {
        context: { ...base, specimenKey: 'plasma' },
      }),
      observation('other-date', 'H', 0.68, 0.2, {
        context: { ...base, collectionDateKey: '2026-08-21' },
      }),
    ]);
    assert.equal(lattice.rows.length, 4);
    assert.deepEqual(
      lattice.rows.find((row) => row.sourceObservationIds.includes('section-a-label'))
        ?.sourceObservationIds,
      ['section-a-label', 'section-a-value'],
    );
  });

  it('keeps adjacent loose rows separate when a tall candidate overlaps both y bands', () => {
    const observations = [
      observation('first-label', 'LDL-C', 0.08, 0.2, {
        boundingBox: { x: 0.08, y: 0.2, width: 0.18, height: 0.035 },
      }),
      observation('first-value', '3.8', 0.35, 0.2, {
        boundingBox: { x: 0.35, y: 0.2, width: 0.18, height: 0.035 },
      }),
      observation('second-label', 'HDL-C', 0.08, 0.3, {
        boundingBox: { x: 0.08, y: 0.3, width: 0.18, height: 0.035 },
      }),
      observation('second-value', '1.4', 0.35, 0.3, {
        boundingBox: { x: 0.35, y: 0.3, width: 0.18, height: 0.035 },
      }),
      observation('tall-bridge', 'mmol/L', 0.55, 0.205, {
        boundingBox: { x: 0.55, y: 0.205, width: 0.35, height: 0.14 },
      }),
    ];

    const baseline = reconstructGeometryLattice(observations);
    assert.equal(baseline.rows.length, 2);
    assert.deepEqual(
      baseline.rows.map((row) => row.sourceObservationIds),
      [
        ['first-label', 'first-value', 'tall-bridge'],
        ['second-label', 'second-value'],
      ],
    );
    assert.equal(
      baseline.rows.some((row) => row.sourceObservationIds.includes('tall-bridge')),
      true,
    );
    assert.equal(
      baseline.rows
        .find((row) => row.sourceObservationIds.includes('second-label'))
        ?.sourceObservationIds.includes('tall-bridge'),
      false,
    );

    for (const permutation of allPermutations(observations))
      assert.deepEqual(
        latticeSignature(reconstructGeometryLattice(permutation)),
        latticeSignature(baseline),
      );
  });

  it('anchors a tall leading cell to the first adjacent physical band', () => {
    const lattice = reconstructGeometryLattice([
      observation('first-label', 'Novel A', 0.08, 0.2),
      observation('first-value', '3.8', 0.35, 0.2),
      observation('second-label', 'Novel B', 0.08, 0.3),
      observation('second-value', '1.4', 0.35, 0.3),
      observation('leading-tall', 'mmol/L', 0.55, 0.18, {
        boundingBox: { x: 0.55, y: 0.18, width: 0.35, height: 0.14 },
      }),
    ]);

    assert.equal(lattice.rows.length, 2);
    assert.deepEqual(
      lattice.rows.map((row) => row.sourceObservationIds),
      [
        ['first-label', 'first-value', 'leading-tall'],
        ['second-label', 'second-value'],
      ],
    );
  });

  it('counts final physical cells rather than a parent-local y-band index', () => {
    const text = 'Novel biomarker\n3.8 mmol/L';
    const lattice = reconstructGeometryLattice([
      observation('wrapped-row', text, 0.08, 0.2, {
        parentId: 'wrapped-row',
        boundingBox: { x: 0.08, y: 0.2, width: 0.7, height: 0.1 },
        spans: [
          {
            parentObservationId: 'wrapped-row',
            start: 0,
            end: 15,
            text: 'Novel biomarker',
            boundingBox: { x: 0.08, y: 0.2, width: 0.22, height: 0.035 },
          },
          {
            parentObservationId: 'wrapped-row',
            start: 16,
            end: 19,
            text: '3.8',
            boundingBox: { x: 0.08, y: 0.265, width: 0.1, height: 0.035 },
          },
          {
            parentObservationId: 'wrapped-row',
            start: 20,
            end: 26,
            text: 'mmol/L',
            boundingBox: { x: 0.22, y: 0.265, width: 0.18, height: 0.035 },
          },
        ],
      }),
    ]);

    assert.equal(lattice.rows.length, 2);
    assert.deepEqual(
      lattice.rows.map((row) => [row.cells.map((cell) => cell.text), row.yBandCount]),
      [
        [['Novel biomarker'], 1],
        [['3.8', 'mmol/L'], 1],
      ],
    );
  });

  it('counts a final row once when its cells have different parent-local band indices', () => {
    const lattice = reconstructGeometryLattice([
      observation('wrapped-label', 'header\nNovel A', 0.08, 0.1, {
        boundingBox: { x: 0.08, y: 0.1, width: 0.18, height: 0.14 },
        spans: [
          {
            parentObservationId: 'wrapped-label',
            start: 0,
            end: 6,
            text: 'header',
            boundingBox: { x: 0.08, y: 0.1, width: 0.18, height: 0.035 },
          },
          {
            parentObservationId: 'wrapped-label',
            start: 7,
            end: 14,
            text: 'Novel A',
            boundingBox: { x: 0.08, y: 0.2, width: 0.18, height: 0.035 },
          },
        ],
      }),
      observation('wrapped-value', 'header\n3.8', 0.42, 0.1, {
        boundingBox: { x: 0.42, y: 0.1, width: 0.18, height: 0.14 },
        spans: [
          {
            parentObservationId: 'wrapped-value',
            start: 0,
            end: 6,
            text: 'header',
            boundingBox: { x: 0.42, y: 0.1, width: 0.18, height: 0.035 },
          },
          {
            parentObservationId: 'wrapped-value',
            start: 7,
            end: 10,
            text: '3.8',
            boundingBox: { x: 0.42, y: 0.2, width: 0.18, height: 0.035 },
          },
        ],
      }),
    ]);

    assert.equal(lattice.rows.length, 2);
    assert.deepEqual(
      lattice.rows.map((row) => row.yBandCount),
      [1, 1],
    );
    assert.deepEqual(
      lattice.rows[1]?.cells.map((cell) => cell.text),
      ['Novel A', '3.8'],
    );
  });

  it('allows a short same-row bridge to join fragmented loose cells deterministically', () => {
    const observations = [
      observation('left-cell', 'LDL-C', 0.08, 0.2, {
        boundingBox: { x: 0.08, y: 0.2, width: 0.15, height: 0.035 },
      }),
      observation('bridge-cell', '3.8', 0.3, 0.2, {
        boundingBox: { x: 0.3, y: 0.2, width: 0.4, height: 0.035 },
      }),
      observation('right-cell', 'mmol/L', 0.76, 0.2, {
        boundingBox: { x: 0.76, y: 0.2, width: 0.15, height: 0.035 },
      }),
    ];

    const baseline = reconstructGeometryLattice(observations);
    assert.equal(baseline.rows.length, 1);
    assert.deepEqual(baseline.rows[0]?.sourceObservationIds, [
      'left-cell',
      'bridge-cell',
      'right-cell',
    ]);
    assert.deepEqual(
      baseline.rows[0]?.cells.map((cell) => cell.text),
      ['LDL-C', '3.8', 'mmol/L'],
    );

    for (const permutation of allPermutations(observations))
      assert.deepEqual(
        latticeSignature(reconstructGeometryLattice(permutation)),
        latticeSignature(baseline),
      );
  });

  it('splits a parent into at most two clear y-bands using deterministic derived IDs', () => {
    const text = 'LDL-C\n3,8 mmol/L';
    const lattice = reconstructGeometryLattice([
      observation('wrapped', text, 0.08, 0.2, {
        parentId: 'wrapped',
        boundingBox: { x: 0.08, y: 0.2, width: 0.7, height: 0.1 },
        spans: [
          {
            id: 'span-label',
            parentObservationId: 'wrapped',
            start: 0,
            end: 5,
            text: 'LDL-C',
            boundingBox: { x: 0.08, y: 0.2, width: 0.18, height: 0.035 },
          },
          {
            id: 'span-value',
            parentObservationId: 'wrapped',
            start: 6,
            end: 9,
            text: '3,8',
            boundingBox: { x: 0.08, y: 0.265, width: 0.12, height: 0.035 },
          },
          {
            id: 'span-unit',
            parentObservationId: 'wrapped',
            start: 10,
            end: 16,
            text: 'mmol/L',
            boundingBox: { x: 0.23, y: 0.265, width: 0.18, height: 0.035 },
          },
        ],
      }),
    ]);

    assert.equal(lattice.rows.length, 2);
    assert.deepEqual(
      lattice.rows[0]?.cells.map((cell) => cell.id),
      ['wrapped:0:5'],
    );
    assert.deepEqual(
      lattice.rows[1]?.cells.map((cell) => cell.id),
      ['wrapped:6:9', 'wrapped:10:16'],
    );
    for (const row of lattice.rows) {
      for (const cell of row.cells)
        assert.equal(cell.text, text.slice(cell.sourceStart, cell.sourceEnd));
    }
  });

  it('independently bands trusted PDF spans while preserving exact cell provenance', () => {
    const trustedSpans = [
      {
        id: 'trusted-label-span',
        parentObservationId: 'trusted-parent',
        start: 0,
        end: 5,
        text: 'LDL-C',
        boundingBox: { x: 0.1, y: 0.2, width: 0.08, height: 0.035 },
      },
      {
        id: 'trusted-value-span',
        parentObservationId: 'trusted-parent',
        start: 6,
        end: 9,
        text: '3.8',
        boundingBox: { x: 0.2, y: 0.3, width: 0.08, height: 0.035 },
      },
      {
        id: 'trusted-unit-span',
        parentObservationId: 'trusted-parent',
        start: 10,
        end: 16,
        text: 'mmol/L',
        boundingBox: { x: 0.3, y: 0.22, width: 0.08, height: 0.1 },
      },
    ] as const;
    const parent = observation('trusted-parent', 'LDL-C 3.8 mmol/L', 0.1, 0.2, {
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      spans: trustedSpans,
    });

    const ordinary = reconstructGeometryLattice([parent]);
    assert.equal(ordinary.rows[0]?.status, 'unresolved');
    assert.equal(ordinary.rows[0]?.unresolvedReason, 'contradictory-y-bands');

    const trusted = reconstructGeometryLattice([
      { ...parent, spanPolicy: 'trusted-independent' as const },
    ]);
    assert.equal(trusted.unresolvedParents.length, 0);
    assert.equal(trusted.rows.length, 3);
    assert.deepEqual(
      trusted.rows
        .flatMap((row) => row.cells)
        .sort((left, right) => left.sourceStart - right.sourceStart)
        .map((cell) => ({
          id: cell.id,
          parentId: cell.parentId,
          sourceObservationId: cell.sourceObservationId,
          text: cell.text,
          sourceStart: cell.sourceStart,
          sourceEnd: cell.sourceEnd,
        })),
      [
        {
          id: 'trusted-parent:0:5',
          parentId: 'trusted-parent',
          sourceObservationId: 'trusted-parent',
          text: 'LDL-C',
          sourceStart: 0,
          sourceEnd: 5,
        },
        {
          id: 'trusted-parent:6:9',
          parentId: 'trusted-parent',
          sourceObservationId: 'trusted-parent',
          text: '3.8',
          sourceStart: 6,
          sourceEnd: 9,
        },
        {
          id: 'trusted-parent:10:16',
          parentId: 'trusted-parent',
          sourceObservationId: 'trusted-parent',
          text: 'mmol/L',
          sourceStart: 10,
          sourceEnd: 16,
        },
      ],
    );
  });

  it('joins strongly aligned trusted PDF cells across a wide table-column gap only', () => {
    const source = [
      observation('wide-label', 'Ferritin', 0.05, 0.2, {
        boundingBox: { x: 0.05, y: 0.2, width: 0.12, height: 0.03 },
      }),
      observation('wide-value', '42', 0.85, 0.2, {
        boundingBox: { x: 0.85, y: 0.2, width: 0.08, height: 0.03 },
      }),
    ];

    assert.equal(reconstructGeometryLattice(source).rows.length, 2);
    const trusted = reconstructGeometryLattice(
      source.map((item) => ({ ...item, spanPolicy: 'trusted-independent' as const })),
    );
    assert.equal(trusted.rows.length, 1);
    assert.deepEqual(
      trusted.rows[0]?.cells.map((cell) => cell.text),
      ['Ferritin', '42'],
    );
  });

  it('allows bounded PDF glyph-box baseline offsets without joining the next visual row', () => {
    const trusted = reconstructGeometryLattice([
      observation('offset-label', 'Ferritin', 0.05, 0.2, {
        boundingBox: { x: 0.05, y: 0.2, width: 0.12, height: 0.02 },
        spanPolicy: 'trusted-independent',
      }),
      observation('offset-value', '42', 0.85, 0.224, {
        boundingBox: { x: 0.85, y: 0.224, width: 0.08, height: 0.02 },
        spanPolicy: 'trusted-independent',
      }),
      observation('next-label', 'Albumin', 0.05, 0.27, {
        boundingBox: { x: 0.05, y: 0.27, width: 0.12, height: 0.02 },
        spanPolicy: 'trusted-independent',
      }),
      observation('next-value', '44', 0.85, 0.294, {
        boundingBox: { x: 0.85, y: 0.294, width: 0.08, height: 0.02 },
        spanPolicy: 'trusted-independent',
      }),
    ]);

    assert.equal(trusted.rows.length, 2);
    assert.deepEqual(
      trusted.rows.map((row) => row.cells.map((cell) => cell.text)),
      [
        ['Ferritin', '42'],
        ['Albumin', '44'],
      ],
    );
  });

  it('keeps adjacent trusted PDF source lines separate inside the historical baseline tolerance', () => {
    const trusted = reconstructGeometryLattice([
      observation('first-pdf-line', 'Novel alpha 4.2', 0.05, 0.2, {
        boundingBox: { x: 0.05, y: 0.2, width: 0.88, height: 0.025 },
        spans: [
          {
            parentObservationId: 'first-pdf-line',
            start: 0,
            end: 11,
            text: 'Novel alpha',
            boundingBox: { x: 0.05, y: 0.2, width: 0.2, height: 0.025 },
          },
          {
            parentObservationId: 'first-pdf-line',
            start: 12,
            end: 15,
            text: '4.2',
            boundingBox: { x: 0.85, y: 0.2, width: 0.08, height: 0.025 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
      observation('second-pdf-line', 'Novel beta 8.1', 0.05, 0.233, {
        boundingBox: { x: 0.05, y: 0.233, width: 0.88, height: 0.025 },
        spans: [
          {
            parentObservationId: 'second-pdf-line',
            start: 0,
            end: 10,
            text: 'Novel beta',
            boundingBox: { x: 0.05, y: 0.233, width: 0.2, height: 0.025 },
          },
          {
            parentObservationId: 'second-pdf-line',
            start: 11,
            end: 14,
            text: '8.1',
            boundingBox: { x: 0.85, y: 0.233, width: 0.08, height: 0.025 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
    ]);

    assert.equal(trusted.rows.length, 2);
    assert.deepEqual(
      trusted.rows.map((row) => row.cells.map((cell) => cell.text)),
      [
        ['Novel alpha', '4.2'],
        ['Novel beta', '8.1'],
      ],
    );
  });

  it('joins wide trusted PDF cells from the same span-bearing source line', () => {
    const trusted = reconstructGeometryLattice([
      observation('one-pdf-line', 'Novel alpha 4.2', 0.05, 0.2, {
        boundingBox: { x: 0.05, y: 0.2, width: 0.88, height: 0.025 },
        spans: [
          {
            parentObservationId: 'one-pdf-line',
            start: 0,
            end: 11,
            text: 'Novel alpha',
            boundingBox: { x: 0.05, y: 0.2, width: 0.2, height: 0.025 },
          },
          {
            parentObservationId: 'one-pdf-line',
            start: 12,
            end: 15,
            text: '4.2',
            boundingBox: { x: 0.85, y: 0.224, width: 0.08, height: 0.025 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
    ]);

    assert.equal(trusted.rows.length, 1);
    assert.deepEqual(
      trusted.rows[0]?.cells.map((cell) => cell.text),
      ['Novel alpha', '4.2'],
    );
  });

  it('keeps dense trusted independent spans in distinct physical rows and candidate windows', () => {
    const trustedObservations: GeometrySourceObservation[] = [
      observation('dense-row-one', 'LDL-C 3.8', 0.08, 0.2, {
        spans: [
          {
            parentObservationId: 'dense-row-one',
            start: 0,
            end: 5,
            text: 'LDL-C',
            boundingBox: { x: 0.08, y: 0.2, width: 0.18, height: 0.035 },
          },
          {
            parentObservationId: 'dense-row-one',
            start: 6,
            end: 9,
            text: '3.8',
            boundingBox: { x: 0.35, y: 0.2, width: 0.12, height: 0.035 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
      observation('dense-row-two', 'HDL-C 1.4', 0.08, 0.3, {
        spans: [
          {
            parentObservationId: 'dense-row-two',
            start: 0,
            end: 5,
            text: 'HDL-C',
            boundingBox: { x: 0.08, y: 0.3, width: 0.18, height: 0.035 },
          },
          {
            parentObservationId: 'dense-row-two',
            start: 6,
            end: 9,
            text: '1.4',
            boundingBox: { x: 0.35, y: 0.3, width: 0.12, height: 0.035 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
      observation('dense-tall', 'mmol/L', 0.55, 0.205, {
        boundingBox: { x: 0.55, y: 0.205, width: 0.35, height: 0.14 },
        spans: [
          {
            parentObservationId: 'dense-tall',
            start: 0,
            end: 6,
            text: 'mmol/L',
            boundingBox: { x: 0.55, y: 0.205, width: 0.35, height: 0.14 },
          },
        ],
        spanPolicy: 'trusted-independent',
      }),
    ];

    const trusted = reconstructGeometryLattice(trustedObservations);
    assert.equal(trusted.unresolvedParents.length, 0);
    assert.equal(trusted.rows.length, 2);
    assert.deepEqual(
      trusted.rows.map((row) => row.cells.map((cell) => cell.id)),
      [
        ['dense-row-one:0:5', 'dense-row-one:6:9', 'dense-tall:0:6'],
        ['dense-row-two:0:5', 'dense-row-two:6:9'],
      ],
    );
    assert.deepEqual(
      trusted.rows.map((row) => row.cells.map((cell) => cell.text)),
      [
        ['LDL-C', '3.8', 'mmol/L'],
        ['HDL-C', '1.4'],
      ],
    );
    const candidateWindows = trusted.rows.map(enumerateGeometryFieldCandidates);
    assert.deepEqual(
      candidateWindows.map((window) => window.sourceCellIds),
      [
        ['dense-row-one:0:5', 'dense-row-one:6:9', 'dense-tall:0:6'],
        ['dense-row-two:0:5', 'dense-row-two:6:9'],
      ],
    );
    assert.deepEqual(
      candidateWindows.map((window) =>
        window.roles.value.candidates.map((candidate) => candidate.cellId),
      ),
      [['dense-row-one:6:9'], ['dense-row-two:6:9']],
    );
    for (const row of trusted.rows) {
      for (const cell of row.cells) {
        const parent = trustedObservations.find(
          (observation) => observation.id === cell.sourceObservationId,
        )!;
        assert.equal(cell.parentId, parent.id);
        assert.equal(cell.text, parent.text.slice(cell.sourceStart, cell.sourceEnd));
      }
    }

    const contradictoryVision = reconstructGeometryLattice([
      observation('dense-vision-contradiction', 'A B C', 0.08, 0.2, {
        spans: [
          {
            parentObservationId: 'dense-vision-contradiction',
            start: 0,
            end: 1,
            boundingBox: { x: 0.08, y: 0.2, width: 0.08, height: 0.035 },
          },
          {
            parentObservationId: 'dense-vision-contradiction',
            start: 2,
            end: 3,
            boundingBox: { x: 0.08, y: 0.3, width: 0.08, height: 0.035 },
          },
          {
            parentObservationId: 'dense-vision-contradiction',
            start: 4,
            end: 5,
            boundingBox: { x: 0.2, y: 0.205, width: 0.35, height: 0.14 },
          },
        ],
      }),
    ]);
    assert.equal(contradictoryVision.rows[0]?.status, 'unresolved');
    assert.equal(contradictoryVision.rows[0]?.unresolvedReason, 'contradictory-y-bands');
  });

  it('keeps contradictory, overlapping, and over-two y-bands unresolved', () => {
    const text = 'A B C';
    const lattice = reconstructGeometryLattice([
      observation('bad-parent', text, 0.08, 0.2, {
        parentId: 'bad-parent',
        boundingBox: { x: 0.08, y: 0.2, width: 0.5, height: 0.2 },
        spans: [
          {
            id: 'span-a',
            parentObservationId: 'bad-parent',
            start: 0,
            end: 1,
            boundingBox: { x: 0.08, y: 0.2, width: 0.08, height: 0.035 },
          },
          {
            id: 'span-b',
            parentObservationId: 'bad-parent',
            start: 2,
            end: 3,
            boundingBox: { x: 0.08, y: 0.275, width: 0.08, height: 0.035 },
          },
          {
            id: 'span-c',
            parentObservationId: 'bad-parent',
            start: 4,
            end: 5,
            boundingBox: { x: 0.08, y: 0.235, width: 0.08, height: 0.1 },
          },
        ],
      }),
    ]);

    assert.equal(lattice.rows.length, 1);
    assert.equal(lattice.rows[0]?.status, 'unresolved');
    assert.equal(lattice.rows[0]?.unresolvedReason, 'contradictory-y-bands');
    assert.deepEqual(lattice.rows[0]?.cells, []);
    assert.deepEqual(lattice.unresolvedParents[0]?.sourceObservationIds, ['bad-parent']);
  });

  it('fails closed for more than two separated bands and invalid UTF-16 spans', () => {
    const lattice = reconstructGeometryLattice([
      observation('three-band-parent', 'A B C', 0.08, 0.2, {
        spans: [
          {
            id: 'span-a',
            parentObservationId: 'three-band-parent',
            start: 0,
            end: 1,
            boundingBox: { x: 0.08, y: 0.2, width: 0.08, height: 0.03 },
          },
          {
            id: 'span-b',
            parentObservationId: 'three-band-parent',
            start: 2,
            end: 3,
            boundingBox: { x: 0.08, y: 0.3, width: 0.08, height: 0.03 },
          },
          {
            id: 'span-c',
            parentObservationId: 'three-band-parent',
            start: 4,
            end: 5,
            boundingBox: { x: 0.08, y: 0.4, width: 0.08, height: 0.03 },
          },
        ],
      }),
      observation('invalid-span-parent', 'A B', 0.08, 0.2, {
        spans: [
          { id: 'span-invalid', parentObservationId: 'invalid-span-parent', start: 0, end: 99 },
        ],
      }),
    ]);

    assert.deepEqual(
      lattice.unresolvedParents.map((parent) => [parent.parentId, parent.reason]),
      [
        ['three-band-parent', 'too-many-y-bands'],
        ['invalid-span-parent', 'invalid-token-span'],
      ],
    );
    assert.ok(lattice.rows.every((row) => row.status === 'unresolved'));
  });

  it('enumerates exact role candidates and leaves ambiguous label sets for the model', () => {
    const lattice = reconstructGeometryLattice([
      observation('label-a', 'LDL-C', 0.07, 0.2),
      observation('label-b', 'Low-density cholesterol', 0.07, 0.2),
      observation('value', '3,8', 0.47, 0.2),
      observation('unit', 'mmol/L', 0.64, 0.2),
      observation('reference', '1,2-3,4', 0.79, 0.2),
      observation('flag', 'H', 0.91, 0.2, {
        boundingBox: { x: 0.91, y: 0.2, width: 0.04, height: 0.035 },
      }),
    ]);
    const row = lattice.rows[0]!;
    const candidates = enumerateGeometryFieldCandidates(row);

    assert.equal(candidates.roles.label.resolution, 'ambiguous');
    assert.equal(candidates.roles.label.selectedCellId, null);
    assert.equal(candidates.roles.value.selectedCellId, 'value');
    assert.equal(candidates.roles.unit.selectedCellId, 'unit');
    assert.equal(candidates.roles.reference.selectedCellId, 'reference');
    assert.equal(candidates.roles.flag.selectedCellId, 'flag');
    assert.equal(candidates.requiresReview, true);
    for (const role of Object.values(candidates.roles)) {
      for (const candidate of role.candidates) {
        const cell = row.cells.find((item) => item.id === candidate.cellId)!;
        assert.equal(candidate.text, cell.text);
      }
    }
  });

  it('classifies extended English and German qualitative cells as values at every geometry seam', () => {
    for (const [suffix, value] of [
      ['english', 'resistant'],
      ['german', 'empfindlich'],
    ] as const) {
      const lattice = reconstructGeometryLattice([
        observation(`label-${suffix}`, 'Culture response', 0.07, 0.2),
        observation(`value-${suffix}`, value, 0.47, 0.2),
      ]);
      const candidates = enumerateGeometryFieldCandidates(lattice.rows[0]!);

      assert.equal(candidates.roles.value.selectedCellId, `value-${suffix}`);
      assert.deepEqual(
        candidates.roles.label.candidates.map((candidate) => candidate.cellId),
        [`label-${suffix}`],
      );
    }
  });
});
