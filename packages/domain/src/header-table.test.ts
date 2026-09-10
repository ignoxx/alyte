import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractHeaderTablePage,
  extractHeaderTablePages,
  type HeaderTableObservation,
  type HeaderTablePage,
} from './header-table';

const box = (x: number, y: number, width = 0.12, height = 0.025) => ({
  x,
  y,
  width,
  height,
});

function cell(
  id: string,
  text: string,
  pageIndex: number,
  rowIndex: number,
  columnIndex: number,
  x: number,
  y: number,
): HeaderTableObservation {
  return {
    id,
    text,
    boundingBox: box(x, y),
    pageIndex,
    structure: {
      kind: 'table-cell',
      tableId: 'results',
      rowIndex,
      columnIndex,
    },
  };
}

function pageWithRows(options: {
  readonly pageIndex?: number;
  readonly dateText?: string;
  readonly specimenSentence?: string;
  readonly rows: readonly {
    readonly label: string;
    readonly value: string;
    readonly unit?: string;
    readonly reference?: string;
  }[];
}): HeaderTablePage {
  const pageIndex = options.pageIndex ?? 0;
  const observations: HeaderTableObservation[] = [];
  if (options.dateText !== undefined) {
    observations.push({
      id: `date-${pageIndex}`,
      text: options.dateText,
      boundingBox: box(0.05, 0.02, 0.4),
      pageIndex,
    });
  }
  if (options.specimenSentence !== undefined) {
    observations.push({
      id: `specimen-${pageIndex}`,
      text: options.specimenSentence,
      boundingBox: box(0.05, 0.055, 0.75),
      pageIndex,
    });
  }

  const headerY = 0.1;
  observations.push(
    cell(`h-label-${pageIndex}`, 'Test', pageIndex, 0, 0, 0.05, headerY),
    cell(`h-value-${pageIndex}`, 'Current result and flag', pageIndex, 0, 1, 0.5, headerY),
    cell(`h-unit-${pageIndex}`, 'Units', pageIndex, 0, 2, 0.65, headerY),
    cell(`h-ref-${pageIndex}`, 'Reference interval', pageIndex, 0, 3, 0.78, headerY),
  );

  options.rows.forEach((row, index) => {
    const y = 0.14 + index * 0.04;
    observations.push(
      cell(`r${index}-label-${pageIndex}`, row.label, pageIndex, index + 1, 0, 0.05, y),
      cell(`r${index}-value-${pageIndex}`, row.value, pageIndex, index + 1, 1, 0.5, y),
      cell(`r${index}-unit-${pageIndex}`, row.unit ?? '', pageIndex, index + 1, 2, 0.65, y),
      cell(`r${index}-ref-${pageIndex}`, row.reference ?? '', pageIndex, index + 1, 3, 0.78, y),
    );
  });
  return { pageIndex, width: 1, height: 1, observations };
}

test('extracts numeric, bounded, and categorical source fields with provenance', () => {
  const result = extractHeaderTablePage(
    pageWithRows({
      dateText: 'Collection date: 2025-02-03',
      rows: [
        { label: 'LDL cholesterol', value: '5,2 H', unit: 'mmol/L', reference: '<3.0' },
        { label: 'Vitamin D', value: '<20', unit: 'ng/mL', reference: '20-50' },
        { label: 'Hepatitis B', value: 'Negative', reference: 'Negative' },
      ],
    }),
  );

  assert.equal(result.measurements.length, 3);
  assert.deepEqual(
    result.measurements.map(({ sourceLabel, valueType, parsedValue, comparator, flag }) => ({
      sourceLabel,
      valueType,
      parsedValue,
      comparator,
      flag,
    })),
    [
      {
        sourceLabel: 'LDL cholesterol',
        valueType: 'numeric',
        parsedValue: 5.2,
        comparator: null,
        flag: 'H',
      },
      {
        sourceLabel: 'Vitamin D',
        valueType: 'bounded',
        parsedValue: 20,
        comparator: '<',
        flag: null,
      },
      {
        sourceLabel: 'Hepatitis B',
        valueType: 'categorical',
        parsedValue: 'Negative',
        comparator: null,
        flag: null,
      },
    ],
  );
  assert.equal(result.measurements[0]?.collectionDate, '2025-02-03');
  assert.equal(result.measurements[0]?.unit, 'mmol/L');
  assert.equal(result.measurements[0]?.referenceInterval, '<3.0');
  assert.deepEqual(result.measurements[0]?.ambiguousFields, ['specimen']);
  assert.deepEqual(result.measurements[0]?.sourceIds, [
    'r0-label-0',
    'r0-value-0',
    'r0-unit-0',
    'r0-ref-0',
    'date-0',
  ]);
  assert.deepEqual(result.measurements[0]?.labelSourceIds, ['r0-label-0']);
  assert.deepEqual(result.measurements[0]?.valueSourceIds, ['r0-value-0']);
  assert.deepEqual(result.measurements[0]?.unitSourceIds, ['r0-unit-0']);
  assert.deepEqual(result.measurements[0]?.referenceIntervalSourceIds, ['r0-ref-0']);
  assert.deepEqual(result.measurements[0]?.flagSourceIds, ['r0-value-0']);
  assert.deepEqual(result.measurements[0]?.collectionDateSourceIds, ['date-0']);
});

test('respects locale when resolving ambiguous slash collection dates', () => {
  const page = pageWithRows({
    dateText: 'Date collected: 02/03/2024',
    rows: [{ label: 'Glucose', value: '5.0', unit: 'mmol/L', reference: '3.9-5.5' }],
  });

  assert.equal(
    extractHeaderTablePage(page, { dateLocale: 'en-US' }).measurements[0]?.collectionDate,
    '2024-02-03',
  );
  assert.equal(
    extractHeaderTablePage(page, { dateLocale: 'de-DE' }).measurements[0]?.collectionDate,
    '2024-03-02',
  );
});

test('keeps explicit and page-level specimen evidence source-linked', () => {
  const result = extractHeaderTablePage(
    pageWithRows({
      dateText: 'Collection date: 2025-02-03',
      specimenSentence: 'Sofern nicht anders angegeben, wurden die Analysen aus Blut durchgeführt.',
      rows: [
        { label: 'Creatinine serum', value: '82', unit: 'µmol/L', reference: '45-90' },
        { label: 'Glucose', value: '5.1', unit: 'mmol/L', reference: '3.9-5.5' },
      ],
    }),
  );

  assert.equal(result.measurements[0]?.specimen, 'serum');
  assert.deepEqual(result.measurements[0]?.specimenSourceIds, ['r0-label-0']);
  assert.deepEqual(result.measurements[0]?.ambiguousFields, []);
  assert.equal(result.measurements[1]?.specimen, 'blood');
  assert.deepEqual(result.measurements[1]?.specimenSourceIds, ['specimen-0']);
  assert.deepEqual(result.measurements[1]?.ambiguousFields, []);
  assert.ok(result.measurements[1]?.sourceIds.includes('specimen-0'));
});

test('aggregates page measurements and counts without losing provenance', () => {
  const pageOne = pageWithRows({
    pageIndex: 0,
    dateText: 'Collection date: 2025-02-03',
    rows: [{ label: 'Ferritin', value: '40', unit: 'µg/L', reference: '15-150' }],
  });
  const pageTwo = pageWithRows({
    pageIndex: 1,
    dateText: 'Collection date: 2025-02-04',
    rows: [{ label: 'TSH', value: '2.0', unit: 'mIU/L', reference: '0.4-4.0' }],
  });
  const result = extractHeaderTablePages([pageOne, pageTwo]);
  assert.equal(result.measurements.length, 2);
  assert.equal(result.counts.pages, 2);
  assert.deepEqual(
    result.measurements.map((measurement) => measurement.ambiguousFields),
    [['specimen'], ['specimen']],
  );
});
