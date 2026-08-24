import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_REVIEW_REASONS } from '@alyte/domain';
import { t } from './index';

test('English extraction review catalogue covers every supported reason', () => {
  for (const reason of EXTRACTION_REVIEW_REASONS) {
    assert.notEqual(t(`labs.extractionReason.${reason}`), '');
  }
});
