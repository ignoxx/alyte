import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisionPage } from './qwen35-grounding';
import { renderVisionPageToPlainText } from './vision-text-layout';

function cell(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
  y: number,
  x: number,
): Record<string, unknown> {
  return {
    id,
    text,
    structure: { kind: 'table-cell', tableId: 'synthetic-table', rowIndex, columnIndex },
    boundingBox: { x, y, width: 0.1, height: 0.02 },
  };
}

function page(observations: readonly Record<string, unknown>[]): VisionPage {
  return { pageIndex: 0, observations: observations as VisionPage['observations'] };
}

test('renders shuffled table cells by native row and column while retaining prose and footnotes', () => {
  const result = renderVisionPageToPlainText(
    page([
      cell('value-2', '12', 1, 1, 0.3, 0.7),
      {
        id: 'footnote',
        text: 'Footnote: source guidance',
        boundingBox: { x: 0.1, y: 0.8, width: 0.3, height: 0.02 },
      },
      cell('label-1', 'Alpha', 1, 0, 0.3, 0.1),
      cell('unit-0', 'Unit', 0, 2, 0.2, 0.8),
      cell('label-0', 'Test', 0, 0, 0.2, 0.1),
      cell('result-0', 'Current Result', 0, 1, 0.2, 0.5),
      cell('unit-1', 'mg/L', 1, 2, 0.3, 0.8),
    ]),
  );

  const lines = result.text.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0]?.startsWith('Test'));
  assert.ok(lines[0]?.includes('Current Result'));
  assert.ok(lines[0]?.includes('Unit'));
  assert.ok(lines[1]?.startsWith('Alpha'));
  assert.ok(lines[1]?.includes('12'));
  assert.ok(lines[1]?.includes('mg/L'));
  assert.ok(lines[2]?.includes('Footnote: source guidance'));
  for (const text of [
    'Test',
    'Current Result',
    'Unit',
    'Alpha',
    '12',
    'mg/L',
    'Footnote: source guidance',
  ]) {
    assert.ok(result.text.includes(text), `missing ${text}`);
  }
  assert.equal(result.diagnostics.observationCount, 7);
  assert.equal(result.diagnostics.renderedObservationCount, 7);
  assert.equal(result.diagnostics.structuredTableCount, 1);
  assert.equal(result.diagnostics.fallbackLineCount, 1);
  assert.equal(result.diagnostics.collisions.length, 0);
});

test('keeps duplicate table placements and reports a collision without dropping either source text', () => {
  const result = renderVisionPageToPlainText(
    page([
      cell('first', 'First', 0, 0, 0.2, 0.1),
      cell('duplicate', 'Second', 0, 0, 0.2, 0.1),
      cell('result', '7', 0, 1, 0.2, 0.5),
    ]),
  );

  assert.match(result.text, /First \| Second/u);
  assert.ok(result.text.includes('7'));
  assert.equal(result.diagnostics.structuredCellCollisionCount, 1);
  assert.deepEqual(result.diagnostics.collisions, [
    {
      kind: 'structured-cell',
      tableId: 'synthetic-table',
      rowIndex: 0,
      columnIndex: 0,
      observationCount: 2,
    },
  ]);
});

test('uses stable physical y/x ordering for unstructured observations and retains missing geometry', () => {
  const result = renderVisionPageToPlainText(
    page([
      {
        id: 'right',
        text: 'Right',
        boundingBox: { x: 0.5, y: 0.2, width: 0.1, height: 0.02 },
      },
      { id: 'no-box', text: 'No box' },
      {
        id: 'left',
        text: 'Left',
        boundingBox: { x: 0.1, y: 0.2, width: 0.1, height: 0.02 },
      },
      {
        id: 'next-line',
        text: 'Next line',
        boundingBox: { x: 0.1, y: 0.5, width: 0.1, height: 0.02 },
      },
    ]),
  );

  assert.deepEqual(result.text.split('\n'), ['Left   Right', 'Next line', 'No box']);
  assert.equal(result.diagnostics.observationCount, 4);
  assert.equal(result.diagnostics.unpositionedObservationCount, 1);
  assert.equal(result.diagnostics.emptyObservationCount, 0);
});

test('renders empty and unpositioned structured cells instead of filtering them', () => {
  const result = renderVisionPageToPlainText(
    page([
      {
        id: 'empty',
        text: '',
        structure: { kind: 'table-cell', tableId: 'table', rowIndex: 0 },
      },
      {
        id: 'value',
        text: 'Value',
        structure: { kind: 'table-cell', tableId: 'table', rowIndex: 0, columnIndex: 1 },
        boundingBox: { x: 0.5, y: 0.2, width: 0.1, height: 0.02 },
      },
    ]),
  );

  assert.ok(result.text.includes('Value'));
  assert.equal(result.diagnostics.observationCount, 2);
  assert.equal(result.diagnostics.renderedObservationCount, 2);
  assert.equal(result.diagnostics.emptyObservationCount, 1);
  assert.equal(result.diagnostics.unpositionedStructuredObservationCount, 1);
});
