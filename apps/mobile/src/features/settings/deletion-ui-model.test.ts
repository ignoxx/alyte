import assert from 'node:assert/strict';
import test from 'node:test';
import { t } from '../../localization';
import { deletionCountLabelKeys, shouldHideDeletionPreview } from './deletion-ui-model';

test('local-deletion preview distinguishes extraction drafts from extracted review rows', () => {
  const extractionDrafts = t(deletionCountLabelKeys.extractionDrafts);
  const extractionRows = t(deletionCountLabelKeys.extractionRows);

  assert.equal(extractionDrafts, 'extraction drafts');
  assert.equal(extractionRows, 'extracted review rows');
  assert.notEqual(deletionCountLabelKeys.extractionDrafts, deletionCountLabelKeys.extractionRows);
});

test('local-deletion preview keeps sanitization drafts distinct from extraction drafts', () => {
  assert.equal(t(deletionCountLabelKeys.sanitizationDrafts), 'sanitization drafts');
  assert.notEqual(
    deletionCountLabelKeys.sanitizationDrafts,
    deletionCountLabelKeys.extractionDrafts,
  );
});

test('hygiene-only failure hides committed deletion counts while keeping retry state', () => {
  assert.equal(
    shouldHideDeletionPreview({
      state: 'failed',
      failureCategories: ['database-hygiene-pending'],
    }),
    true,
  );
  assert.equal(
    shouldHideDeletionPreview({ state: 'failed', failureCategories: ['database-failed'] }),
    false,
  );
  assert.equal(shouldHideDeletionPreview({ state: 'completed', failureCategories: [] }), false);
});
