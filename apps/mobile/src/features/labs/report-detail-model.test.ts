import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReportFileSize, formatReportPageCount } from './report-detail-model';

test('report page count interpolation produces one localized label', () => {
  assert.equal(formatReportPageCount('Pages: {count}', 4, 'Unknown'), 'Pages: 4');
  assert.equal(formatReportPageCount('Pages: {count}', null, 'Unknown'), 'Pages: Unknown');
});

test('report file sizes use honest B, KB, and MB boundaries', () => {
  assert.equal(formatReportFileSize(0), '0 B');
  assert.equal(formatReportFileSize(1023), '1,023 B');
  assert.equal(formatReportFileSize(1024), '1.0 KB');
  assert.equal(formatReportFileSize(1024 * 1024 - 1), '1,024.0 KB');
  assert.equal(formatReportFileSize(1024 * 1024), '1.0 MB');
  assert.equal(formatReportFileSize(null, { unknownLabel: 'Not recorded' }), 'Not recorded');
});

test('report file sizes follow the requested locale', () => {
  assert.equal(formatReportFileSize(1536, { locale: 'de-DE' }), '1,5 KB');
});
