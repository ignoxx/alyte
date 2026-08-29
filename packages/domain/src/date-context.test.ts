import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOCRDateContexts, type OCRDateContextObservation } from './date-context.js';

function observation(
  id: string,
  text: string,
  x: number,
  y = 0.1,
  overrides: Partial<OCRDateContextObservation> = {},
): OCRDateContextObservation {
  return {
    id,
    text,
    boundingBox: { x, y, width: 0.2, height: 0.04 },
    pageIndex: 0,
    locale: 'de-DE',
    ...overrides,
  };
}

function tableObservation(
  id: string,
  text: string,
  x: number,
  tableId: string,
): OCRDateContextObservation {
  return observation(id, text, x, 0.1, {
    structure: { kind: 'table-cell', tableId, rowIndex: 0, columnIndex: 0 },
  });
}

describe('pure OCR date-context extraction', () => {
  it('keeps only explicit, unambiguous collection dates and source provenance', () => {
    const result = extractOCRDateContexts([
      observation('same-cell', 'Collected: 22.08.2026 Reported: 23.08.2026', 0.08),
    ]);

    assert.equal(result.contexts.length, 1);
    assert.deepEqual(result.contexts[0]?.collectionDate, {
      kind: 'known',
      value: '2026-08-22',
    });
    assert.equal(result.contexts[0]?.observationId, 'same-cell');
    assert.equal(result.contexts[0]?.sourceDate, '22.08.2026');
    assert.equal(result.contexts[0]?.sourceText, 'Collected: 22.08.2026 Reported: 23.08.2026');
    assert.equal(result.contexts[0]?.labelObservationId, 'same-cell');
    assert.equal(result.contexts[0]?.labelText, 'Collected: 22.08.2026 Reported: 23.08.2026');
    assert.deepEqual([...result.excludedObservationIds], ['same-cell']);
  });

  it('pairs split cells in visual order, including reversed label/date order', () => {
    const result = extractOCRDateContexts([
      observation('date-one', '22.08.2026', 0.08),
      observation('label-one', 'Collected', 0.3),
      observation('date-two', '23.08.2026', 0.52),
      observation('label-two', 'Reported', 0.74),
    ]);

    assert.deepEqual(
      result.contexts.map((context) => [
        context.observationId,
        context.collectionDate,
        context.labelObservationId,
      ]),
      [['date-one', { kind: 'known', value: '2026-08-22' }, 'label-one']],
    );
    assert.deepEqual(
      [...result.excludedObservationIds],
      ['date-one', 'label-one', 'date-two', 'label-two'],
    );
  });

  it('keeps same-row dates in separate Vision tables as separate contexts', () => {
    const result = extractOCRDateContexts([
      tableObservation('left-date', 'Collection date 22.08.2026', 0.08, 'left-table'),
      tableObservation('right-date', 'Collection date 23.08.2026', 0.6, 'right-table'),
    ]);

    assert.deepEqual(
      result.contexts.map((context) => [context.observationId, context.collectionDate]),
      [
        ['left-date', { kind: 'known', value: '2026-08-22' }],
        ['right-date', { kind: 'known', value: '2026-08-23' }],
      ],
    );
    assert.equal(result.contexts[0]?.scopeKey === result.contexts[1]?.scopeKey, false);
    assert.deepEqual(result.collectionDate, { kind: 'missing' });
  });

  it('uses separate horizontal label cells as event boundaries', () => {
    const result = extractOCRDateContexts([
      observation('left-date', '22.08.2026', 0.08),
      observation('left-label', 'Collected', 0.3),
      observation('right-date', '23.08.2026', 0.52),
      observation('right-label', 'Collected', 0.74),
    ]);

    assert.deepEqual(
      result.contexts.map((context) => [context.observationId, context.collectionDate]),
      [
        ['left-date', { kind: 'known', value: '2026-08-22' }],
        ['right-date', { kind: 'known', value: '2026-08-23' }],
      ],
    );
  });

  it('keeps an equal collection/report label tie ambiguous', () => {
    const result = extractOCRDateContexts([
      observation('collection-label', 'Collected', 0.1),
      observation('date', '22.08.2026', 0.35),
      observation('report-label', 'Reported', 0.6),
    ]);

    assert.equal(result.contexts[0]?.ambiguous, true);
    assert.deepEqual(result.contexts[0]?.collectionDate, { kind: 'missing' });
  });

  it('does not substitute non-collection, conflicting, or unlabeled dates', () => {
    const cases = [
      {
        name: 'report-and-birth',
        observations: [
          observation('header', 'Report date 2026-08-28 Date of birth 1990-01-01', 0.08),
        ],
        contexts: 0,
      },
      {
        name: 'conflict',
        observations: [observation('header', 'Collected 22.08.2026 Collected 23.08.2026', 0.08)],
        contexts: 2,
      },
      { name: 'unlabeled', observations: [observation('header', '22.08.2026', 0.08)], contexts: 0 },
    ] as const;

    for (const testCase of cases) {
      const result = extractOCRDateContexts(testCase.observations);
      assert.equal(result.contexts.length, testCase.contexts, testCase.name);
      assert.deepEqual(result.collectionDate, { kind: 'missing' }, testCase.name);
    }
  });
});
