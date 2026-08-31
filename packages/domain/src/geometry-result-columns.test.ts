import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructGeometryLattice, type GeometrySourceObservation } from './geometry.js';
import {
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
} from './geometry-candidate-windows.js';
import { admitGeometryCandidateGroupsByResultColumn } from './geometry-result-columns.js';

type SourceOptions = {
  readonly pageIndex?: number;
  readonly tableId?: string | null;
  readonly sectionId?: string;
  readonly columnIndex?: number | null;
};

function source(
  id: string,
  text: string,
  x: number,
  y: number,
  options: SourceOptions = {},
): GeometrySourceObservation {
  const pageIndex = options.pageIndex ?? 0;
  const tableId = options.tableId ?? null;
  return {
    id,
    text,
    boundingBox: { x, y, width: 0.08, height: 0.025 },
    pageIndex,
    structure: {
      kind: tableId === null ? 'text' : 'table-cell',
      tableId,
      rowIndex: tableId === null ? null : Math.round(y * 1_000),
      columnIndex: options.columnIndex ?? null,
    },
    context: {
      tableId,
      sectionId: options.sectionId ?? `page:${pageIndex}:loose`,
      specimenKey: 'serum',
      collectionDateKey: '2026-08-30',
    },
  };
}

function groupsFor(observations: readonly GeometrySourceObservation[]) {
  const lattice = reconstructGeometryLattice(observations);
  const candidates = observations.map((observation) => ({
    id: observation.id,
    text: observation.text,
    alternatives: [],
    boundingBox: observation.boundingBox,
    pageIndex: observation.pageIndex,
    orientation: 0,
    ...(observation.structure === undefined ? {} : { structure: observation.structure }),
    recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
  }));
  return {
    lattice,
    groups: groupGeometryCandidateWindows(buildGeometryCandidateWindows(lattice, candidates)),
  };
}

describe('geometry result-column admission', () => {
  it('keeps exactly one anchor in the local Result-header column', () => {
    const input = [
      source('header-label', 'Test', 0.08, 0.1),
      source('header-result', 'Result', 0.48, 0.1),
      source('header-range', 'Reference', 0.7, 0.1),
      source('a-label', 'Novel alpha', 0.08, 0.16),
      source('a-result', '4.2', 0.48, 0.16),
      source('a-range-low', '3.1', 0.7, 0.16),
      source('a-range-high', '5.4', 0.79, 0.16),
      source('b-label', 'Novel beta', 0.08, 0.22),
      source('b-result', '8.1', 0.48, 0.22),
      source('b-range-low', '5.0', 0.7, 0.22),
      source('b-range-high', '9.0', 0.79, 0.22),
    ];
    const { lattice, groups } = groupsFor(input);
    assert.equal(groups.length, 2);
    assert.ok(groups.every((group) => group.variants.length === 3));

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups);

    assert.equal(result.reviewGroups.length, 0);
    assert.equal(result.excludedGroups.length, 0);
    assert.equal(result.groups.length, 2);
    assert.deepEqual(
      result.groups.map((group) => group.anchorCellIds),
      [['a-result'], ['b-result']],
    );
    assert.ok(result.groups.every((group) => group.sourceCells.length >= 4));
  });

  it('scopes repeated loose headers independently and is stable under reversed input', () => {
    const input = [
      source('first-header', 'Result', 0.4, 0.1),
      source('first-a-label', 'Novel alpha', 0.05, 0.15),
      source('first-a-result', '1.1', 0.4, 0.15),
      source('first-a-other', '9.1', 0.75, 0.15),
      source('first-b-label', 'Novel beta', 0.05, 0.2),
      source('first-b-result', '2.2', 0.4, 0.2),
      source('first-b-other', '9.2', 0.75, 0.2),
      source('second-header', 'Result', 0.62, 0.26),
      source('second-a-label', 'Novel gamma', 0.05, 0.31),
      source('second-a-other', '8.1', 0.4, 0.31),
      source('second-a-result', '3.3', 0.62, 0.31),
      source('second-b-label', 'Novel delta', 0.05, 0.36),
      source('second-b-other', '8.2', 0.4, 0.36),
      source('second-b-result', '4.4', 0.62, 0.36),
    ];
    const forward = groupsFor(input);
    const reversed = groupsFor([...input].reverse());

    const admitted = admitGeometryCandidateGroupsByResultColumn(forward.lattice, forward.groups);
    const admittedReversed = admitGeometryCandidateGroupsByResultColumn(
      reversed.lattice,
      reversed.groups,
    );

    const anchors = admitted.groups.map((group) => group.anchorCellIds[0]);
    assert.deepEqual(anchors, [
      'first-a-result',
      'first-b-result',
      'second-a-result',
      'second-b-result',
    ]);
    assert.deepEqual(
      admittedReversed.groups.map((group) => group.anchorCellIds[0]),
      anchors,
    );
  });

  it('fails open after a large loose-layout gap or when only one group supports a header', () => {
    const input = [
      source('header', 'Result', 0.48, 0.1),
      source('near-label', 'Novel alpha', 0.08, 0.15),
      source('near-result', '4.2', 0.48, 0.15),
      source('near-other', '5.2', 0.75, 0.15),
      source('far-label', 'Novel beta', 0.08, 0.4),
      source('far-result', '8.1', 0.48, 0.4),
      source('far-other', '9.1', 0.75, 0.4),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups);

    assert.equal(result.reviewGroups.length, 0);
    assert.equal(result.excludedGroups.length, 0);
    assert.ok(result.groups.every((group) => group.variants.length === 2));
  });

  it('lets trusted page-wide scope reuse one supported Result column across vertical gaps', () => {
    const input = [
      source('header', 'Result', 0.48, 0.1),
      source('near-label', 'Novel alpha', 0.08, 0.15),
      source('near-result', '4.2', 0.48, 0.15),
      source('near-other', '5.2', 0.75, 0.15),
      source('far-label', 'Novel beta', 0.08, 0.4),
      source('far-result', '8.1', 0.48, 0.4),
      source('far-other', '9.1', 0.75, 0.4),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups, {
      scope: 'page-wide',
    });

    assert.equal(result.reviewGroups.length, 0);
    assert.equal(result.excludedGroups.length, 0);
    assert.deepEqual(
      result.groups.map((group) => group.anchorCellIds),
      [['near-result'], ['far-result']],
    );
  });

  it('keeps multiple supported Result centers but reviews a row that matches both', () => {
    const input = [
      source('left-header', 'Result', 0.25, 0.1),
      source('right-header', 'Result', 0.52, 0.1),
      source('a-label', 'Novel alpha', 0.04, 0.16),
      source('a-left', '4.2', 0.25, 0.16),
      source('a-right', '5.2', 0.52, 0.16),
      source('b-label', 'Novel beta', 0.04, 0.22),
      source('b-left', '8.1', 0.25, 0.22),
      source('b-right', '9.1', 0.52, 0.22),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups, {
      scope: 'page-wide',
    });

    assert.equal(result.groups.length, 0);
    assert.equal(result.reviewGroups.length, groups.length);
    assert.equal(result.excludedGroups.length, 0);
    assert.equal(result.unrepresentedRows.length, 0);
    const originalById = new Map(groups.map((group) => [group.physicalRowId, group]));
    for (const group of result.reviewGroups)
      assert.deepEqual(group, originalById.get(group.physicalRowId));
  });

  it('keeps a Result-column row reviewable when no safe label candidate represents it', () => {
    const input = [
      source('header', 'Result', 0.48, 0.1),
      source('known-a-label', 'Novel alpha', 0.08, 0.15),
      source('known-a-result', '4.2', 0.48, 0.15),
      source('known-b-label', 'Novel beta', 0.08, 0.2),
      source('known-b-result', '8.1', 0.48, 0.2),
      source('missing-label-metadata', 'Patient', 0.08, 0.25),
      source('missing-label-result', '3.3', 0.48, 0.25),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups, {
      scope: 'page-wide',
    });

    assert.equal(result.groups.length, 2);
    assert.equal(result.unrepresentedRows.length, 1);
    assert.deepEqual(result.unrepresentedRows[0]?.anchorCellIds, ['missing-label-result']);
    assert.ok(
      result.unrepresentedRows[0]?.physicalRow.cells.some(
        (cell) => cell.id === 'missing-label-result',
      ),
    );
  });

  it('fails open on contradictory headers and preserves unknown labels', () => {
    const table = { tableId: 'results', sectionId: 'table:results' } as const;
    const input = [
      source('header-a', 'Result', 0.42, 0.1, { ...table, columnIndex: 1 }),
      source('header-b', 'Results', 0.64, 0.1, { ...table, columnIndex: 2 }),
      source('a-label', 'Never seen alpha', 0.08, 0.16, { ...table, columnIndex: 0 }),
      source('a-result', '4.2', 0.42, 0.16, { ...table, columnIndex: 1 }),
      source('a-other', '5.2', 0.64, 0.16, { ...table, columnIndex: 2 }),
      source('b-label', 'Never seen beta', 0.08, 0.22, { ...table, columnIndex: 0 }),
      source('b-result', '8.1', 0.42, 0.22, { ...table, columnIndex: 1 }),
      source('b-other', '9.1', 0.64, 0.22, { ...table, columnIndex: 2 }),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups);

    assert.equal(result.reviewGroups.length, 0);
    assert.equal(result.excludedGroups.length, 0);
    assert.ok(result.groups.every((group) => group.variants.length === 2));
    assert.ok(
      result.groups.every((group) =>
        group.sourceCells.some((cell) => cell.text.startsWith('Never seen')),
      ),
    );
  });

  it('keeps the complete original group in review for zero or multiple header matches', () => {
    const input = [
      source('header', 'Result', 0.48, 0.1),
      source('good-a-label', 'Novel alpha', 0.08, 0.15),
      source('good-a-result', '4.2', 0.48, 0.15),
      source('good-b-label', 'Novel beta', 0.08, 0.2),
      source('good-b-result', '8.1', 0.48, 0.2),
      source('zero-label', 'Novel gamma', 0.08, 0.25),
      source('zero-value', '3.3', 0.72, 0.25),
      source('multi-label', 'Novel delta', 0.08, 0.3),
      source('multi-value-a', '6.1', 0.46, 0.3),
      source('multi-value-b', '6.2', 0.5, 0.3),
    ];
    const { lattice, groups } = groupsFor(input);
    const originalById = new Map(groups.map((group) => [group.physicalRowId, group]));

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups);

    assert.equal(result.groups.length, 2);
    assert.equal(result.reviewGroups.length, 1);
    assert.equal(result.excludedGroups.length, 1);
    for (const reviewGroup of result.reviewGroups) {
      assert.deepEqual(reviewGroup, originalById.get(reviewGroup.physicalRowId));
    }
    for (const excludedGroup of result.excludedGroups) {
      assert.deepEqual(excludedGroup, originalById.get(excludedGroup.physicalRowId));
    }
  });

  it('uses the native table column index when geometry centers vary', () => {
    const table = { tableId: 'results', sectionId: 'table:results' } as const;
    const input = [
      source('header-result', 'Result', 0.45, 0.1, { ...table, columnIndex: 1 }),
      source('a-label', 'Novel alpha', 0.08, 0.16, { ...table, columnIndex: 0 }),
      source('a-result', '4.2', 0.55, 0.16, { ...table, columnIndex: 1 }),
      source('a-other', '5.2', 0.7, 0.16, { ...table, columnIndex: 2 }),
      source('b-label', 'Novel beta', 0.08, 0.22, { ...table, columnIndex: 0 }),
      source('b-result', '8.1', 0.58, 0.22, { ...table, columnIndex: 1 }),
      source('b-other', '9.1', 0.72, 0.22, { ...table, columnIndex: 2 }),
    ];
    const { lattice, groups } = groupsFor(input);

    const result = admitGeometryCandidateGroupsByResultColumn(lattice, groups);

    assert.equal(result.reviewGroups.length, 0);
    assert.equal(result.excludedGroups.length, 0);
    assert.deepEqual(
      result.groups.map((group) => group.anchorCellIds),
      [['a-result'], ['b-result']],
    );
  });
});
