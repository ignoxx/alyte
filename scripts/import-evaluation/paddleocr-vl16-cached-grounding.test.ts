import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationMeasurement } from './contract';
import { groundCachedProposals, visionPages } from './paddleocr-vl16-cached-grounding';

function proposal(page: number, label: string, value: string): EvaluationMeasurement {
  return {
    id: `proposal-${page}-${label}`,
    sourceLabel: label,
    valueString: value,
    valueType: 'numeric',
    parsedValue: Number(value),
    comparator: null,
    unit: null,
    referenceInterval: null,
    flag: null,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page,
    location: null,
    ambiguousFields: [],
    unresolvedFields: [],
    sourceIds: [],
  };
}

function rawVision(observations: readonly Record<string, unknown>[]) {
  return {
    pages: [
      {
        pageIndex: 0,
        result: { observations },
      },
    ],
  };
}

function cell(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
): Record<string, unknown> {
  return {
    id,
    text,
    pageIndex: 0,
    structure: { kind: 'table-cell', tableId: 'table-1', rowIndex, columnIndex },
    boundingBox: { x: columnIndex === 0 ? 0.1 : 0.5, y: 0.2, width: 0.2, height: 0.03 },
  };
}

test('admits a Paddle row only when native Vision supplies the same-page row', () => {
  const pages = visionPages(
    rawVision([
      cell('label-1', 'Vitamin D', 1, 0),
      cell('value-1', '42', 1, 1),
      cell('unit-1', 'ng/mL', 1, 2),
    ]),
  );
  const result = groundCachedProposals([proposal(1, 'Vitamin D', '42')], pages);
  assert.equal(result.measurements.length, 1);
  assert.deepEqual(result.measurements[0]?.sourceIds, ['label-1', 'unit-1', 'value-1']);
  assert.equal(result.diagnostics.rejectedByReason['label-not-found'], 0);
});

test('rejects a proposal whose label and value evidence is on another page', () => {
  const pages = visionPages(rawVision([cell('label-1', 'Vitamin D', 1, 0)]));
  const result = groundCachedProposals([proposal(2, 'Vitamin D', '42')], pages);
  assert.equal(result.measurements.length, 0);
  assert.equal(result.diagnostics.rejectedByReason['not-same-row-or-span'], 1);
});

test('rejects an ambiguous duplicate source row instead of choosing silently', () => {
  const pages = visionPages({
    pages: [
      {
        pageIndex: 0,
        result: {
          observations: [
            cell('label-1', 'Vitamin D', 1, 0),
            cell('value-1', '42', 1, 1),
            cell('label-2', 'Vitamin D', 2, 0),
            cell('value-2', '42', 2, 1),
          ],
        },
      },
    ],
  });
  const result = groundCachedProposals([proposal(1, 'Vitamin D', '42')], pages);
  assert.equal(result.measurements.length, 0);
  assert.equal(result.diagnostics.rejectedByReason['ambiguous-source-span'], 1);
});
