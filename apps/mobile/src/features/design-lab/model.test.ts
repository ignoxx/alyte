import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  designLabDirections,
  designLabEnabled,
  formatSyntheticDate,
  formatSyntheticMeasurement,
  formatSyntheticNumber,
  syntheticMeasuredChanges,
  syntheticReports,
} from './model';

test('design lab exposes three directions and deterministic two-report data', () => {
  assert.deepEqual(designLabDirections, ['quiet', 'timeline', 'library']);
  assert.equal(syntheticReports.length, 2);
  assert.equal(syntheticMeasuredChanges.length, 3);
  assert.ok(syntheticMeasuredChanges.every((change) => change.unit === 'millimolesPerLiter'));
});

test('synthetic dates and measured values are locale formatted at presentation time', () => {
  assert.equal(formatSyntheticDate('2026-08-18', 'en-GB'), '18 Aug 2026');
  assert.equal(formatSyntheticDate('2026-08-18', 'de-DE'), '18. Aug. 2026');
  assert.equal(formatSyntheticMeasurement(3.4, 'mmol/L', 'en-GB'), '3.4 mmol/L');
  assert.equal(formatSyntheticMeasurement(3.4, 'mmol/L', 'de-DE'), '3,4 mmol/L');
  assert.equal(formatSyntheticNumber(12_345, 'en-GB'), '12,345');
  assert.equal(formatSyntheticNumber(12_345, 'de-DE'), '12.345');
});

test('the explicit flag cannot expose the design lab outside a development bundle', () => {
  assert.equal(designLabEnabled('1', true), true);
  assert.equal(designLabEnabled('1', false), false);
  assert.equal(designLabEnabled(undefined, true), false);
});
