import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySourceContext } from './source-context';
import type { VisionObservation, VisionPage } from './qwen35-grounding';

function observation(
  id: string,
  text: string,
  x: number,
  y: number,
  extra: Partial<VisionObservation> = {},
): VisionObservation {
  return {
    id,
    text,
    pageIndex: 0,
    boundingBox: { x, y, width: 0.08, height: 0.02 },
    ...extra,
  };
}

function page(observations: readonly VisionObservation[]): VisionPage {
  return { pageIndex: 0, observations };
}

function looseLaboratoryHeaders(y = 0.3): VisionObservation[] {
  return [
    observation('test-header', 'Test', 0.07, y),
    observation('result-header', 'Current Result', 0.37, y),
    observation('unit-header', 'Unit', 0.62, y),
    observation('reference-header', 'Reference Interval', 0.78, y),
  ];
}

function structuredHeader(
  id: string,
  text: string,
  columnIndex: number,
  tableId = 'table-1',
): VisionObservation {
  return observation(id, text, 0.1 + columnIndex * 0.2, 0.2, {
    structure: { kind: 'table-cell', tableId, rowIndex: 0, columnIndex },
  });
}

test('recognizes an unstructured laboratory header row by geometry', () => {
  const result = classifySourceContext(page(looseLaboratoryHeaders()));
  assert.equal(result.kind, 'laboratory-table');
  assert.equal(result.laboratoryEvidence.structuredTableCount, 0);
  assert.equal(result.laboratoryEvidence.unstructuredHeaderGroupCount, 1);
  assert.equal(result.laboratoryEvidence.explicitSectionHeadingCount, 0);
});

test('keeps multiline and displaced headers in one geometry-owned group', () => {
  const observations = [
    observation('test-header', 'Test', 0.02, 0.31, {
      boundingBox: { x: 0.02, y: 0.31, width: 0.12, height: 0.012 },
    }),
    observation('result-header', 'Current Result', 0.39, 0.307, {
      boundingBox: { x: 0.39, y: 0.307, width: 0.2, height: 0.018 },
    }),
    observation('unit-header-line-1', 'Matavimo', 0.71, 0.3, {
      boundingBox: { x: 0.71, y: 0.3, width: 0.1, height: 0.012 },
    }),
    observation('unit-header-line-2', 'vienetas', 0.71, 0.315, {
      boundingBox: { x: 0.71, y: 0.315, width: 0.1, height: 0.012 },
    }),
    observation('reference-header', 'Normų ribos', 0.87, 0.304, {
      boundingBox: { x: 0.87, y: 0.304, width: 0.1, height: 0.018 },
    }),
  ];
  const result = classifySourceContext(page(observations));
  assert.equal(result.kind, 'laboratory-table');
  assert.equal(result.laboratoryEvidence.unstructuredHeaderGroupCount, 1);
});

test('recognizes a structured table without requiring a unit-bearing result row', () => {
  const result = classifySourceContext(
    page([
      structuredHeader('test', 'Tyrimas', 0),
      structuredHeader('result', 'Tyrimo rezultatas', 1),
      structuredHeader('unit', 'Matavimo vienetas', 2),
      structuredHeader('reference', 'Referenzbereich', 3),
      observation('row-label', 'Unbekannter Marker', 0.1, 0.3, {
        structure: { kind: 'table-cell', tableId: 'table-1', rowIndex: 1, columnIndex: 0 },
      }),
      observation('row-value', 'Detected', 0.3, 0.3, {
        structure: { kind: 'table-cell', tableId: 'table-1', rowIndex: 1, columnIndex: 1 },
      }),
    ]),
  );
  assert.equal(result.kind, 'laboratory-table');
  assert.equal(result.laboratoryEvidence.structuredTableCount, 1);
});

test('does not admit a guidance table whose result header is not current', () => {
  const result = classifySourceContext(
    page([
      structuredHeader('test', 'Test', 0, 'guidance'),
      structuredHeader('result', 'Target Result', 1, 'guidance'),
      structuredHeader('unit', 'Unit', 2, 'guidance'),
      structuredHeader('reference', 'Reference Interval', 3, 'guidance'),
    ]),
  );
  assert.deepEqual(result.laboratoryEvidence, {
    structuredTableCount: 0,
    unstructuredHeaderGroupCount: 0,
    explicitSectionHeadingCount: 0,
  });
  assert.equal(result.kind, 'unknown');
});

test('does not use a previous-result column as the current-result signal', () => {
  const result = classifySourceContext(
    page([
      observation('test-header', 'Test', 0.07, 0.3),
      observation('previous-header', 'Previous Result', 0.37, 0.3),
      observation('unit-header', 'Unit', 0.62, 0.3),
      observation('reference-header', 'Reference Interval', 0.78, 0.3),
    ]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.laboratoryEvidence.unstructuredHeaderGroupCount, 0);
});

test('keeps an MRI page with a German laboratory section heading out of imaging-only admission', () => {
  const result = classifySourceContext(
    page([
      observation('imaging-heading', 'MRI Befund', 0.1, 0.1),
      observation('laboratory-heading', 'Blutbericht', 0.1, 0.2),
    ]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.laboratoryEvidence.explicitSectionHeadingCount, 1);
  assert.equal(result.imagingEvidence.explicitHeadingCount, 1);
});

test('does not turn a laboratory section heading alone into a positive table signal', () => {
  const result = classifySourceContext(
    page([observation('laboratory-heading', 'Laboratory report', 0.1, 0.1)]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.laboratoryEvidence.explicitSectionHeadingCount, 1);
});

test('applies the previous-result exclusion to the Lithuanian header wording', () => {
  const result = classifySourceContext(
    page([
      observation('test-header', 'Tyrimas', 0.07, 0.3),
      observation('previous-header', 'Ankstesnis tyrimo rezultatas', 0.37, 0.3),
      observation('unit-header', 'Matavimo vienetas', 0.62, 0.3),
      observation('reference-header', 'Normų ribos', 0.78, 0.3),
    ]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.laboratoryEvidence.unstructuredHeaderGroupCount, 0);
});

test('classifies an explicit MRI exam heading as imaging narrative', () => {
  const result = classifySourceContext(
    page([
      observation('heading', 'MRI findings', 0.1, 0.1),
      observation('body', 'A 12 mm lesion is described in the report.', 0.1, 0.2),
    ]),
  );
  assert.equal(result.kind, 'imaging-narrative');
  assert.equal(result.imagingEvidence.explicitHeadingCount, 1);
});

test('recognizes a full-name radiology heading without relying on a report identifier', () => {
  const result = classifySourceContext(
    page([observation('heading', 'Magnetic Resonance Imaging', 0.1, 0.1)]),
  );
  assert.equal(result.kind, 'imaging-narrative');
  assert.equal(result.imagingEvidence.explicitHeadingCount, 1);
});

test('laboratory evidence wins when an imaging heading shares the page', () => {
  const result = classifySourceContext(
    page([observation('heading', 'MRI findings', 0.1, 0.1), ...looseLaboratoryHeaders(0.45)]),
  );
  assert.equal(result.kind, 'laboratory-table');
  assert.equal(result.imagingEvidence.explicitHeadingCount, 1);
});

test('does not treat an MRI-named analyte row as an imaging heading', () => {
  const result = classifySourceContext(
    page([observation('label', 'MRI marker', 0.1, 0.3), observation('value', '2.0', 0.4, 0.3)]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.imagingEvidence.explicitHeadingCount, 0);
});

test('does not combine headers separated by a row-sized vertical gap', () => {
  const result = classifySourceContext(
    page([
      observation('test-header', 'Test', 0.1, 0.1),
      observation('result-header', 'Current Result', 0.4, 0.1),
      observation('reference-header', 'Reference Interval', 0.8, 0.2),
    ]),
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(result.laboratoryEvidence.unstructuredHeaderGroupCount, 0);
});
