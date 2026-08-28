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
});
