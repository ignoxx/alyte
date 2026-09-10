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

  it('uses the source-attributed English locale for a Labcorp-style numeric collection date', () => {
    const result = extractOCRDateContexts([
      observation('labcorp-date', 'Date Collected: 04/01/2025', 0.08, 0.1, {
        locale: 'en-US',
      }),
    ]);

    assert.deepEqual(result.collectionDate, { kind: 'known', value: '2025-04-01' });
    assert.deepEqual(result.contexts[0]?.collectionDate, {
      kind: 'known',
      value: '2025-04-01',
    });
    assert.equal(result.contexts[0]?.ambiguous, false);
  });

  it('uses an explicitly associated label locale when a date-only cell has none', () => {
    const result = extractOCRDateContexts([
      observation('label', 'Date Collected', 0.08, 0.1, { locale: 'en-US' }),
      observation('date', '04/01/2025', 0.32, 0.1, { locale: null }),
    ]);

    assert.deepEqual(result.collectionDate, { kind: 'known', value: '2025-04-01' });
    assert.equal(result.contexts[0]?.locale, 'en-US');
  });

  it('keeps an order-ambiguous numeric date missing without source locale context', () => {
    const result = extractOCRDateContexts([
      observation('unknown-locale', 'Date Collected: 04/01/2025', 0.08, 0.1, {
        locale: null,
      }),
    ]);

    assert.deepEqual(result.collectionDate, { kind: 'missing' });
    assert.equal(result.contexts[0]?.ambiguous, true);
  });

  it('recognizes explicitly labelled written English and German collection dates', () => {
    const english = extractOCRDateContexts([
      observation('english-written', 'Date Collected: April 18, 2025', 0.08, 0.1, {
        locale: 'en-US',
      }),
    ]);
    const german = extractOCRDateContexts([
      observation('german-written', 'Entnahme: 18. März 2025', 0.08, 0.1, {
        locale: 'de-DE',
      }),
    ]);

    assert.deepEqual(english.collectionDate, { kind: 'known', value: '2025-04-18' });
    assert.deepEqual(german.collectionDate, { kind: 'known', value: '2025-03-18' });
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

  it('isolates pages and bounds dense visual-row grouping to a fixed anchor', () => {
    const observations = [
      observation('page-zero-date', 'Collection date 22.08.2026', 0.08, 0.1, {
        pageIndex: 0,
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        observation(
          `page-zero-measurement-${index}`,
          `LDL-C ${100 + index} mg/dL`,
          0.08,
          0.14 + index * 0.04,
          {
            pageIndex: 0,
          },
        ),
      ),
      observation('page-one-date', 'Collection date 23.08.2026', 0.08, 0.1, {
        pageIndex: 1,
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        observation(
          `page-one-measurement-${index}`,
          `LDL-C ${120 + index} mg/dL`,
          0.08,
          0.14 + index * 0.04,
          {
            pageIndex: 1,
          },
        ),
      ),
    ];

    const result = extractOCRDateContexts(observations);

    assert.deepEqual(
      result.contexts.map((context) => context.collectionDate),
      [
        { kind: 'known', value: '2026-08-22' },
        { kind: 'known', value: '2026-08-23' },
      ],
    );
    assert.deepEqual([...result.excludedObservationIds], ['page-zero-date', 'page-one-date']);
  });

  it('keeps mixed date and measurement parents available to source parsing', () => {
    const result = extractOCRDateContexts([
      observation('mixed-parent', 'Collection date 22.08.2026 LDL-C 3.8 mmol/L', 0.08),
    ]);

    assert.deepEqual(result.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(result.contexts[0]?.observationId, 'mixed-parent');
    assert.equal(result.excludedObservationIds.has('mixed-parent'), false);
  });
});
