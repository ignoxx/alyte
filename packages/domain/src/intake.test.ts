import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIntakeAmount,
  formatIntakeLocalDate,
  formatIntakeLocalDateInput,
  parseIntakeDateTimeInput,
  parseIntakeLocalDateInput,
  parseIntakeTimeInput,
} from './intake.js';

test('parses supported locale date order and keeps ISO input as a fallback', () => {
  assert.equal(parseIntakeLocalDateInput('22.08.2026', 'de-DE'), '2026-08-22');
  assert.equal(parseIntakeLocalDateInput('08/22/2026', 'en-US'), '2026-08-22');
  assert.equal(parseIntakeLocalDateInput('2026-08-22', 'de-DE'), '2026-08-22');
  assert.equal(formatIntakeLocalDateInput('2026-08-22', 'de-DE'), '22.08.2026');
  assert.equal(parseIntakeLocalDateInput('2026-02-30', 'en-US'), null);
});

test('rejects impossible intake times and preserves local date agreement', () => {
  assert.deepEqual(parseIntakeTimeInput('09:05'), { hours: 9, minutes: 5 });
  assert.equal(parseIntakeTimeInput('24:00'), null);
  assert.equal(parseIntakeTimeInput('12:60'), null);
  assert.equal(parseIntakeTimeInput('9:5'), null);

  const parsed = parseIntakeDateTimeInput('22.08.2026', '23:59', 'de-DE');
  assert.notEqual(parsed, null);
  assert.equal(formatIntakeLocalDate(new Date(parsed?.occurredAt ?? '')), parsed?.localDate);
  assert.equal(parseIntakeDateTimeInput('22.08.2026', '24:00', 'de-DE'), null);
});

test('known intake amounts cannot silently acquire a serving unit', () => {
  assert.doesNotThrow(() => assertIntakeAmount({ kind: 'known', value: 1, unit: 'tablet' }));
  assert.throws(
    () => assertIntakeAmount({ kind: 'known', value: 1, unit: '' }),
    /must include a unit/,
  );
});
