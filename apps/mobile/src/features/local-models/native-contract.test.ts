import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const mobileRoot = process.cwd().endsWith('apps/mobile')
  ? process.cwd()
  : resolve(process.cwd(), 'apps/mobile');
const nativeRoot = resolve(mobileRoot, 'modules/alyte-local-models/ios');
const manifestSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelManifest.swift'), 'utf8');
const storeSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelStore.swift'), 'utf8');
const moduleSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelsModule.swift'), 'utf8');
const podspecSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModels.podspec'), 'utf8');
const runtimeSource = readFileSync(resolve(nativeRoot, 'AlyteLocalModelRuntime.c'), 'utf8');

test('native manifest mirrors the immutable production pack contract', () => {
  for (const value of [
    'gemma-4-e2b-it-q4-0',
    '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
    'b4243c156154b6dca9324415f8c7ccc098b4aed1',
    'gemma-4-E2B-it-Q4_0.gguf',
    '2_841_481_184',
    '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    'bb4caa7540188872173c44d161602d9271386413',
    'alyte.semantic-mapper.prompt.v1',
    'alyte.semantic-mapper.v1',
  ]) {
    assert.equal(manifestSource.includes(value), true, value);
  }
  assert.equal(manifestSource.includes('/main/'), false);
  assert.equal(manifestSource.includes('pickle'), false);
  assert.equal(manifestSource.includes('Authorization'), false);
});

test('native store owns resumable verification, protection, promotion, and release hooks', () => {
  for (const value of [
    'URLSessionDataDelegate',
    'Range',
    'SHA256',
    'FileProtectionType.complete',
    'isExcludedFromBackup',
    'replaceItemAt(ready, withItemAt: partial',
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
