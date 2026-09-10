import assert from 'node:assert/strict';
import test from 'node:test';
import { t } from '../../localization';
import { deletionCountLabelKeys, shouldHideDeletionPreview } from './deletion-ui-model';

test('local-deletion preview distinguishes extraction drafts from extracted review rows', () => {
  const extractionDrafts = t(deletionCountLabelKeys.extractionDrafts);
  const extractionRows = t(deletionCountLabelKeys.extractionRows);

  assert.equal(extractionDrafts, 'report drafts');
  assert.equal(extractionRows, 'results to check');
  assert.notEqual(deletionCountLabelKeys.extractionDrafts, deletionCountLabelKeys.extractionRows);
});

test('local-deletion preview keeps sanitization drafts distinct from extraction drafts', () => {
  assert.equal(t(deletionCountLabelKeys.sanitizationDrafts), 'redaction drafts');
  assert.notEqual(
    deletionCountLabelKeys.sanitizationDrafts,
    deletionCountLabelKeys.extractionDrafts,
  );
});

test('post-commit cleanup failures hide committed deletion counts while keeping retry state', () => {
  assert.equal(
    shouldHideDeletionPreview({
      state: 'failed',
      failureCategories: ['database-hygiene-pending'],
    }),
    true,
  );
  assert.equal(
    shouldHideDeletionPreview({
      state: 'failed',
      failureCategories: ['orphan-cleanup-failed'],
    }),
    true,
  );
  assert.equal(
    shouldHideDeletionPreview({ state: 'failed', failureCategories: ['database-failed'] }),
    false,
  );
  assert.equal(shouldHideDeletionPreview({ state: 'completed', failureCategories: [] }), false);
});
