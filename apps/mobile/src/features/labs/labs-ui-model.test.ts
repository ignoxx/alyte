import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labsShowsManualRecordAction } from './labs-ui-model';

test('Labs keeps manual record creation available when reports have no records yet', () => {
  assert.equal(labsShowsManualRecordAction(1, 0), true);
  assert.equal(labsShowsManualRecordAction(1, 2), true);
  assert.equal(labsShowsManualRecordAction(0, 0), false);
});
