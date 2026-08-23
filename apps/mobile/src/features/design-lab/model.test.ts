import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  designLabDirectionNames,
  designLabDirections,
  designLabEnabled,
  syntheticMeasuredChanges,
  syntheticReports,
} from './model';

test('design lab exposes three named directions and deterministic two-report data', () => {
  assert.deepEqual(
    designLabDirections.map((direction) => designLabDirectionNames[direction]),
    ['Quiet', 'Timeline', 'Library'],
  );
  assert.equal(syntheticReports.length, 2);
  assert.equal(syntheticMeasuredChanges.length, 3);
  assert.ok(syntheticMeasuredChanges.every((change) => /mmol\/L$/.test(change.latest)));
});

test('the explicit flag cannot expose the design lab outside a development bundle', () => {
  assert.equal(designLabEnabled('1', true), true);
  assert.equal(designLabEnabled('1', false), false);
  assert.equal(designLabEnabled(undefined, true), false);
});
