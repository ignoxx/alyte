import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractionTerminalNavigationReady,
  ExtractionProgressController,
  type ExtractionProgressControllerInput,
  type ExtractionProgressTerminalDestination,
} from './extraction-progress-controller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
    hasFailure: false,
    cancellationRequested: false,
    restoredProgress: null,
    restoredDraftId: null,
    ...overrides,
  };
}

test('starts local extraction once without a model readiness gate', async () => {
  const extraction = deferred<{ readonly id: string }>();
  const starts: string[] = [];
  const destinations: ExtractionProgressTerminalDestination[] = [];
  const activeTransitions: boolean[] = [];
  const controller = new ExtractionProgressController({
    reportId: 'report-local',
    startExtraction: async (reportId) => {
      starts.push(reportId);
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    setTerminalDestination: (destination) => destinations.push(destination),
    setActiveOperation: (active) => activeTransitions.push(active),
    setFailure: () => undefined,
  });

  controller.evaluate(readyInput());
  controller.evaluate(readyInput());
  await flushController();
  assert.deepEqual(starts, ['report-local']);
  assert.deepEqual(activeTransitions, [true]);

  extraction.resolve({ id: 'draft-local' });
  await extraction.promise;
  await flushController();
  assert.deepEqual(activeTransitions, [true, false]);
  assert.deepEqual(destinations, [
    { kind: 'draft', reportId: 'report-local', draftId: 'draft-local' },
  ]);
});

test('dispose prevents a late local extraction completion from navigating', async () => {
  const extraction = deferred<{ readonly id: string }>();
  let starts = 0;
  const controller = new ExtractionProgressController({
    reportId: 'report-unmounted',
    startExtraction: () => {
      starts += 1;
      return extraction.promise;
    },
    classifyFailure: () => 'recognition',
    setTerminalDestination: () => assert.fail('an unmounted operation must not complete'),
    setActiveOperation: () => undefined,
    setFailure: () => undefined,
  });

  controller.evaluate(readyInput());
  await flushController();
  assert.equal(starts, 1);
  controller.dispose();
  extraction.resolve({ id: 'late-draft' });
  await extraction.promise;
  await flushController();
});

test('restored complete progress opens its existing draft without restarting extraction', () => {
  let starts = 0;
  let destination: ExtractionProgressTerminalDestination | null = null;
  const controller = new ExtractionProgressController({
    reportId: 'report-restored',
    startExtraction: async () => {
      starts += 1;
      return { id: 'unexpected-draft' };
    },
    classifyFailure: () => 'recognition',
    setTerminalDestination: (next) => {
      destination = next;
    },
    setActiveOperation: (active) => assert.equal(active, false),
    setFailure: () => undefined,
  });

  controller.evaluate(
    readyInput({
      restoredProgress: {
        reportId: 'report-restored',
        mode: 'start',
        stage: 'review',
        status: 'complete',
        completed: 1,
        total: 1,
      },
      restoredDraftId: 'draft-restored',
    }),
  );

  assert.equal(starts, 0);
  assert.deepEqual(destination, {
    kind: 'draft',
    reportId: 'report-restored',
    draftId: 'draft-restored',
  });
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
