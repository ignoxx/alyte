import assert from 'node:assert/strict';
import test from 'node:test';
import { exportMediaOptionState } from './export-ui-model';

test('zero-count media is unavailable and clears a stale selection', () => {
  assert.deepEqual(exportMediaOptionState('ready', 0, true), {
    disabled: true,
    selected: false,
    unavailable: true,
  });
});

test('available media preserves selection and remains enabled', () => {
  assert.deepEqual(exportMediaOptionState('ready', 2, true), {
    disabled: false,
    selected: true,
    unavailable: false,
  });
});

test('loading and failed counts stay disabled without claiming zero media', () => {
  assert.deepEqual(exportMediaOptionState('loading', 0, true), {
    disabled: true,
    selected: false,
    unavailable: false,
  });
  assert.deepEqual(exportMediaOptionState('unavailable', 3, true), {
    disabled: true,
    selected: false,
    unavailable: false,
  });
});
