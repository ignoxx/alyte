import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractionTerminalNavigationReady,
  ExtractionProgressController,
  type ExtractionProgressTerminalDestination,
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
  const stateTransitions: string[] = [];
  const controller = new ExtractionProgressController({
    reportId: 'report-79',
    startExtraction: async (reportId) => {
      starts.push(reportId);
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => setupRoutes.push('setup'),
    setTerminalDestination: (destination) => {
      stateTransitions.push('terminal');
      assert.equal(stateTransitions[0], 'guard-off');
      if (destination.kind === 'draft') {
        draftRoutes.push({ reportId: destination.reportId, draftId: destination.draftId });
      }
    },
    setActiveOperation: (active) => stateTransitions.push(active ? 'guard-on' : 'guard-off'),
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
  assert.deepEqual(stateTransitions, ['guard-off', 'guard-on', 'guard-off', 'terminal']);
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
    setTerminalDestination: () => assert.fail('an unavailable operation must not complete'),
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
  const controller = new ExtractionProgressController({
    reportId: 'report-unmounted',
    startExtraction: () => {
      starts += 1;
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    openModelSetup: () => undefined,
    setTerminalDestination: () => assert.fail('an unmounted operation must not complete'),
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
    setTerminalDestination: (destination) => {
      assert.deepEqual(destination, {
        kind: 'draft',
        reportId: 'report-restored',
        draftId: 'draft-restored',
      });
      if (destination.kind === 'draft') {
        draftRoutes.push({ reportId: destination.reportId, draftId: destination.draftId });
      }
    },
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
    setTerminalDestination: (destination) => {
      assert.deepEqual(destination, {
        kind: 'report',
        reportId: 'report-restored-no-draft',
      });
      reportRoutes += 1;
    },
    setActiveOperation: (active) => activeTransitions.push(active),
    setFailure: () => undefined,
    setModelUnavailable: () => assert.fail('a complete operation does not need a model'),
  });

  const restoredInput = {
    restoredProgress: {
      reportId: 'report-restored-no-draft',
      stage: 'review' as const,
      status: 'complete' as const,
      completed: 1,
      total: 1,
    },
    restoredDraftId: undefined,
  };
  controller.evaluate(readyInput(restoredInput));

  // A failed or still-pending lookup must not be collapsed into the successful no-draft result.
  assert.equal(starts, 0);
  assert.equal(reportRoutes, 0);
  assert.deepEqual(activeTransitions, []);

  controller.evaluate(readyInput({ ...restoredInput, restoredDraftId: null }));

  assert.equal(starts, 0);
  assert.equal(reportRoutes, 1);
  assert.deepEqual(activeTransitions, [false]);
});

test('terminal handoff is ready only after the operation guard has rendered off', () => {
  const destination: ExtractionProgressTerminalDestination = {
    kind: 'draft',
    reportId: 'report-guard',
    draftId: 'draft-guard',
  };

  assert.equal(
    extractionTerminalNavigationReady(destination, {
      focused: true,
      activeOperation: true,
      hasFailure: false,
    }),
    false,
  );
  assert.equal(
    extractionTerminalNavigationReady(destination, {
      focused: true,
      activeOperation: false,
      hasFailure: false,
    }),
    true,
  );
});
