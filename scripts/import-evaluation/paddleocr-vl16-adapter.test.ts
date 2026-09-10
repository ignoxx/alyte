import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  deduplicateOverlappingMeasurements,
  parsePaddleOcrPage,
  runPaddleOcrAdapter,
} from './paddleocr-vl16-adapter';

test('admits scalar and bounded candidates while preserving explicit page context', () => {
  const parsed = parsePaddleOcrPage(
    [
      'Date Collected: 03/07/2026',
      'Synthetic Panel',
      'Alpha Marker 12 mg/dL 1-20',
      'Beta Marker <4.5 ug/mL <=10',
    ].join('\n'),
    3,
  );

  assert.deepEqual(
    parsed.measurements.map((measurement) => ({
      label: measurement.sourceLabel,
      value: measurement.valueString,
      type: measurement.valueType,
      parsed: measurement.parsedValue,
      comparator: measurement.comparator,
      unit: measurement.unit,
      referenceInterval: measurement.referenceInterval,
      date: measurement.collectionDate,
      page: measurement.page,
      location: measurement.location,
    })),
    [
      {
        label: 'Alpha Marker',
        value: '12',
        type: 'numeric',
        parsed: 12,
        comparator: null,
        unit: 'mg/dL',
        referenceInterval: '1-20',
        date: '2026-03-07',
        page: 3,
        location: null,
      },
      {
        label: 'Beta Marker',
        value: '<4.5',
        type: 'bounded',
        parsed: 4.5,
        comparator: '<',
        unit: 'ug/mL',
        referenceInterval: '<=10',
        date: '2026-03-07',
        page: 3,
        location: null,
      },
    ],
  );
  assert.deepEqual(parsed.measurements[0]?.sourceIds, ['p3-line3']);
  assert.deepEqual(parsed.measurements[0]?.unresolvedFields, ['location']);
});

test('recognizes generic compound laboratory units without a biomarker mapping', () => {
  const parsed = parsePaddleOcrPage(
    ['Gamma Marker 2 U/L 1-3', 'Delta Marker 3 nmol/min/mL 0-4'].join('\n'),
    2,
  );

  assert.deepEqual(
    parsed.measurements.map((measurement) => [measurement.sourceLabel, measurement.unit]),
    [
      ['Gamma Marker', 'U/L'],
      ['Delta Marker', 'nmol/min/mL'],
    ],
  );
});

test('handles flattened rows and text status without turning thresholds into measurements', () => {
  const parsed = parsePaddleOcrPage(
    [
      'Date Collected: 01/02/2026',
      'First Marker 1 mg/dL 0-2 Second Marker 2 Low ng/mL >1 Third Marker Test not performed. Reason withheld.',
      'Note: a threshold of 99 nmol/L may appear in this explanatory text.',
    ].join('\n'),
    5,
  );

  assert.deepEqual(
    parsed.measurements.map((measurement) => ({
      label: measurement.sourceLabel,
      value: measurement.valueString,
      type: measurement.valueType,
      flag: measurement.flag,
      unit: measurement.unit,
      referenceInterval: measurement.referenceInterval,
    })),
    [
      {
        label: 'First Marker',
        value: '1',
        type: 'numeric',
        flag: null,
        unit: 'mg/dL',
        referenceInterval: '0-2',
      },
      {
        label: 'Second Marker',
        value: '2',
        type: 'numeric',
        flag: 'Low',
        unit: 'ng/mL',
        referenceInterval: '>1',
      },
      {
        label: 'Third Marker',
        value: 'Test not performed. Reason withheld.',
        type: 'text',
        flag: null,
        unit: null,
        referenceInterval: null,
      },
    ],
  );
  assert.equal(parsed.admittedNumericCount, 2);
  assert.equal(parsed.admittedTextCount, 1);
  assert.equal(
    parsed.measurements.some((measurement) => measurement.sourceLabel.startsWith('Note')),
    false,
  );
});

test('admits structurally bounded unitless and categorical rows without a label catalogue', () => {
  const parsed = parsePaddleOcrPage(
    ['MCV 91 MCH 30', 'ABO Grouping A', 'Rh Factor Positive', 'This test may show 7'].join('\n'),
    8,
  );

  assert.deepEqual(
    parsed.measurements.map((measurement) => [
      measurement.sourceLabel,
      measurement.valueString,
      measurement.valueType,
      measurement.unit,
    ]),
    [
      ['MCV', '91', 'numeric', null],
      ['MCH', '30', 'numeric', null],
      ['ABO Grouping', 'A', 'categorical', null],
      ['Rh Factor', 'Positive', 'categorical', null],
    ],
  );
});

test('filters identifier rows while preserving a structurally shaped unitless result', () => {
  const parsed = parsePaddleOcrPage(
    ['Patient ID: 47', 'Specimen ID: 12', 'Page 3', 'Synthetic Marker 12'].join('\n'),
    4,
  );

  assert.deepEqual(
    parsed.measurements.map((measurement) => [measurement.sourceLabel, measurement.valueString]),
    [['Synthetic Marker', '12']],
  );
});

test('deduplicates only overlapping page captures and retains source provenance', () => {
  const first = parsePaddleOcrPage('Marker 12 mg/dL 1-20', 8).measurements[0]!;
  const second = { ...first, id: 'p8-m099', sourceIds: ['p8-line44'] };
  const otherPage = { ...first, id: 'p9-m001', page: 9, sourceIds: ['p9-line1'] };

  const merged = deduplicateOverlappingMeasurements([first, second, otherPage], new Set([8]));
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0]?.sourceIds, ['p8-line1']);
  assert.equal(merged[0]?.id, 'p8-m001');
  assert.equal(merged[1]?.id, 'p9-m001');
  assert.deepEqual(merged[1]?.sourceIds, ['p9-line1']);
});

test('propagates a unique page date and tags band provenance during adapter merge', () => {
  const privateRoot = mkdtempSync('/private/tmp/paddleocr-adapter-test-');
  try {
    const reportPath = join(privateRoot, 'report.pdf');
    const bandOnePath = join(privateRoot, 'paddleocr-vl16-q8-en-page08-small1-v1.raw.txt');
    const bandTwoPath = join(privateRoot, 'paddleocr-vl16-q8-en-page08-small2-v1.raw.txt');
    const outputPath = join(privateRoot, 'run', 'en.json');
    writeFileSync(reportPath, 'synthetic report');
    writeFileSync(
      bandOnePath,
      ['Date Collected: 03/07/2026', 'Synthetic Marker 12 mg/dL 1-20'].join('\n'),
    );
    writeFileSync(bandTwoPath, 'Synthetic Marker 12 mg/dL 1-20');

    const result = runPaddleOcrAdapter({
      reportPath,
      reportId: 'en',
      outputPath,
      privateRoot,
      rawPaths: [
        { page: 8, path: bandOnePath },
        { page: 8, path: bandTwoPath },
      ],
      page: 8,
    });

    assert.equal(result.measurements.length, 1);
    assert.equal(result.measurements[0]?.collectionDate, '2026-03-07');
    assert.deepEqual(result.measurements[0]?.sourceIds, ['p8-small1-line2']);
    assert.equal(result.pipeline.version, 'paddleocr-vl16-text-adapter.v2');
    assert.deepEqual(
      (result.pipeline.configuration.rawFiles as readonly { file: string }[]).map(
        (rawFile) => rawFile.file,
      ),
      [
        'paddleocr-vl16-q8-en-page08-small1-v1.raw.txt',
        'paddleocr-vl16-q8-en-page08-small2-v1.raw.txt',
      ],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(outputPath, 'utf8')).measurements,
      result.measurements,
    );
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
});
