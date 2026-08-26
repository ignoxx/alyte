import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMediaOptionState } from './export-ui-model';

test('a known empty media category is disabled and clears a stale selection', () => {
  assert.deepEqual(exportMediaOptionState('ready', 0, true), {
    disabled: true,
    selected: false,
    availability: 'empty',
  });
});

test('available media preserves selection and remains enabled', () => {
  assert.deepEqual(exportMediaOptionState('ready', 2, true), {
    disabled: false,
    selected: true,
    availability: 'available',
  });
});

test('loading and failed summaries stay unknown rather than claiming an empty category', () => {
  assert.deepEqual(exportMediaOptionState('loading', 0, true), {
    disabled: true,
    selected: false,
    availability: 'unknown',
  });
  assert.deepEqual(exportMediaOptionState('failed', 3, true), {
    disabled: true,
    selected: false,
    availability: 'unknown',
  });
});
