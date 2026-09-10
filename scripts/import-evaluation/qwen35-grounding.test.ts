import assert from 'node:assert/strict';
import test from 'node:test';
import { groundVisionProposals, type VisionPage } from './qwen35-grounding';
import type { EvaluationMeasurement } from './contract';

function measurement(overrides: Partial<EvaluationMeasurement> = {}): EvaluationMeasurement {
  return {
    id: 'proposal-1',
    sourceLabel: 'Analyte',
    valueString: '42',
    valueType: 'text',
    parsedValue: null,
    comparator: null,
    unit: 'mg/L',
    referenceInterval: '1-9',
    flag: 'H',
    collectionDate: '2026-01-01',
    collectionGroup: null,
    specimen: 'serum',
    page: 1,
    location: null,
    ambiguousFields: ['sourceIds'],
    ...overrides,
  };
}

function observation(
  id: string,
  text: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    text,
    pageIndex: 0,
    boundingBox: { x, y, width: 0.1, height: 0.01 },
    ...extra,
  };
}

function page(observations: readonly Record<string, unknown>[]): VisionPage {
  return {
    pageIndex: 0,
    observations: observations as VisionPage['observations'],
  };
}

function pageAt(pageIndex: number, observations: readonly Record<string, unknown>[]): VisionPage {
  return {
    pageIndex,
    observations: observations as VisionPage['observations'],
  };
}

test('grounds one table row and copies optional fields only from native cells', () => {
  const result = groundVisionProposals(
    [measurement()],
    [
      page([
        observation('flag-header', 'Flag', 0.9, 0.1, {
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 0,
            columnIndex: 4,
          },
        }),
        observation('label', 'Analyte', 0.1, 0.2, {
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 2,
            columnIndex: 0,
          },
        }),
        observation('value', '42', 0.4, 0.2, {
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 2,
            columnIndex: 1,
          },
        }),
        observation('unit', 'mg/L', 0.6, 0.2, {
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 2,
            columnIndex: 2,
          },
        }),
        observation('ref', '1-9', 0.8, 0.2, {
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 2,
            columnIndex: 3,
          },
        }),
        observation('flag', 'H', 0.9, 0.2, {
          sourceStart: 20,
          sourceEnd: 21,
          structure: {
            kind: 'table-cell',
            tableId: 'table-0',
            rowIndex: 2,
            columnIndex: 4,
          },
        }),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.deepEqual(result.measurements[0]?.sourceIds, ['flag', 'label', 'ref', 'unit', 'value']);
  assert.equal(result.measurements[0]?.unit, 'mg/L');
  assert.equal(result.measurements[0]?.referenceInterval, '1-9');
  assert.equal(result.measurements[0]?.flag, 'H');
  assert.equal(result.measurements[0]?.collectionDate, null);
  assert.equal(result.measurements[0]?.specimen, null);
  assert.equal(result.measurements[0]?.canonicalBiomarkerId, null);
  assert.equal(result.measurements[0]?.valueType, 'numeric');
  assert.equal(result.measurements[0]?.parsedValue, 42);
});

test('rejects an administrative code as a flag without native flag ownership', () => {
  const result = groundVisionProposals(
    [
      measurement({
        id: 'administrative-flag',
        unit: null,
        referenceInterval: null,
        flag: 'AB',
      }),
    ],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2, {
          sourceStart: 0,
          sourceEnd: 7,
        }),
        observation('value', '42', 0.4, 0.2, { sourceStart: 8, sourceEnd: 10 }),
        observation('administrative-code', 'AB', 0.9, 0.2, {
          sourceStart: 11,
          sourceEnd: 13,
        }),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.flag, null);
});

test('copies a flagged result marker only from the value observation', () => {
  const result = groundVisionProposals(
    [
      measurement({
        id: 'inline-flag',
        unit: null,
        referenceInterval: null,
        flag: 'H',
      }),
    ],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2, {
          sourceStart: 0,
          sourceEnd: 7,
        }),
        observation('value-and-flag', '42 H', 0.4, 0.2, {
          sourceStart: 8,
          sourceEnd: 12,
          spans: [
            {
              text: '42',
              boundingBox: { x: 0.4, y: 0.2, width: 0.05, height: 0.01 },
            },
            {
              text: 'H',
              boundingBox: { x: 0.48, y: 0.2, width: 0.02, height: 0.01 },
            },
          ],
        }),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.flag, 'H');
});

test('rejects unrecognized or non-whole inline flag atoms', () => {
  const cases = [
    { id: 'administrative-inline', text: '42 AB', flag: 'AB', second: 'AB' },
    { id: 'phrase-inline', text: '42 H extra', flag: 'H', second: 'H extra' },
  ] as const;
  for (const testCase of cases) {
    const result = groundVisionProposals(
      [
        measurement({
          id: testCase.id,
          unit: null,
          referenceInterval: null,
          flag: testCase.flag,
        }),
      ],
      [
        page([
          observation('label', 'Analyte', 0.1, 0.2, {
            sourceStart: 0,
            sourceEnd: 7,
          }),
          observation('value-and-flag', testCase.text, 0.4, 0.2, {
            sourceStart: 8,
            sourceEnd: 8 + testCase.text.length,
            spans: [
              {
                text: '42',
                boundingBox: { x: 0.4, y: 0.2, width: 0.05, height: 0.01 },
              },
              {
                text: testCase.second,
                boundingBox: { x: 0.48, y: 0.2, width: 0.08, height: 0.01 },
              },
            ],
          }),
        ]),
      ],
    );
    assert.equal(result.diagnostics.acceptedCount, 1, testCase.id);
    assert.equal(result.measurements[0]?.flag, null, testCase.id);
  }
});

test('accepts a unique two-line text span but rejects unrelated rows', () => {
  const result = groundVisionProposals(
    [measurement({ id: 'proposal-2', unit: 'not-native' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2, {
          sourceStart: 0,
          sourceEnd: 7,
        }),
        observation('value', '42', 0.4, 0.21, {
          sourceStart: 8,
          sourceEnd: 10,
        }),
        observation('other-label', 'Other', 0.1, 0.5),
        observation('other-value', '42', 0.4, 0.54),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.unit, null);
  assert.equal(result.measurements[0]?.sourceIds?.length, 2);

  const rejected = groundVisionProposals(
    [
      measurement({
        id: 'proposal-3',
        sourceLabel: 'Analyte',
        valueString: '99',
      }),
    ],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', '42', 0.4, 0.2),
        observation('other-value', '99', 0.4, 0.5),
      ]),
    ],
  );
  assert.equal(rejected.diagnostics.acceptedCount, 0);
  assert.equal(rejected.diagnostics.rejectedByReason['not-same-row-or-span'], 1);
});

test('rejects ambiguous spans and deduplicates the same source occurrence', () => {
  const proposal = measurement({ id: 'duplicate' });
  const pages = [
    page([
      observation('label-1', 'Analyte', 0.1, 0.2, {
        sourceStart: 0,
        sourceEnd: 7,
      }),
      observation('value-1', '42', 0.4, 0.205, {
        sourceStart: 8,
        sourceEnd: 10,
      }),
      observation('label-2', 'Analyte', 0.1, 0.4, {
        sourceStart: 100,
        sourceEnd: 107,
      }),
      observation('value-2', '42', 0.4, 0.405, {
        sourceStart: 108,
        sourceEnd: 110,
      }),
    ]),
  ];
  const ambiguous = groundVisionProposals([proposal], pages);
  assert.equal(ambiguous.diagnostics.acceptedCount, 0);
  assert.equal(ambiguous.diagnostics.rejectedByReason['ambiguous-source-span'], 1);

  const uniquePages = [
    page([
      observation('label', 'Analyte', 0.1, 0.2, {
        sourceStart: 0,
        sourceEnd: 7,
      }),
      observation('value', '42', 0.4, 0.205, { sourceStart: 8, sourceEnd: 10 }),
    ]),
  ];
  const deduped = groundVisionProposals(
    [proposal, { ...proposal, id: 'duplicate-2' }],
    uniquePages,
  );
  assert.equal(deduped.diagnostics.acceptedCount, 1);
  assert.equal(deduped.diagnostics.rejectedByReason['duplicate-occurrence'], 1);
});

test('requires a complete numeric source token and infers locale-safe numeric fields', () => {
  const rejectedDecimalSuffix = groundVisionProposals(
    [measurement({ id: 'suffix', valueString: '42' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '42.5', 0.4, 0.2)])],
  );
  assert.equal(rejectedDecimalSuffix.diagnostics.acceptedCount, 0);
  assert.equal(rejectedDecimalSuffix.diagnostics.rejectedByReason['value-not-found'], 1);

  const decimal = groundVisionProposals(
    [measurement({ id: 'decimal', valueString: '12,96', valueType: 'text' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '12,96', 0.4, 0.2)])],
  );
  assert.equal(decimal.measurements[0]?.valueType, 'numeric');
  assert.equal(decimal.measurements[0]?.parsedValue, 12.96);

  const sourceSpelling = groundVisionProposals(
    [
      measurement({
        id: 'source-spelling',
        valueString: '12.96',
        valueType: 'numeric',
      }),
    ],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '12,96', 0.4, 0.2)])],
  );
  assert.equal(sourceSpelling.measurements[0]?.valueString, '12,96');
  assert.equal(sourceSpelling.measurements[0]?.parsedValue, 12.96);

  const bounded = groundVisionProposals(
    [measurement({ id: 'bounded', valueString: '<= 5,2', valueType: 'text' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '≤ 5.2', 0.4, 0.2)])],
  );
  assert.equal(bounded.measurements[0]?.valueType, 'bounded');
  assert.equal(bounded.measurements[0]?.parsedValue, 5.2);
  assert.equal(bounded.measurements[0]?.comparator, '<=');
});

test('accepts inline numeric tokens but rejects attached, range, and date members', () => {
  const inline = groundVisionProposals(
    [
      measurement({
        id: 'inline-label',
        sourceLabel: 'Marker',
        valueString: '12.96',
      }),
    ],
    [page([observation('inline', 'Marker 12,96 mg/L', 0.1, 0.2)])],
  );
  assert.equal(inline.diagnostics.acceptedCount, 1);
  assert.equal(inline.measurements[0]?.valueString, '12,96');
  assert.equal(inline.measurements[0]?.parsedValue, 12.96);

  const attached = groundVisionProposals(
    [
      measurement({
        id: 'attached-number',
        sourceLabel: 'Marker12',
        valueString: '12.96',
      }),
    ],
    [page([observation('attached', 'Marker12,96 mg/L', 0.1, 0.2)])],
  );
  assert.equal(attached.diagnostics.acceptedCount, 0);
  assert.equal(attached.diagnostics.rejectedByReason['value-not-found'], 1);

  const range = groundVisionProposals(
    [
      measurement({
        id: 'inline-range-member',
        sourceLabel: 'Marker',
        valueString: '1',
      }),
    ],
    [page([observation('range', 'Marker 1 - 5', 0.1, 0.2)])],
  );
  assert.equal(range.diagnostics.acceptedCount, 0);
  assert.equal(range.diagnostics.rejectedByReason['value-not-found'], 1);

  const date = groundVisionProposals(
    [
      measurement({
        id: 'inline-date-member',
        sourceLabel: 'Marker',
        valueString: '2024',
      }),
    ],
    [page([observation('date', 'Marker 2024/01/05', 0.1, 0.2)])],
  );
  assert.equal(date.diagnostics.acceptedCount, 0);
  assert.equal(date.diagnostics.rejectedByReason['value-not-found'], 1);
});

test('infers categorical values and rejects an unproven cross-line association', () => {
  const categorical = groundVisionProposals(
    [
      measurement({
        id: 'categorical',
        valueString: 'positive',
        valueType: 'text',
      }),
    ],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', 'positive', 0.4, 0.2)])],
  );
  assert.equal(categorical.measurements[0]?.valueType, 'categorical');
  assert.equal(categorical.measurements[0]?.parsedValue, 'positive');

  const appearance = groundVisionProposals(
    [
      measurement({
        id: 'appearance',
        valueString: 'light yellow',
        valueType: 'text',
      }),
    ],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', 'light yellow', 0.4, 0.2),
      ]),
    ],
  );
  assert.equal(appearance.measurements[0]?.valueType, 'categorical');

  const pending = groundVisionProposals(
    [measurement({ id: 'pending', valueString: 'pending', valueType: 'text' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', 'pending', 0.4, 0.2)])],
  );
  assert.equal(pending.measurements[0]?.valueType, 'text');

  const arbitraryText = groundVisionProposals(
    [measurement({ id: 'arbitrary-text', valueString: 'Borderline', valueType: 'unknown' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', 'Borderline', 0.4, 0.2),
      ]),
    ],
  );
  assert.equal(arbitraryText.measurements[0]?.valueType, 'text');
  assert.equal(arbitraryText.measurements[0]?.parsedValue, 'Borderline');

  const unproven = groundVisionProposals(
    [measurement({ id: 'unproven', valueString: '42' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '42', 0.4, 0.21)])],
  );
  assert.equal(unproven.diagnostics.acceptedCount, 0);
  assert.equal(unproven.diagnostics.rejectedByReason['not-same-row-or-span'], 1);
});

test('does not treat date or range members as standalone numeric observations', () => {
  const range = groundVisionProposals(
    [measurement({ id: 'range-member', valueString: '1' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '1-5', 0.4, 0.2)])],
  );
  assert.equal(range.diagnostics.acceptedCount, 0);
  assert.equal(range.diagnostics.rejectedByReason['value-not-found'], 1);

  const date = groundVisionProposals(
    [measurement({ id: 'date-member', valueString: '2024' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', '2024/01/05', 0.4, 0.2),
      ]),
    ],
  );
  assert.equal(date.diagnostics.acceptedCount, 0);
  assert.equal(date.diagnostics.rejectedByReason['value-not-found'], 1);

  const placeholder = groundVisionProposals(
    [measurement({ id: 'placeholder', valueString: '-' })],
    [page([observation('label', 'Analyte', 0.1, 0.2), observation('value', '-', 0.4, 0.2)])],
  );
  assert.equal(placeholder.diagnostics.acceptedCount, 0);
  assert.equal(placeholder.diagnostics.rejectedByReason['value-not-found'], 1);
});

test('anchors a same-word value to the result column instead of the reference column', () => {
  const result = groundVisionProposals(
    [
      measurement({
        id: 'result-column',
        valueString: 'None',
        valueType: 'categorical',
      }),
    ],
    [
      page([
        observation('header', 'Reference Result', 0.1, 0.1, {
          spans: [
            {
              id: 'reference-header',
              text: 'Reference',
              boundingBox: { x: 0.45, y: 0.1, width: 0.1, height: 0.01 },
            },
            {
              id: 'result-header',
              text: 'Result',
              boundingBox: { x: 0.7, y: 0.1, width: 0.1, height: 0.01 },
            },
          ],
        }),
        observation('label', 'Analyte', 0.1, 0.2),
        observation('reference', 'NONE', 0.45, 0.2, {
          spans: [
            {
              id: 'reference-value',
              text: 'NONE',
              boundingBox: { x: 0.45, y: 0.2, width: 0.05, height: 0.01 },
            },
          ],
        }),
        observation('result', 'None', 0.7, 0.2, {
          spans: [
            {
              id: 'result-value',
              text: 'None',
              boundingBox: { x: 0.7, y: 0.2, width: 0.05, height: 0.01 },
            },
          ],
        }),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.valueString, 'None');
  assert.equal(result.measurements[0]?.valueType, 'categorical');
});

test('rejects a sole value occurrence outside the explicit current-result interval', () => {
  const result = groundVisionProposals(
    [measurement({ id: 'outside-current', valueString: '1-9', unit: null })],
    [
      page([
        observation('headers', 'Unit Reference Result', 0.1, 0.1, {
          spans: [
            { text: 'Unit', boundingBox: { x: 0.44, y: 0.1, width: 0.06, height: 0.01 } },
            {
              text: 'Reference',
              boundingBox: { x: 0.57, y: 0.1, width: 0.06, height: 0.01 },
            },
            { text: 'Result', boundingBox: { x: 0.72, y: 0.1, width: 0.08, height: 0.01 } },
          ],
        }),
        observation('label', 'Analyte', 0.1, 0.2),
        observation('reference-value', '1-9', 0.57, 0.2),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 0);
  assert.equal(result.diagnostics.rejectedByReason['ambiguous-source-span'], 1);
});

test('preserves a value in an unowned gutter when no competing header owns it', () => {
  const result = groundVisionProposals(
    [measurement({ id: 'unknown-gutter', valueString: '42', unit: null })],
    [
      page([
        observation('headers', 'Unit Reference Result', 0.1, 0.1, {
          spans: [
            { text: 'Unit', boundingBox: { x: 0.44, y: 0.1, width: 0.06, height: 0.01 } },
            {
              text: 'Reference',
              boundingBox: { x: 0.57, y: 0.1, width: 0.06, height: 0.01 },
            },
            { text: 'Result', boundingBox: { x: 0.72, y: 0.1, width: 0.08, height: 0.01 } },
          ],
        }),
        observation('label', 'Analyte', 0.1, 0.2),
        observation('unknown-gutter-value', '42', 0.9, 0.2),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
});

test('rejects a table value from the reference column when current ownership is explicit', () => {
  const cell = (id: string, text: string, x: number, rowIndex: number, columnIndex: number) =>
    observation(id, text, x, rowIndex === 0 ? 0.1 : 0.2, {
      structure: {
        kind: 'table-cell',
        tableId: 'table-ownership',
        rowIndex,
        columnIndex,
      },
    });
  const result = groundVisionProposals(
    [measurement({ id: 'table-reference', valueString: '1-9', unit: null })],
    [
      page([
        cell('test-header', 'Test', 0.1, 0, 0),
        cell('current-header', 'Current Result', 0.4, 0, 1),
        cell('reference-header', 'Reference Interval', 0.8, 0, 2),
        cell('label', 'Analyte', 0.1, 1, 0),
        cell('reference-value', '1-9', 0.8, 1, 2),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 0);
  assert.equal(result.diagnostics.rejectedByReason['ambiguous-source-span'], 1);
});

test('copies a reference value only from the explicit reference column', () => {
  const result = groundVisionProposals(
    [measurement({ id: 'reference-column', referenceInterval: '42', unit: null })],
    [
      page([
        observation('headers', 'Unit Reference Result', 0.1, 0.1, {
          spans: [
            { text: 'Unit', boundingBox: { x: 0.44, y: 0.1, width: 0.06, height: 0.01 } },
            {
              text: 'Reference',
              boundingBox: { x: 0.57, y: 0.1, width: 0.06, height: 0.01 },
            },
            { text: 'Result', boundingBox: { x: 0.72, y: 0.1, width: 0.08, height: 0.01 } },
          ],
        }),
        observation('label', 'Analyte', 0.1, 0.2),
        observation('current-value', '42', 0.72, 0.2),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.valueString, '42');
  assert.equal(result.measurements[0]?.referenceInterval, null);
});

test('rejects a value token contained in the native label observation', () => {
  const result = groundVisionProposals(
    [
      measurement({
        id: 'label-substring',
        sourceLabel: 'Reference Marker',
        valueString: 'Marker',
        valueType: 'text',
        unit: null,
        referenceInterval: null,
        flag: null,
      }),
    ],
    [page([observation('label-cell', 'Reference Marker', 0.1, 0.2)])],
  );
  assert.equal(result.diagnostics.acceptedCount, 0);
  assert.equal(result.diagnostics.rejectedByReason['not-same-row-or-span'], 1);
});

test('preserves native units and leaves case-only differences unresolved', () => {
  const result = groundVisionProposals(
    [measurement({ id: 'unit-case', unit: 'x10E3/uL' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', '42', 0.4, 0.2),
        observation('unit', 'X10E3/uL', 0.7, 0.2),
      ]),
    ],
  );
  assert.equal(result.diagnostics.acceptedCount, 1);
  assert.equal(result.measurements[0]?.unit, null);
  assert.deepEqual(result.measurements[0]?.sourceIds, ['label', 'unit', 'value']);

  const conventionalCase = groundVisionProposals(
    [measurement({ id: 'unit-conventional-case', unit: 'fL' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', '42', 0.4, 0.2),
        observation('unit', 'fL', 0.7, 0.2),
      ]),
    ],
  );
  assert.equal(conventionalCase.measurements[0]?.unit, 'fL');

  const incompatible = groundVisionProposals(
    [measurement({ id: 'unit-incompatible', unit: 'mg/L' })],
    [
      page([
        observation('label', 'Analyte', 0.1, 0.2),
        observation('value', '42', 0.4, 0.2),
        observation('unit', 'X10E3/uL', 0.7, 0.2),
      ]),
    ],
  );
  assert.equal(incompatible.measurements[0]?.unit, null);
});

test('keeps unit prefixes and litre suffixes case-sensitive', () => {
  const cases = [
    ['mg/dL', 'mg/dL', 'mg/dL'],
    ['mg/dL', 'Mg/dL', null],
    ['mg/dL', 'MG/dL', null],
    ['mL', 'mL', 'mL'],
    ['mL', 'ML', null],
    ['μg/L', 'µg/L', 'µg/L'],
  ] as const;
  for (const [proposalUnit, nativeUnit, expectedUnit] of cases) {
    const result = groundVisionProposals(
      [
        measurement({
          id: `unit-${proposalUnit}-${nativeUnit}`,
          unit: proposalUnit,
        }),
      ],
      [
        page([
          observation('label', 'Analyte', 0.1, 0.2),
          observation('value', '42', 0.4, 0.2),
          observation('unit', nativeUnit, 0.7, 0.2),
        ]),
      ],
    );
    assert.equal(result.measurements[0]?.unit, expectedUnit);
  }
});

test('prefers current result over previous result and abstains across a different page layout', () => {
  const sameLayout = groundVisionProposals(
    [
      measurement({
        id: 'current-result',
        valueString: 'None',
        valueType: 'categorical',
      }),
    ],
    [
      page([
        observation('headers', 'Previous Result Current Result', 0.1, 0.1, {
          spans: [
            {
              text: 'Previous Result',
              start: 0,
              end: 15,
              boundingBox: { x: 0.4, y: 0.1, width: 0.1, height: 0.01 },
            },
            {
              text: 'Current Result',
              start: 16,
              end: 29,
              boundingBox: { x: 0.7, y: 0.1, width: 0.1, height: 0.01 },
            },
          ],
        }),
        observation('label', 'Analyte', 0.1, 0.2),
        observation('previous-value', 'NONE', 0.4, 0.2, {
          spans: [
            {
              text: 'NONE',
              boundingBox: { x: 0.4, y: 0.2, width: 0.1, height: 0.01 },
            },
          ],
        }),
        observation('current-value', 'None', 0.7, 0.2, {
          spans: [
            {
              text: 'None',
              boundingBox: { x: 0.7, y: 0.2, width: 0.1, height: 0.01 },
            },
          ],
        }),
      ]),
    ],
  );
  assert.equal(sameLayout.diagnostics.acceptedCount, 1);
  assert.equal(sameLayout.measurements[0]?.valueString, 'None');
  assert.ok(sameLayout.measurements[0]?.sourceIds?.includes('current-value'));

  const differentLayout = groundVisionProposals(
    [measurement({ id: 'different-layout', page: 2, valueString: 'None' })],
    [
      pageAt(0, [
        observation('header', 'Current Result', 0.7, 0.1),
        ...[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((x, index) =>
          observation(`header-layout-${index}`, 'metadata', x, 0.4),
        ),
      ]),
      pageAt(1, [
        observation('label', 'Analyte', 0.0, 0.2),
        observation('previous-value', 'NONE', 0.2, 0.2, {
          spans: [
            {
              text: 'NONE',
              boundingBox: { x: 0.2, y: 0.2, width: 0.1, height: 0.01 },
            },
          ],
        }),
        observation('current-value', 'None', 0.75, 0.2, {
          spans: [
            {
              text: 'None',
              boundingBox: { x: 0.75, y: 0.2, width: 0.1, height: 0.01 },
            },
          ],
        }),
        ...[0.0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84].map((x, index) =>
          observation(`different-layout-${index}`, 'metadata', x, 0.4),
        ),
      ]),
    ],
  );
  assert.equal(differentLayout.diagnostics.acceptedCount, 0);
  assert.equal(differentLayout.diagnostics.rejectedByReason['ambiguous-source-span'], 1);
});
