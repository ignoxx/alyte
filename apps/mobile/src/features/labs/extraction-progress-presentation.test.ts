import assert from 'node:assert/strict';
import test from 'node:test';
import { extractionFailurePresentation } from './extraction-progress-presentation';

test('gives an honest specific outcome when no credible lab values were found', () => {
  assert.deepEqual(extractionFailurePresentation('no-reviewable-measurements'), {
    titleKey: 'labs.extractionProgressNoValuesTitle',
    messageKey: 'labs.extractionNoMeasurementsError',
  });
});

test('keeps actionable source failures distinct from generic processing failures', () => {
  assert.deepEqual(extractionFailurePresentation('wrong-password'), {
    titleKey: 'labs.extractionProgressFailureTitle',
    messageKey: 'labs.extractionProgressPasswordError',
  });
  assert.deepEqual(extractionFailurePresentation('original-source'), {
    titleKey: 'labs.extractionProgressFailureTitle',
    messageKey: 'labs.extractionProgressSourceError',
  });
  assert.deepEqual(extractionFailurePresentation('recognition'), {
    titleKey: 'labs.extractionProgressFailureTitle',
    messageKey: 'labs.extractionRecognitionError',
  });
  assert.deepEqual(extractionFailurePresentation('persistence'), {
    titleKey: 'labs.extractionProgressFailureTitle',
    messageKey: 'labs.extractionPersistenceError',
  });
});
