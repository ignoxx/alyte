import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractionProgressStageCompleted,
  extractionFailurePresentation,
  extractionProgressDetailKey,
} from './extraction-progress-presentation';

test('gives an honest specific outcome when no credible lab values were found', () => {
  assert.deepEqual(extractionFailurePresentation('no-reviewable-measurements'), {
    titleKey: 'labs.extractionProgressNoValuesTitle',
    messageKey: 'labs.extractionNoMeasurementsError',
  });
});

test('marks only earlier phases complete while extraction is active', () => {
  const progress = {
    reportId: 'report-progress',
    mode: 'start' as const,
    stage: 'refine' as const,
    status: 'active' as const,
    completed: 0,
    total: 1,
  };

  assert.equal(extractionProgressStageCompleted(progress, 'import'), true);
  assert.equal(extractionProgressStageCompleted(progress, 'ocr'), true);
  assert.equal(extractionProgressStageCompleted(progress, 'organize'), true);
  assert.equal(extractionProgressStageCompleted(progress, 'refine'), false);
  assert.equal(extractionProgressStageCompleted(progress, 'review'), false);
});

test('marks every phase complete for a terminally completed extraction', () => {
  const progress = {
    reportId: 'report-progress',
    mode: 'start' as const,
    stage: 'review' as const,
    status: 'complete' as const,
    completed: 1,
    total: 1,
  };

  for (const stage of ['import', 'ocr', 'organize', 'refine', 'review'] as const) {
    assert.equal(extractionProgressStageCompleted(progress, stage), true, stage);
  }
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
  assert.deepEqual(extractionFailurePresentation('model-unavailable'), {
    titleKey: 'labs.extractionProgressFailureTitle',
    messageKey: 'labs.extractionModelError',
  });
});

test('keeps each active extraction phase explicit', () => {
  assert.equal(
    extractionProgressDetailKey({
      reportId: 'report-progress',
      mode: 'start',
      stage: 'ocr',
      status: 'active',
      completed: 3,
      total: 4,
    }),
    'labs.extractionProgressPage',
  );
  assert.equal(
    extractionProgressDetailKey({
      reportId: 'report-progress',
      mode: 'start',
      stage: 'ocr',
      status: 'active',
      completed: 4,
      total: 4,
    }),
    'labs.extractionProgressPage',
  );
  assert.equal(
    extractionProgressDetailKey({
      reportId: 'report-progress',
      mode: 'start',
      stage: 'organize',
      status: 'active',
      completed: 0,
      total: 1,
    }),
    'labs.extractionProgressOrganizing',
  );
  assert.equal(
    extractionProgressDetailKey({
      reportId: 'report-progress',
      mode: 'start',
      stage: 'refine',
      status: 'active',
      completed: 0,
      total: 1,
    }),
    'labs.extractionProgressRefining',
  );
  assert.equal(
    extractionProgressDetailKey({
      reportId: 'report-progress',
      mode: 'start',
      stage: 'review',
      status: 'active',
      completed: 0,
      total: 1,
    }),
    'labs.extractionProgressSaving',
  );
});
