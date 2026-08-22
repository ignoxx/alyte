import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLabDateState,
  assertMeasurementValue,
  createSortableOpaqueId,
  formatLocaleDate,
  formatLocaleDecimal,
  formatMeasurementValue,
  parseLocalDateInput,
  parseLocaleDecimal,
} from './labs.js';

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

  it('parses locale decimals and dates without timezone drift', () => {
    assert.equal(parseLocaleDecimal('1.234,56'), 1234.56);
    assert.equal(parseLocaleDecimal('1 234,56'), 1234.56);
    assert.equal(parseLocaleDecimal('3,8'), 3.8);
    assert.equal(parseLocaleDecimal('not-a-number'), null);
    assert.equal(parseLocalDateInput('22.08.2026', 'de-DE'), '2026-08-22');
    assert.equal(parseLocalDateInput('08/22/2026', 'en-US'), '2026-08-22');
    assert.equal(parseLocalDateInput('2026-02-30', 'en-US'), null);
    assert.equal(formatLocaleDecimal(1234.5, 'de-DE'), '1.234,5');
    assert.equal(formatLocaleDate('2026-08-22', 'de-DE'), '22.08.2026');
  });

  it('creates sortable opaque identifiers with a deterministic seam', () => {
    assert.ok(
      createSortableOpaqueId('measurement', 1000, 'a'.repeat(20)) <
        createSortableOpaqueId('measurement', 1001, '0'.repeat(20)),
    );
    assert.match(
      createSortableOpaqueId('lab-record', 1000, 'b'.repeat(20)),
      /^lab-record-[0-9a-f]{12}-b{20}$/,
    );
  });
});
