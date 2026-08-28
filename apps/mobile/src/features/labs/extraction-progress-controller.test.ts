import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExtractionProgressController,
  type ExtractionProgressControllerInput,
} from './extraction-progress-controller';
import { LabReportExtractionError } from './report-service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function flushController(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function readyInput(
  overrides: Partial<ExtractionProgressControllerInput> = {},
): ExtractionProgressControllerInput {
  return {
    focused: true,
    durableLoaded: true,
    modelStateLoaded: true,
    modelReady: true,
    hasFailure: false,
    cancellationRequested: false,
    restoredProgress: null,
    restoredDraftId: null,
    ...overrides,
  };
}

test('not-ready routes once, then setup completion starts the same report once', async () => {
  const extraction = deferred<{ readonly id: string }>();
  const starts: string[] = [];
  const setupRoutes: string[] = [];
  const draftRoutes: Array<{ reportId: string; draftId: string }> = [];
  const controller = new ExtractionProgressController({
    reportId: 'report-79',
    startExtraction: async (reportId) => {
      starts.push(reportId);
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => setupRoutes.push('setup'),
    openDraft: (reportId, draftId) => draftRoutes.push({ reportId, draftId }),
    openReport: () => assert.fail('a newly completed extraction has a draft'),
    setActiveOperation: () => undefined,
    setFailure: () => undefined,
    setModelUnavailable: () => undefined,
  });

  controller.evaluate(readyInput({ modelReady: false }));
  controller.evaluate(readyInput({ modelReady: false }));
  assert.deepEqual(setupRoutes, ['setup']);
  assert.deepEqual(starts, []);

  controller.evaluate(readyInput({ focused: false, modelReady: true }));
  controller.evaluate(readyInput({ modelReady: true }));
  controller.evaluate(readyInput({ modelReady: true }));
  await flushController();
  assert.deepEqual(starts, ['report-79']);

  extraction.resolve({ id: 'draft-79' });
  await extraction.promise;
  await flushController();
  assert.deepEqual(draftRoutes, [{ reportId: 'report-79', draftId: 'draft-79' }]);
});

test('mid-operation unavailable opens setup once and ignores the late rejection', async () => {
  const extraction = deferred<{ readonly id: string }>();
  let setupRoutes = 0;
  let unavailableEvents = 0;
  const controller = new ExtractionProgressController({
    reportId: 'report-mid-operation',
    startExtraction: () => extraction.promise,
    classifyFailure: (error) =>
      error instanceof LabReportExtractionError ? error.reason : 'recognition',
    openModelSetup: () => {
      setupRoutes += 1;
    },
    openDraft: () => assert.fail('an unavailable operation must not open a draft'),
    openReport: () => assert.fail('an unavailable operation must not open the report'),
    setActiveOperation: () => undefined,
    setFailure: () => undefined,
    setModelUnavailable: () => {
      unavailableEvents += 1;
    },
  });

  controller.evaluate(readyInput());
  await flushController();
  controller.modelBecameUnavailable();
  controller.modelBecameUnavailable();
  controller.evaluate(readyInput({ modelReady: false }));
  controller.evaluate(readyInput({ modelReady: false }));
  assert.equal(unavailableEvents, 1);
  assert.equal(setupRoutes, 1);

  extraction.reject(new LabReportExtractionError('model-unavailable', 'model removed'));
  await assert.rejects(extraction.promise);
  await flushController();
  assert.equal(unavailableEvents, 1);
  assert.equal(setupRoutes, 1);
});

test('dispose prevents late completion and repeated evaluation from navigating', async () => {
  const extraction = deferred<{ readonly id: string }>();
  let starts = 0;
  let draftRoutes = 0;
  const controller = new ExtractionProgressController({
    reportId: 'report-unmounted',
    startExtraction: () => {
      starts += 1;
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => undefined,
    openDraft: () => {
      draftRoutes += 1;
    },
    openReport: () => assert.fail('an unmounted operation must not open the report'),
    setActiveOperation: () => undefined,
    setFailure: () => undefined,
    setModelUnavailable: () => undefined,
  });

  controller.evaluate(readyInput());
  controller.evaluate(readyInput());
  await flushController();
  assert.equal(starts, 1);
  controller.dispose();
  extraction.resolve({ id: 'late-draft' });
  await extraction.promise;
  await flushController();
  controller.evaluate(readyInput());
  assert.equal(starts, 1);
  assert.equal(draftRoutes, 0);
});

test('restored complete progress opens its existing draft without restarting extraction', () => {
  let starts = 0;
  let activeOperation = false;
  const draftRoutes: Array<{ reportId: string; draftId: string }> = [];
  const controller = new ExtractionProgressController({
    reportId: 'report-restored',
    startExtraction: async () => {
      starts += 1;
      return { id: 'unexpected-draft' };
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => assert.fail('a complete operation must not reopen model setup'),
    openDraft: (reportId, draftId) => draftRoutes.push({ reportId, draftId }),
    openReport: () => assert.fail('the existing open draft should be preferred'),
    setActiveOperation: (active) => {
      activeOperation = active;
    },
    setFailure: () => undefined,
    setModelUnavailable: () => assert.fail('a complete operation does not need a model'),
  });

  controller.evaluate(
    readyInput({
      restoredProgress: {
        reportId: 'report-restored',
        stage: 'review',
        status: 'complete',
        completed: 1,
        total: 1,
      },
      restoredDraftId: 'draft-restored',
    }),
  );

  assert.equal(starts, 0);
  assert.equal(activeOperation, false);
  assert.deepEqual(draftRoutes, [{ reportId: 'report-restored', draftId: 'draft-restored' }]);
});

test('restored complete progress with no draft offers the report fallback', () => {
  let starts = 0;
  let reportRoutes = 0;
  const activeTransitions: boolean[] = [];
  const controller = new ExtractionProgressController({
    reportId: 'report-restored-no-draft',
    startExtraction: async () => {
      starts += 1;
      return { id: 'unexpected-draft' };
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => assert.fail('a complete operation must not reopen model setup'),
    openDraft: () => assert.fail('there is no restored draft'),
    openReport: (reportId) => {
      assert.equal(reportId, 'report-restored-no-draft');
      reportRoutes += 1;
    },
    setActiveOperation: (active) => activeTransitions.push(active),
    setFailure: () => undefined,
    setModelUnavailable: () => assert.fail('a complete operation does not need a model'),
  });

  controller.evaluate(
    readyInput({
      restoredProgress: {
        reportId: 'report-restored-no-draft',
        stage: 'review',
        status: 'complete',
        completed: 1,
        total: 1,
      },
      restoredDraftId: null,
    }),
  );

  assert.equal(starts, 0);
  assert.equal(reportRoutes, 1);
  assert.deepEqual(activeTransitions, [false]);
});
