/**
 * Small, de-identified OCR geometry matrix for issue #113.
 *
 * The strings are synthetic and intentionally boring. They exercise source-cell identity,
 * wrapped parents, locale-shaped decimals, ambiguity fallbacks, and hard layout boundaries.
 */

export type GeometryFixtureObservation = {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pageIndex: number;
  readonly structure?: {
    readonly kind: 'table-cell' | 'text';
    readonly tableId: string | null;
    readonly rowIndex: number | null;
    readonly columnIndex: number | null;
  };
  readonly context?: {
    readonly tableId?: string | null;
    readonly sectionId?: string | null;
    readonly specimenKey?: string | null;
    readonly collectionDateKey?: string | null;
  };
  readonly parentId?: string;
  readonly spans?: readonly {
    readonly id?: string;
    readonly parentObservationId?: string;
    readonly start: number;
    readonly end: number;
    readonly boundingBox?: GeometryFixtureObservation['boundingBox'];
    readonly text?: string;
  }[];
};

export type GeometryFixture = {
  readonly id:
    | 'normal-table'
    | 'loose-x-y-cells'
    | 'merged-parent-two-bands'
    | 'comma-decimal-locale'
    | 'ambiguous-overlap'
    | 'cross-boundary-nonmerge';
  readonly observations: readonly GeometryFixtureObservation[];
  readonly expected: {
    readonly resolvedRowCount: number;
    readonly unresolvedParentIds: readonly string[];
    readonly rowObservationIds: readonly (readonly string[])[];
  };
};

function observation(
  id: string,
  text: string,
  x: number,
  y: number,
  overrides: Partial<GeometryFixtureObservation> = {},
): GeometryFixtureObservation {
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
  y: number,
  rowIndex: number,
  columnIndex: number,
  tableId = 'synthetic-table',
): GeometryFixtureObservation {
  return observation(id, text, x, y, {
    structure: { kind: 'table-cell', tableId, rowIndex, columnIndex },
  });
}

const normalTable: GeometryFixture = {
  id: 'normal-table',
  observations: [
    tableCell('normal-label', 'LDL-C', 0.08, 0.18, 0, 0),
    tableCell('normal-value', '3.8', 0.48, 0.18, 0, 1),
    tableCell('normal-unit', 'mmol/L', 0.68, 0.18, 0, 2),
    tableCell('normal-reference', '1.2-3.4', 0.82, 0.18, 0, 3),
    tableCell('normal-2-label', 'HDL-C', 0.08, 0.28, 1, 0),
    tableCell('normal-2-value', '1.4', 0.48, 0.28, 1, 1),
    tableCell('normal-2-unit', 'mmol/L', 0.68, 0.28, 1, 2),
  ],
  expected: {
    resolvedRowCount: 2,
    unresolvedParentIds: [],
    rowObservationIds: [
      ['normal-label', 'normal-value', 'normal-unit', 'normal-reference'],
      ['normal-2-label', 'normal-2-value', 'normal-2-unit'],
    ],
  },
};

const looseXYCells: GeometryFixture = {
  id: 'loose-x-y-cells',
  observations: [
    observation('loose-label', 'LDL cholesterol', 0.07, 0.2),
    observation('loose-value', '118', 0.47, 0.202, {
      boundingBox: { x: 0.47, y: 0.202, width: 0.1, height: 0.032 },
    }),
    observation('loose-unit', 'mg/dL', 0.64, 0.2),
    observation('loose-reference', '70-115', 0.79, 0.2),
    observation('loose-2-label', 'HDL cholesterol', 0.07, 0.31),
    observation('loose-2-value', '54', 0.47, 0.31),
    observation('loose-2-unit', 'mg/dL', 0.64, 0.31),
  ],
  expected: {
    resolvedRowCount: 2,
    unresolvedParentIds: [],
    rowObservationIds: [
      ['loose-label', 'loose-value', 'loose-unit', 'loose-reference'],
      ['loose-2-label', 'loose-2-value', 'loose-2-unit'],
    ],
  },
};

const mergedParentTwoBands: GeometryFixture = {
  id: 'merged-parent-two-bands',
  observations: [
    observation('wrapped-parent', 'LDL-C\n3,8 mmol/L', 0.08, 0.2, {
      parentId: 'wrapped-parent',
      boundingBox: { x: 0.08, y: 0.2, width: 0.72, height: 0.11 },
      spans: [
        {
          id: 'span-label',
          parentObservationId: 'wrapped-parent',
          start: 0,
          end: 5,
          text: 'LDL-C',
          boundingBox: { x: 0.08, y: 0.2, width: 0.18, height: 0.035 },
        },
        {
          id: 'span-value',
          parentObservationId: 'wrapped-parent',
          start: 6,
          end: 9,
          text: '3,8',
          boundingBox: { x: 0.08, y: 0.265, width: 0.12, height: 0.035 },
        },
        {
          id: 'span-unit',
          parentObservationId: 'wrapped-parent',
          start: 10,
          end: 16,
          text: 'mmol/L',
          boundingBox: { x: 0.23, y: 0.265, width: 0.18, height: 0.035 },
        },
      ],
    }),
  ],
  expected: {
    resolvedRowCount: 2,
    unresolvedParentIds: [],
    rowObservationIds: [['wrapped-parent'], ['wrapped-parent']],
  },
};

const commaDecimalLocale: GeometryFixture = {
  id: 'comma-decimal-locale',
  observations: [
    observation('lt-label', 'MTL cholesterolis', 0.07, 0.2, {
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
    observation('lt-value', '3,8', 0.47, 0.2, {
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
    observation('lt-unit', 'mmol/L', 0.64, 0.2, {
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
  ],
  expected: {
    resolvedRowCount: 1,
    unresolvedParentIds: [],
    rowObservationIds: [['lt-label', 'lt-value', 'lt-unit']],
  },
};

const ambiguousOverlap: GeometryFixture = {
  id: 'ambiguous-overlap',
  observations: [
    observation('ambiguous-parent', 'A B C', 0.08, 0.2, {
      parentId: 'ambiguous-parent',
      boundingBox: { x: 0.08, y: 0.2, width: 0.5, height: 0.16 },
      spans: [
        {
          id: 'span-a',
          parentObservationId: 'ambiguous-parent',
          start: 0,
          end: 1,
          text: 'A',
          boundingBox: { x: 0.08, y: 0.2, width: 0.08, height: 0.035 },
        },
        {
          id: 'span-b',
          parentObservationId: 'ambiguous-parent',
          start: 2,
          end: 3,
          text: 'B',
          boundingBox: { x: 0.08, y: 0.275, width: 0.08, height: 0.035 },
        },
        {
          id: 'span-c',
          parentObservationId: 'ambiguous-parent',
          start: 4,
          end: 5,
          text: 'C',
          boundingBox: { x: 0.08, y: 0.235, width: 0.08, height: 0.1 },
        },
      ],
    }),
  ],
  expected: {
    resolvedRowCount: 0,
    unresolvedParentIds: ['ambiguous-parent'],
    rowObservationIds: [],
  },
};

const crossBoundaryNonmerge: GeometryFixture = {
  id: 'cross-boundary-nonmerge',
  observations: [
    observation('page-one', 'LDL-C', 0.08, 0.2, {
      pageIndex: 0,
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
    observation('page-two', '3.8', 0.48, 0.2, {
      pageIndex: 1,
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
    observation('section-two', 'mg/dL', 0.64, 0.2, {
      pageIndex: 0,
      context: { sectionId: 'chemistry', specimenKey: 'serum', collectionDateKey: '2026-08-20' },
    }),
    observation('specimen-two', '1.2-3.4', 0.79, 0.2, {
      pageIndex: 0,
      context: { sectionId: 'lipids', specimenKey: 'plasma', collectionDateKey: '2026-08-20' },
    }),
    observation('date-two', 'H', 0.88, 0.2, {
      pageIndex: 0,
      context: { sectionId: 'lipids', specimenKey: 'serum', collectionDateKey: '2026-08-21' },
    }),
  ],
  expected: {
    resolvedRowCount: 5,
    unresolvedParentIds: [],
    rowObservationIds: [
      ['page-one'],
      ['page-two'],
      ['section-two'],
      ['specimen-two'],
      ['date-two'],
    ],
  },
};

export const geometryFixtureMatrix: readonly GeometryFixture[] = Object.freeze([
  normalTable,
  looseXYCells,
  mergedParentTwoBands,
  commaDecimalLocale,
  ambiguousOverlap,
  crossBoundaryNonmerge,
]);
