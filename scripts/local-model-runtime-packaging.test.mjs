import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const podspec = join(root, 'apps/mobile/modules/alyte-local-models/ios/AlyteLocalModels.podspec');
const stagingHelper = join(root, 'apps/mobile/modules/alyte-local-models/ios/stage-runtime.rb');
const stagedRuntime = join(
  root,
  'apps/mobile/modules/alyte-local-models/ios/Vendor',
);
const revision = 'bb4caa7540188872173c44d161602d9271386413';

function makeRuntime(binaryContents = 'synthetic pinned llama runtime') {
  const runtime = mkdtempSync(join(tmpdir(), 'alyte-pod-runtime-'));
  const framework = join(runtime, 'ios-arm64', 'llama.framework');
  mkdirSync(join(framework, 'Headers'), { recursive: true });
  writeFileSync(join(framework, 'Headers', 'llama.h'), 'synthetic llama header');
  const binary = Buffer.from(binaryContents);
  writeFileSync(join(framework, 'llama'), binary);
  writeFileSync(
    `${runtime}.alyte-eval.json`,
    `${JSON.stringify({
      runtimeRepository: 'ggml-org/llama.cpp',
      runtimeRelease: 'v0.2.0',
      runtimeRevision: revision,
      sourceRevision: revision,
      platform: 'ios-device',
      module: 'llama',
      frameworkPath: runtime,
      deviceBinarySha256: createHash('sha256').update(binary).digest('hex'),
    })}\n`,
  );
  return runtime;
}

function updateBinary(runtime, contents) {
  const binary = Buffer.from(contents);
  writeFileSync(join(runtime, 'ios-arm64', 'llama.framework', 'llama'), binary);
  const manifestPath = `${runtime}.alyte-eval.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.deviceBinarySha256 = createHash('sha256').update(binary).digest('hex');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
}

function runStage(runtime, stage) {
  return spawnSync('ruby', [stagingHelper, runtime, stage], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('runtime staging atomically refreshes and rejects a tampered external artifact', () => {
  const runtime = makeRuntime('first runtime');
  const stage = join(mkdtempSync(join(tmpdir(), 'alyte-pod-stage-')), 'runtime');
  try {
    const first = runStage(runtime, stage);
    assert.equal(first.status, 0, first.stderr);
    const markerPath = join(stage, '.alyte-runtime.json');
    const firstMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(firstMarker.runtimeRevision, revision);
    assert.equal(
      firstMarker.deviceBinarySha256,
      createHash('sha256')
        .update(readFileSync(join(runtime, 'ios-arm64/llama.framework/llama')))
        .digest('hex'),
    );
    assert.deepEqual(
      readFileSync(join(stage, 'llama.framework/llama')),
      readFileSync(join(runtime, 'ios-arm64/llama.framework/llama')),
    );

    updateBinary(runtime, 'second runtime');
    const second = runStage(runtime, stage);
    assert.equal(second.status, 0, second.stderr);
    const secondMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.notEqual(secondMarker.deviceBinarySha256, firstMarker.deviceBinarySha256);
    assert.deepEqual(
      readFileSync(join(stage, 'llama.framework/llama')),
      readFileSync(join(runtime, 'ios-arm64/llama.framework/llama')),
    );

    const manifestPath = `${runtime}.alyte-eval.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.runtimeRevision = 'tampered';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const rejected = runStage(runtime, stage);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /identity\.runtimeRevision/);
    assert.equal(
      JSON.parse(readFileSync(markerPath, 'utf8')).deviceBinarySha256,
      secondMarker.deviceBinarySha256,
      'an invalid selected runtime must not replace the last valid stage',
    );
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(`${runtime}.alyte-eval.json`, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
});

test('podspec exposes a relative staged framework and keeps external provenance in the build phase', () => {
  const runtime = makeRuntime();
  try {
    const result = spawnSync('pod', ['ipc', 'spec', podspec], {
      cwd: root,
      env: { ...process.env, ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK: runtime },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const spec = JSON.parse(result.stdout);
    assert.equal(spec.source.path, '.');
    assert.equal(spec.license.type, 'Proprietary');
    assert.equal(spec.vendored_frameworks, 'Vendor/llama.framework');
    assert.equal(isAbsolute(spec.vendored_frameworks), false);
    assert.equal(spec.vendored_frameworks.split('/').some((part) => part.startsWith('.')), false);
    assert.equal(
      (spec.exclude_files ?? []).some((pattern) => pattern.includes('Vendor')),
      false,
      'source selection must not exclude the visible vendored framework',
    );
    assert.match(spec.pod_target_xcconfig.HEADER_SEARCH_PATHS, /PODS_TARGET_SRCROOT/);
    assert.equal(spec.script_phases.name, 'Verify pinned Alyte llama.cpp runtime');
    assert.match(spec.script_phases.script, /check-local-model-runtime\.mjs/);
    assert.match(
      spec.script_phases.script,
      new RegExp(runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    const marker = JSON.parse(readFileSync(join(stagedRuntime, '.alyte-runtime.json'), 'utf8'));
    assert.equal(marker.sourceFrameworkPath, join(runtime, 'ios-arm64/llama.framework'));
    assert.deepEqual(
      readFileSync(join(stagedRuntime, 'llama.framework/llama')),
      readFileSync(join(runtime, 'ios-arm64/llama.framework/llama')),
    );
  } finally {
    rmSync(runtime, { recursive: true, force: true });
    rmSync(`${runtime}.alyte-eval.json`, { force: true });
    rmSync(stagedRuntime, { recursive: true, force: true });
  }
});
