import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const mobileRoot = process.cwd().endsWith('apps/mobile')
  ? process.cwd()
  : resolve(process.cwd(), 'apps/mobile');
const nativeRoot = resolve(mobileRoot, 'modules/alyte-local-models/ios');
const storeSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelStore.swift'), 'utf8');
const coreSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelCore.swift'), 'utf8');
const moduleSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelsModule.swift'), 'utf8');
const podspecSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModels.podspec'), 'utf8');
const runtimeSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelRuntime.c'), 'utf8');

test('native store owns resumable verification, protection, promotion, and release hooks', () => {
  for (const value of [
    'URLSessionDataDelegate',
    'Range',
    'SHA256',
    'FileProtectionType.complete',
    'isExcludedFromBackup',
    'didReceiveMemoryWarningNotification',
    'thermalStateDidChangeNotification',
    'releaseForBackground',
  ]) {
    assert.equal(storeSource.includes(value), true, value);
  }
  assert.equal(storeSource.includes('Authorization")'), true);
  assert.equal(storeSource.includes('Cookie")'), true);
  assert.equal(storeSource.includes('loadedHandle'), false);
  assert.equal(storeSource.includes('resumeURL'), false);
  assert.equal(storeSource.includes('.gguf"'), false);
  assert.equal(moduleSource.includes('OnAppEntersBackground'), true);
});

test('the production lifecycle core owns promotion and runtime cleanup', () => {
  for (const value of [
    'replaceItemAt(readyURL, withItemAt: partialURL',
    'copyItem(at: readyURL, to: backup)',
    'requestCancellation()',
    'acceptResponse(status:',
    'releaseForPressure()',
  ]) {
    assert.equal(coreSource.includes(value), true, value);
  }
});

test('device and production builds cannot silently omit the pinned runtime', () => {
  for (const value of [
    'ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK',
    'ALYTE_LOCAL_MODEL_ALLOW_SIMULATOR_FAKE',
    'ALYTE_LOCAL_MODEL_SIMULATOR',
    'deviceBinarySha256',
    'ALYTE_LLAMA_RUNTIME',
    'Verify pinned Alyte llama.cpp runtime',
  ]) {
    assert.equal(podspecSource.includes(value), true, value);
  }
  assert.equal(
    podspecSource.includes(
      "raise 'AlyteLocalModels requires ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK",
    ),
    true,
  );
  assert.equal(runtimeSource.includes('#if defined(ALYTE_LLAMA_RUNTIME)'), true);
  assert.equal(runtimeSource.includes('llama_model_load_from_file'), true);
});
