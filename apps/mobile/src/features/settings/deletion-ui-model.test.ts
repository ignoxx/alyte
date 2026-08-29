import assert from 'node:assert/strict';
import test from 'node:test';
import { t } from '../../localization';
import { deletionCountLabelKeys } from './deletion-ui-model';

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
