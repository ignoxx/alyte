import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertLabDateState, assertMeasurementValue, formatMeasurementValue } from './labs.js';

describe('manual laboratory value model', () => {
  it('accepts a missing date and rejects invalid known dates', () => {
    assert.doesNotThrow(() => assertLabDateState({ kind: 'missing' }));
    assert.doesNotThrow(() => assertLabDateState({ kind: 'known', value: '2026-08-22' }));
    assert.throws(() => assertLabDateState({ kind: 'known', value: '22/08/2026' }));
    assert.throws(() => assertLabDateState({ kind: 'known', value: '2026-02-30' }));
  });

  it('keeps bounded, categorical, and free-text values distinct', () => {
    assert.equal(formatMeasurementValue({ kind: 'bounded', comparator: '<', value: 5 }), '<5');
    assert.equal(formatMeasurementValue({ kind: 'categorical', value: 'negative' }), 'negative');
    assert.equal(
      formatMeasurementValue({ kind: 'free_text', value: 'sample hemolyzed' }),
      'sample hemolyzed',
    );
    assert.doesNotThrow(() =>
      assertMeasurementValue({ kind: 'bounded', comparator: '>', value: 0 }),
    );
    assert.throws(() => assertMeasurementValue({ kind: 'numeric', value: Number.NaN }));
  });
});
