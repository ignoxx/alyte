import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReportPageCount } from './report-detail-model';

test('report page count interpolation produces one localized label', () => {
  assert.equal(formatReportPageCount('Pages: {count}', 4, 'Unknown'), 'Pages: 4');
  assert.equal(formatReportPageCount('Pages: {count}', null, 'Unknown'), 'Pages: Unknown');
});
