import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtractionProgressController } from './extraction-progress-controller';
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

function readyInput(overrides: Record<string, boolean> = {}) {
  return {
    focused: true,
    durableLoaded: true,
    modelStateLoaded: true,
    modelReady: true,
    hasFailure: false,
    cancellationRequested: false,
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
