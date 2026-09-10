import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractHeaderTablePage,
  extractHeaderTablePages,
  type HeaderTablePage,
} from './header-table';

function page(
  rows: readonly {
    readonly y: number;
    readonly cells: readonly {
      readonly text: string;
      readonly x: number;
      readonly id?: string;
      readonly width?: number;
      readonly height?: number;
      readonly columnIndex?: number;
      readonly spans?: readonly {
        readonly text: string;
        readonly x: number;
        readonly width?: number;
        readonly height?: number;
        readonly id?: string;
      }[];
    }[];
    readonly tableId?: string;
    readonly rowIndex?: number;
  }[],
): HeaderTablePage {
  return {
    pageIndex: 0,
    width: 1000,
    height: 1000,
    observations: rows.flatMap((row, rowNumber) =>
      row.cells.map((cell, cellNumber) => ({
        id: cell.id ?? `observation-${rowNumber}-${cellNumber}`,
        text: cell.text,
        pageIndex: 0,
        boundingBox: {
          x: cell.x,
          y: row.y,
          width: cell.width ?? 0.08,
          height: cell.height ?? 0.02,
        },
        structure:
          row.tableId === undefined
            ? { kind: 'text' as const, tableId: null, rowIndex: null, columnIndex: null }
            : {
                kind: 'table-cell' as const,
                tableId: row.tableId,
                rowIndex: row.rowIndex ?? rowNumber,
                columnIndex: cell.columnIndex ?? cellNumber,
              },
        spans:
          cell.spans === undefined
            ? [
                {
                  id: cell.id ?? `span-${rowNumber}-${cellNumber}`,
                  parentObservationId: cell.id ?? `observation-${rowNumber}-${cellNumber}`,
                  start: 0,
                  end: cell.text.length,
                  text: cell.text,
                  boundingBox: {
                    x: cell.x,
                    y: row.y,
                    width: cell.width ?? 0.08,
                    height: cell.height ?? 0.02,
                  },
                },
              ]
            : cell.spans.map((span, spanNumber) => ({
                id: span.id ?? `${cell.id ?? `span-${rowNumber}-${cellNumber}`}-${spanNumber}`,
                parentObservationId: cell.id ?? `observation-${rowNumber}-${cellNumber}`,
                start: 0,
                end: span.text.length,
                text: span.text,
                boundingBox: {
                  x: span.x,
                  y: row.y,
                  width: span.width ?? 0.04,
                  height: span.height ?? cell.height ?? 0.02,
                },
              })),
      })),
    ),
  };
}

test('anchors current results by multilingual headers and ignores previous result cells', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result and Flag', x: 0.32 },
        { text: 'Previous Result and Date', x: 0.5 },
        { text: 'Units', x: 0.68 },
        { text: 'Reference Interval', x: 0.84 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Displaced alpha', x: 0.08, id: 'label-a' },
        { text: '4.2 High', x: 0.32, id: 'current-a' },
        { text: '99.9', x: 0.5, id: 'previous-a' },
        { text: 'mg/L', x: 0.68, id: 'unit-a' },
        { text: '0-10', x: 0.84, id: 'reference-a' },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Displaced alpha');
  assert.equal(result.measurements[0]?.valueString, '4.2');
  assert.equal(result.measurements[0]?.parsedValue, 4.2);
  assert.equal(result.measurements[0]?.comparator, null);
  assert.equal(result.measurements[0]?.flag, 'High');
  assert.deepEqual(result.measurements[0]?.sourceIds, [
    'label-a',
    'current-a',
    'previous-a',
    'unit-a',
    'reference-a',
  ]);
  assert.equal(result.counts.rowsWithPreviousColumn, 1);
});

test('supports reordered Lithuanian and German headers without coordinates', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'TYRIMAS', x: 0.08 },
        { text: 'Matavimo vienetas', x: 0.55 },
        { text: 'Normų ribos', x: 0.72 },
        { text: 'Tyrimo rezultatas', x: 0.38 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Mėginys be katalogo etiketės', x: 0.08 },
        { text: '>= 5,4', x: 0.38 },
        { text: 'mmol/L', x: 0.55 },
        { text: '0-10', x: 0.72 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.valueType, 'bounded');
  assert.equal(result.measurements[0]?.parsedValue, 5.4);
  assert.equal(result.measurements[0]?.comparator, '>=');
});

test('retains categorical and pending values while rejecting unheaded rows', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Analyse', x: 0.08 },
        { text: 'Ergebnis', x: 0.38 },
        { text: 'Einheit', x: 0.62 },
        { text: 'Referenzbereich', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Qualitative marker', x: 0.08 },
        { text: 'Negative', x: 0.38 },
        { text: '', x: 0.62 },
        { text: 'Negative', x: 0.8 },
      ],
    },
    {
      y: 0.22,
      cells: [
        { text: 'Pending marker', x: 0.08 },
        { text: 'Test not performed; result will follow.', x: 0.38 },
      ],
    },
    {
      y: 0.28,
      cells: [
        { text: 'Arbitrary status', x: 0.08 },
        { text: 'Maybe', x: 0.38 },
      ],
    },
    {
      y: 0.8,
      cells: [
        { text: 'Unheaded alpha', x: 0.08 },
        { text: '8.1', x: 0.38 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.deepEqual(
    result.measurements.map((measurement) => measurement.valueType),
    ['categorical', 'text', 'text'],
  );
  assert.equal(result.measurements[0]?.parsedValue, 'Negative');
  assert.equal(result.measurements[1]?.parsedValue, 'Test not performed; result will follow.');
  assert.equal(result.measurements[2]?.parsedValue, 'Maybe');
});

test('only accepts an explicit collection date and never report or receipt dates', () => {
  const input = page([
    {
      y: 0.04,
      cells: [
        { text: 'Date Received: 04/02/2025', x: 0.05 },
        { text: 'Date Collected: 04/01/2025', x: 0.5 },
      ],
    },
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
        { text: 'Units', x: 0.62 },
        { text: 'Reference Interval', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Date-safe marker', x: 0.08 },
        { text: '8', x: 0.38 },
        { text: 'mg/L', x: 0.62 },
        { text: '0-10', x: 0.8 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input, { dateLocale: 'en-US' });
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.collectionDate, '2025-04-01');
});

test('keeps ambiguous slash dates unresolved and validates the calendar', () => {
  const input = page([
    { y: 0.04, cells: [{ text: 'Collection date: 04/01/2025', x: 0.05 }] },
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Marker', x: 0.08 },
        { text: '8', x: 0.38 },
      ],
    },
  ]);
  assert.equal(extractHeaderTablePage(input).measurements[0]?.collectionDate, null);
  assert.equal(
    extractHeaderTablePage(input, { dateLocale: 'en-US' }).measurements[0]?.collectionDate,
    '2025-04-01',
  );

  const invalid = page([
    { y: 0.04, cells: [{ text: 'Date Collected: 02/30/2025', x: 0.05 }] },
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Marker', x: 0.08 },
        { text: '8', x: 0.38 },
      ],
    },
  ]);
  assert.equal(
    extractHeaderTablePage(invalid, { dateLocale: 'en-US' }).measurements[0]?.collectionDate,
    null,
  );
});

test('does not treat a previous-only German header as the current result column', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Analyse', x: 0.08 },
        { text: 'Vorheriges', x: 0.38 },
        { text: 'Ergebnis', x: 0.5 },
        { text: 'Datum', x: 0.62 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Marker', x: 0.08 },
        { text: '7.2', x: 0.5 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 0);
  assert.equal(result.counts.headerRows, 0);
});

test('rejects a target-result guidance header as a measurement table', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
        { text: 'Target Result', x: 0.68 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Guidance row', x: 0.08 },
        { text: '4.0', x: 0.38 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.counts.headerRows, 0);
  assert.equal(result.measurements.length, 0);
});

test('keeps ownership stable under displacement, scaling, and side administrative columns', () => {
  const base = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.1 },
        { text: 'Current Result', x: 0.38 },
        { text: 'Units', x: 0.62 },
        { text: 'Reference Interval', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Arbitrary displaced label', x: 0.1 },
        { text: '7.3', x: 0.38 },
        { text: 'mg/L', x: 0.62 },
        { text: '0-10', x: 0.8 },
        { text: 'ADMIN-L', x: 0.02 },
        { text: 'ADMIN-R', x: 0.94 },
      ],
    },
  ]);
  const shifted = {
    ...base,
    observations: base.observations.map((observation) => ({
      ...observation,
      boundingBox: {
        ...observation.boundingBox,
        x: 0.03 + observation.boundingBox.x * 0.92,
        width: observation.boundingBox.width * 0.92,
      },
      spans: observation.spans?.map((span) => ({
        ...span,
        boundingBox:
          span.boundingBox === undefined
            ? undefined
            : {
                ...span.boundingBox,
                x: 0.03 + span.boundingBox.x * 0.92,
                width: span.boundingBox.width * 0.92,
              },
      })),
    })),
  };
  const original = extractHeaderTablePage(base).measurements[0];
  const displaced = extractHeaderTablePage(shifted).measurements[0];
  assert.equal(original?.sourceLabel, displaced?.sourceLabel);
  assert.equal(original?.valueString, displaced?.valueString);
  assert.equal(original?.unit, displaced?.unit);
  assert.equal(original?.referenceInterval, displaced?.referenceInterval);
});

test('attaches an explicit German page blood default and preserves serum label exceptions', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Analyse', x: 0.08 },
        { text: 'Ergebnis', x: 0.38 },
        { text: 'Einheit', x: 0.62 },
        { text: 'Referenzbereich', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Hämoglobin', x: 0.08, id: 'blood-label' },
        { text: '156', x: 0.38 },
        { text: 'g/l', x: 0.62 },
        { text: '135-172', x: 0.8 },
      ],
    },
    {
      y: 0.22,
      cells: [
        { text: 'Kreatinin im Serum', x: 0.08, id: 'serum-label' },
        { text: '80', x: 0.38 },
        { text: 'µmol/l', x: 0.62 },
        { text: '64-110', x: 0.8 },
      ],
    },
    {
      y: 0.9,
      cells: [
        {
          id: 'blood-default',
          text: 'Sofern nicht anders angegeben wurden die Analysen aus Blut durchgeführt.',
          x: 0.08,
          width: 0.8,
        },
      ],
    },
  ]);

  const result = extractHeaderTablePage(input);
  assert.deepEqual(
    result.measurements.map((measurement) => measurement.specimen),
    ['blood', 'serum'],
  );
  assert.equal(result.measurements[0]?.ambiguousFields.includes('specimen'), false);
  assert.equal(result.measurements[1]?.ambiguousFields.includes('specimen'), false);
  assert.equal(result.measurements[0]?.sourceIds.includes('blood-default'), true);
  assert.equal(result.measurements[1]?.sourceIds.includes('blood-default'), false);
});

test('does not assign a specimen from an unrelated blood or serum mention', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Analyse', x: 0.08 },
        { text: 'Ergebnis', x: 0.38 },
        { text: 'Einheit', x: 0.62 },
        { text: 'Referenzbereich', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Blutbild marker', x: 0.08 },
        { text: '1', x: 0.38 },
      ],
    },
    {
      y: 0.9,
      cells: [{ text: 'Reference note: serum is used in some assays.', x: 0.08, width: 0.8 }],
    },
  ]);

  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.specimen, null);
  assert.equal(result.measurements[0]?.ambiguousFields.includes('specimen'), true);
});

test('binds native table cells by column index when geometry is misleading', () => {
  const input = page([
    {
      y: 0.1,
      tableId: 'native-table',
      cells: [
        { text: 'Test', x: 0.78, columnIndex: 0 },
        { text: 'Current Result', x: 0.08, columnIndex: 1 },
        { text: 'Units', x: 0.2, columnIndex: 2 },
        { text: 'Reference Interval', x: 0.34, columnIndex: 3 },
      ],
    },
    {
      y: 0.16,
      tableId: 'native-table',
      cells: [
        { text: 'Native parent label', x: 0.78, columnIndex: 0, id: 'native-label' },
        { text: '7.3', x: 0.08, columnIndex: 1, id: 'native-value' },
        { text: 'mg/L', x: 0.2, columnIndex: 2, id: 'native-unit' },
        { text: '0-10', x: 0.34, columnIndex: 3, id: 'native-reference' },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Native parent label');
  assert.equal(result.measurements[0]?.valueString, '7.3');
  assert.equal(result.measurements[0]?.unit, 'mg/L');
  assert.equal(result.measurements[0]?.referenceInterval, '0-10');
  assert.ok(result.measurements[0]?.sourceIds.includes('native-label'));
  assert.ok(result.measurements[0]?.sourceIds.includes('native-value'));
});

test('keeps a complete loose parent label while excluding a neighboring prose parent', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Previous Result', x: 0.3 },
        { text: 'Current Result', x: 0.5 },
        { text: 'Units', x: 0.7 },
        { text: 'Reference Interval', x: 0.84 },
      ],
    },
    {
      y: 0.16,
      cells: [
        {
          text: 'Complete native parent label',
          x: 0.08,
          width: 0.2,
          id: 'parent-label',
          spans: [
            { text: 'Complete', x: 0.08, width: 0.06 },
            { text: 'native', x: 0.145, width: 0.045 },
            { text: 'parent', x: 0.195, width: 0.045 },
            { text: 'label', x: 0.235, width: 0.04 },
          ],
        },
        { text: 'unrelated prose', x: 0.34, width: 0.1, id: 'prose-parent' },
        { text: '7.3', x: 0.5, id: 'parent-value' },
        { text: 'mg/L', x: 0.7, id: 'parent-unit' },
        { text: '0-10', x: 0.84, id: 'parent-reference' },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Complete native parent label');
  assert.ok(!result.measurements[0]?.sourceLabel.includes('unrelated prose'));
  assert.ok(result.measurements[0]?.sourceIds.some((id) => id.startsWith('parent-label')));
});

test('keeps one parent observation together when span geometry jitters or reverses', () => {
  const base = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.42 },
        { text: 'Units', x: 0.65 },
        { text: 'Reference Interval', x: 0.82 },
      ],
    },
    {
      y: 0.16,
      cells: [
        {
          text: 'Alpha Beta',
          x: 0.08,
          width: 0.2,
          id: 'jittered-label',
          spans: [
            { text: 'Alpha', x: 0.17, width: 0.05, id: 'jittered-label-a' },
            { text: 'Beta', x: 0.08, width: 0.04, id: 'jittered-label-b' },
          ],
        },
        { text: '7.3', x: 0.42, id: 'jittered-value' },
        { text: 'mg/L', x: 0.65, id: 'jittered-unit' },
        { text: '0-10', x: 0.82, id: 'jittered-reference' },
      ],
    },
  ]);
  const input = {
    ...base,
    observations: base.observations.map((observation) =>
      observation.id === 'jittered-label'
        ? {
            ...observation,
            spans: observation.spans?.map((span, index) => ({
              ...span,
              boundingBox:
                span.boundingBox === undefined
                  ? undefined
                  : { ...span.boundingBox, y: index === 0 ? 0.164 : 0.159 },
            })),
          }
        : observation,
    ),
  };
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Alpha Beta');
  assert.equal(result.measurements[0]?.valueString, '7.3');
  assert.deepEqual(result.measurements[0]?.sourceIds.slice(0, 3), [
    'jittered-label',
    'jittered-label-a',
    'jittered-label-b',
  ]);
});

test('reconstructs split unit and reference headers under displaced scaled geometry', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'TYRIMAS', x: 0.08 },
        { text: 'Tyrimo', x: 0.36 },
        { text: 'Matavimo', x: 0.58 },
        { text: 'Normų', x: 0.75 },
      ],
    },
    {
      y: 0.115,
      cells: [
        { text: 'rezultatas', x: 0.36 },
        { text: 'vienetas', x: 0.58 },
        { text: 'ribos', x: 0.75 },
      ],
    },
    {
      y: 0.18,
      cells: [
        { text: 'Synthetic marker', x: 0.08, id: 'split-label' },
        { text: '8,2', x: 0.36, id: 'split-value' },
        { text: 'mg/L', x: 0.58, id: 'split-unit' },
        { text: '0-10', x: 0.75, id: 'split-reference' },
      ],
    },
  ]);
  const shifted = {
    ...input,
    observations: input.observations.map((observation) => ({
      ...observation,
      boundingBox: {
        ...observation.boundingBox,
        x: 0.04 + observation.boundingBox.x * 0.88,
        y: 0.02 + observation.boundingBox.y * 0.9,
        width: observation.boundingBox.width * 0.88,
        height: observation.boundingBox.height * 0.9,
      },
      spans: observation.spans?.map((span) => ({
        ...span,
        boundingBox:
          span.boundingBox === undefined
            ? undefined
            : {
                ...span.boundingBox,
                x: 0.04 + span.boundingBox.x * 0.88,
                y: 0.02 + span.boundingBox.y * 0.9,
                width: span.boundingBox.width * 0.88,
                height: span.boundingBox.height * 0.9,
              },
      })),
    })),
  };
  for (const candidate of [input, shifted]) {
    const result = extractHeaderTablePage(candidate);
    assert.equal(result.measurements.length, 1);
    assert.equal(result.measurements[0]?.unit, 'mg/L');
    assert.equal(result.measurements[0]?.referenceInterval, '0-10');
    assert.equal(result.measurements[0]?.valueString, '8,2');
    assert.ok(result.measurements[0]?.sourceIds.includes('split-unit'));
  }
});

test('does not join a wrapped label to a separate current header word', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current', x: 0.38 },
      ],
    },
    { y: 0.115, cells: [{ text: 'Result', x: 0.08 }] },
    {
      y: 0.18,
      cells: [
        { text: 'Wrapped label', x: 0.08 },
        { text: '8.2', x: 0.38 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.counts.headerRows, 0);
  assert.equal(result.measurements.length, 0);
});

test('keeps a long label inside the gap before a reordered next column', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Reference Interval', x: 0.34 },
        { text: 'Current Result', x: 0.54 },
        { text: 'Units', x: 0.78 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Synthetic long label', x: 0.08, width: 0.19 },
        { text: 'continuation', x: 0.28, width: 0.05 },
        { text: '0-10', x: 0.34 },
        { text: '8.2', x: 0.54 },
        { text: 'mg/L', x: 0.78 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Synthetic long label continuation');
  assert.equal(result.measurements[0]?.valueString, '8.2');
  assert.equal(result.measurements[0]?.unit, 'mg/L');
  assert.equal(result.measurements[0]?.referenceInterval, '0-10');
});

test('joins a bounded wrapped label continuation without taking a neighboring result row', () => {
  const header = {
    y: 0.1,
    cells: [
      { text: 'Test', x: 0.08, height: 0.01 },
      { text: 'Current Result', x: 0.38, height: 0.01 },
      { text: 'Units', x: 0.62, height: 0.01 },
      { text: 'Reference Interval', x: 0.8, height: 0.01 },
    ],
  };
  const wrapped = page([
    header,
    {
      y: 0.16,
      cells: [
        { text: 'Wrapped label (', x: 0.08, height: 0.01 },
        { text: '8.2', x: 0.38, height: 0.01 },
        { text: 'mg/L', x: 0.62, height: 0.01 },
        { text: '0-10', x: 0.8, height: 0.01 },
      ],
    },
    { y: 0.172, cells: [{ text: 'continuation', x: 0.08, height: 0.01 }] },
  ]);
  const wrappedResult = extractHeaderTablePage(wrapped);
  assert.equal(wrappedResult.measurements.length, 1);
  assert.equal(wrappedResult.measurements[0]?.sourceLabel, 'Wrapped label ( continuation');

  const neighboring = page([
    header,
    {
      y: 0.16,
      cells: [
        { text: 'First wrapped', x: 0.08, height: 0.01 },
        { text: '8.2', x: 0.38, height: 0.01 },
      ],
    },
    {
      y: 0.172,
      cells: [
        { text: 'Neighbor result', x: 0.08, height: 0.01 },
        { text: '9.1', x: 0.38, height: 0.01 },
      ],
    },
  ]);
  const neighboringResult = extractHeaderTablePage(neighboring);
  assert.deepEqual(
    neighboringResult.measurements.map((measurement) => [
      measurement.sourceLabel,
      measurement.valueString,
    ]),
    [
      ['First wrapped', '8.2'],
      ['Neighbor result', '9.1'],
    ],
  );
});

test('keeps a leading standalone flag between the label and current result', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Analyse', x: 0.08 },
        { text: 'Ergebnis', x: 0.38 },
        { text: 'Einheit', x: 0.62 },
        { text: 'Referenzbereich', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Synthetic flagged result', x: 0.08 },
        { text: 'L', x: 0.3 },
        { text: '11', x: 0.38 },
        { text: '%', x: 0.62 },
        { text: '12-15', x: 0.8 },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'Synthetic flagged result');
  assert.equal(result.measurements[0]?.valueString, '11');
  assert.equal(result.measurements[0]?.flag, 'L');
});

test('joins vertically continued unit fragments only when layout marks a token continuation', () => {
  const base = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
        { text: 'Units', x: 0.62 },
        { text: 'Reference Interval', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Split unit', x: 0.08 },
        { text: '8.2', x: 0.38 },
        { text: 'mL/min/1.7', x: 0.62, id: 'unit-first' },
        { text: '0-10', x: 0.8 },
      ],
    },
  ]);
  const first = base.observations.find((observation) => observation.id === 'unit-first');
  assert.ok(first);
  const continuation = {
    ...first,
    id: 'unit-second',
    text: '3 m^2',
    boundingBox: { ...first.boundingBox, y: 0.169 },
    spans: first.spans?.map((span) => ({
      ...span,
      id: 'unit-second-span',
      parentObservationId: 'unit-second',
      text: '3 m^2',
      boundingBox: span.boundingBox === undefined ? undefined : { ...span.boundingBox, y: 0.169 },
    })),
  };
  const result = extractHeaderTablePage({
    ...base,
    observations: [...base.observations, continuation],
  });
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.unit, 'mL/min/1.73 m^2');
});

test('defers prose fragmented across measurement columns', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.38 },
        { text: 'Units', x: 0.62 },
        { text: 'Reference Interval', x: 0.8 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'Explanatory row', x: 0.08 },
        { text: 'This is prose.', x: 0.38 },
        { text: 'continued prose,', x: 0.62 },
        { text: 'and more prose', x: 0.8 },
      ],
    },
  ]);
  assert.equal(extractHeaderTablePage(input).measurements.length, 0);
});

test('keeps a standalone label token when it is not adjacent to the result', () => {
  const input = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.08 },
        { text: 'Current Result', x: 0.5 },
      ],
    },
    {
      y: 0.16,
      cells: [
        { text: 'H', x: 0.08, id: 'single-label' },
        { text: '7.3', x: 0.5, id: 'single-value' },
      ],
    },
  ]);
  const result = extractHeaderTablePage(input);
  assert.equal(result.measurements.length, 1);
  assert.equal(result.measurements[0]?.sourceLabel, 'H');
  assert.equal(result.measurements[0]?.flag, null);
});

test('aggregates pages without changing source page provenance', () => {
  const first = page([
    {
      y: 0.1,
      cells: [
        { text: 'Test', x: 0.1 },
        { text: 'Current Result', x: 0.4 },
      ],
    },
    {
      y: 0.2,
      cells: [
        { text: 'First', x: 0.1 },
        { text: '1', x: 0.4 },
      ],
    },
  ]);
  const second = {
    ...first,
    pageIndex: 1,
    observations: first.observations.map((item) => ({ ...item, pageIndex: 1 })),
  };
  const result = extractHeaderTablePages([first, second]);
  assert.deepEqual(
    result.measurements.map((measurement) => measurement.page),
    [1, 2],
  );
});
