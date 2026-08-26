import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractionProgressGate,
  type ExtractionProgressGateInput,
} from './extraction-progress-gate';

function input(overrides: Partial<ExtractionProgressGateInput> = {}): ExtractionProgressGateInput {
  return {
    focused: true,
    durableLoaded: true,
    modelStateLoaded: true,
    modelReady: true,
    hasFailure: false,
    cancellationRequested: false,
    started: false,
    completed: false,
    modelSetupOpened: false,
    ...overrides,
  };
}

test('model setup is opened before extraction when the report is ready but the pack is not', () => {
  assert.equal(extractionProgressGate(input({ modelReady: false })), 'open-model-setup');
  assert.equal(
    extractionProgressGate(input({ modelReady: false, modelSetupOpened: true })),
    'wait',
  );
});

test('extraction starts only after durable progress and model readiness are known', () => {
  assert.equal(extractionProgressGate(input()), 'start-extraction');
  assert.equal(extractionProgressGate(input({ durableLoaded: false })), 'wait');
  assert.equal(extractionProgressGate(input({ modelStateLoaded: false })), 'wait');
  assert.equal(extractionProgressGate(input({ modelReady: false })), 'open-model-setup');
});

test('in-flight and terminal state cannot start a second extraction', () => {
  assert.equal(extractionProgressGate(input({ started: true })), 'wait');
  assert.equal(extractionProgressGate(input({ completed: true })), 'wait');
  assert.equal(extractionProgressGate(input({ cancellationRequested: true })), 'wait');
  assert.equal(extractionProgressGate(input({ hasFailure: true })), 'wait');
});
