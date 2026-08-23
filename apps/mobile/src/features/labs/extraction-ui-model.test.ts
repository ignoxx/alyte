import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmExtraction, extractionDecisionPresentation } from './extraction-ui-model';

test('Extraction decisions use neutral review presentation instead of provenance tones', () => {
  assert.deepEqual(extractionDecisionPresentation('preserve'), {
    label: 'kept',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('skip'), {
    label: 'skipped',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('resolve'), {
    label: 'resolved',
    tone: 'neutral',
  });
  assert.deepEqual(extractionDecisionPresentation('unresolved'), {
    label: 'needs-decision',
    tone: 'neutral',
  });
});

test('Extraction confirmation stays gated until every row has a decision', () => {
  assert.equal(canConfirmExtraction([]), false);
  assert.equal(canConfirmExtraction([{ decision: 'unresolved' }]), false);
  assert.equal(
    canConfirmExtraction([{ decision: 'preserve' }, { decision: 'skip' }, { decision: 'resolve' }]),
    true,
  );
});
