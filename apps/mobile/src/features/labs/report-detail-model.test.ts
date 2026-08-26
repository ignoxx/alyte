import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../../localization';
import {
  formatReportFileSize,
  formatReportPageCount,
  getLabReportFailureRecovery,
  getLabReportDetailState,
} from './report-detail-model';

test('report detail separates unavailable records from transient load errors', () => {
  assert.equal(getLabReportDetailState(null, false, false), 'unavailable');
  assert.equal(getLabReportDetailState(null, false, true), 'error');
  assert.equal(getLabReportDetailState(null, true, false), 'loading');
});

test('pathless import failures are deletion-only and do not claim a retained source', () => {
  assert.deepEqual(getLabReportFailureRecovery({ originalPath: null, sourceHash: null }), {
    action: 'delete',
    message: 'missing-source',
  });
  assert.deepEqual(
    getLabReportFailureRecovery({
      originalPath: 'protected://original-reports/report.pdf',
      sourceHash: 'hash',
    }),
    { action: 'retry', message: 'retained-source' },
  );
  const copy = t('labs.reportNoSourceRetryBody');
  assert.match(copy, /no protected source to retry/i);
  assert.doesNotMatch(copy, /source remains/i);
});

test('report page count interpolation produces one localized label', () => {
  assert.equal(formatReportPageCount('Pages: {count}', 4, 'Unknown'), 'Pages: 4');
  assert.equal(formatReportPageCount('Pages: {count}', null, 'Unknown'), 'Pages: Unknown');
});

test('report file sizes use honest B, KB, and MB boundaries', () => {
  const enUS = { locale: 'en-US' };
  assert.equal(formatReportFileSize(0, enUS), '0 B');
  assert.equal(formatReportFileSize(1023, enUS), '1,023 B');
  assert.equal(formatReportFileSize(1024, enUS), '1.0 KB');
  assert.equal(formatReportFileSize(1024 * 1024 - 1, enUS), '1,024.0 KB');
  assert.equal(formatReportFileSize(1024 * 1024, enUS), '1.0 MB');
  assert.equal(
    formatReportFileSize(null, { ...enUS, unknownLabel: 'Not recorded' }),
    'Not recorded',
  );
});

test('report file sizes follow the requested locale', () => {
  assert.equal(formatReportFileSize(1536, { locale: 'de-DE' }), '1,5 KB');
});
