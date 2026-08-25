import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertAggregatePrivacy } from './model-evaluation-aggregate-scrub.mjs';

const project = fs.readFileSync(
  'apps/model-evaluation/AlyteModelEvaluation.xcodeproj/project.pbxproj',
  'utf8',
);
const runner = fs.readFileSync('scripts/run-model-evaluation-device.sh', 'utf8');
const llamaShim = fs.readFileSync(
  'apps/model-evaluation/Sources/AlyteModelEvaluation/AlyteLlamaShim.c',
  'utf8',
);
const hashScript = resolve('scripts/hash-unsigned-binary.sh');

test('evaluator embeds the selected device framework slice, not the xcframework wrapper', () => {
  assert.match(
    project,
    /explicitFileType = wrapper\.framework; name = llama\.framework; path = "\$\(ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK\)\/ios-arm64\/llama\.framework";/,
  );
  assert.match(project, /ATTRIBUTES = \(CodeSignOnCopy, RemoveHeadersOnCopy,\);/);
  assert.doesNotMatch(project, /explicitFileType = wrapper\.xcframework/);
  assert.match(
    project,
    /LD_RUNPATH_SEARCH_PATHS = \("\$\(inherited\)", "@executable_path\/Frameworks", "@loader_path\/Frameworks", "\/usr\/lib\/swift"\);/g,
  );
  assert.equal(
    project.match(/LD_RUNPATH_SEARCH_PATHS = /g)?.length,
    2,
    'Debug and Release app configurations must both resolve embedded frameworks',
  );
});

test('device runner rejects a linked-but-unembedded or unsigned runtime before install', () => {
  assert.match(runner, /embedded_framework="\$\{app_path\}\/Frameworks\/llama\.framework"/);
  assert.match(runner, /embedded_binary="\$\{embedded_framework\}\/llama"/);
  assert.match(
    runner,
    /if ! embedded_binary_sha256="\$\("\$\{repo_root\}\/scripts\/hash-unsigned-binary\.sh"/,
  );
  assert.match(
    runner,
    /if ! device_binary_sha256="\$\("\$\{repo_root\}\/scripts\/hash-unsigned-binary\.sh"/,
  );
  assert.match(
    runner,
    /Embedded llama\.framework does not match the pinned runtime identity manifest/,
  );
  assert.match(runner, /codesign --verify --strict --verbose=2 "\$\{embedded_framework\}"/);
  assert.match(runner, /codesign --verify --deep --strict --verbose=2 "\$\{app_path\}"/);
});

test('device runner selects the pinned candidate artifact and external contract', () => {
  assert.match(runner, /candidate="\$\{ALYTE_MODEL_EVAL_CANDIDATE:-qwen\}"/);
  assert.match(runner, /gemma4\)/);
  assert.match(runner, /model_filename="gemma-4-E2B-it-Q4_0\.gguf"/);
  assert.match(runner, /model_bytes="2841481184"/);
  assert.match(
    runner,
    /model_sha256="8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52"/,
  );
  assert.match(runner, /ALYTE_MODEL_EVAL_CONTRACT_PATH/);
  assert.match(runner, /model_repository="ggml-org\/gemma-4-E2B-it-GGUF"/);
  assert.match(runner, /model_revision="b4243c156154b6dca9324415f8c7ccc098b4aed1"/);
  assert.match(runner, /source_model_repository="google\/gemma-4-E2B-it"/);
  assert.match(runner, /source_model_revision="3e22461f65e89153144f8adb70e3b8c2cc9845a7"/);
  assert.match(runner, /expected_prompt_bundle_version="alyte\.gemma4-e2b-evaluation\.prompt\.v2"/);
  assert.match(runner, /contract_optional_field promptBundleVersion/);
  assert.match(runner, /runtime_repository="ggml-org\/llama\.cpp"/);
  assert.match(runner, /runtime_revision="bb4caa7540188872173c44d161602d9271386413"/);
  assert.match(runner, /contract_source_model_field/);
  assert.match(runner, /Evaluation contract provenance does not match candidate/);
  assert.match(runner, /ALYTE_MODEL_EVAL_CANDIDATE="\$\{candidate\}"/);
  assert.match(runner, /--destination "\$\{device_relative_directory\}\/\$\{model_filename\}"/);
});

test('device runner separates CoreDevice and Xcode destination IDs and accepts connected devices', () => {
  assert.match(
    runner,
    /eval_device_coredevice_id="\$\{ALYTE_MODEL_EVAL_DEVICE_UDID:-9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9\}"/,
  );
  assert.match(runner, /eval_device_xcode_id="\$\{ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID:-\}"/);
  assert.match(runner, /devicectl list devices 2>&1/);
  assert.match(
    runner,
    /reported state '\$\{device_state:-unknown\}'; expected connected or available/,
  );
  assert.match(runner, /case "\$\{device_state\}" in\n  connected\|available/);
  assert.match(runner, /device info details/);
  assert.match(runner, /details\.result\?\.hardwareProperties\?\.udid/);
  assert.match(runner, /--device "\$\{eval_device_coredevice_id\}"/);
  assert.match(runner, /-destination "id=\$\{eval_device_xcode_id\}"/);
});

test('aggregate privacy scrub allows aggregate metrics but rejects nested raw content', () => {
  assert.doesNotThrow(() =>
    assertAggregatePrivacy({
      sourceFactsPreservedCount: 2,
      nested: [{ reviewBurden: 10, label: 'aggregate-only' }],
    }),
  );
  assert.throws(
    () => assertAggregatePrivacy({ nested: [{ rawModelOutput: '{}' }] }),
    /forbidden field/,
  );
  assert.throws(
    () => assertAggregatePrivacy({ nested: { sourceObservationIds: ['synthetic-id'] } }),
    /forbidden field/,
  );
  assert.throws(
    () => assertAggregatePrivacy({ nested: { promptText: 'not retained' } }),
    /forbidden field/,
  );
  assert.throws(
    () => assertAggregatePrivacy({ nested: { status: 'prefix <|turn> suffix' } }),
    /chat control marker/,
  );
  assert.throws(() => assertAggregatePrivacy({ sourceFactsPreservedCount: '2' }), /invalid shape/);
});

test('native bridge honors llama token sizing and bounded prefill', () => {
  assert.match(llamaShim, /required_probe < 0 \? -required_probe : required_probe/);
  assert.match(llamaShim, /session->batch_tokens = batch_tokens/);
  assert.match(llamaShim, /for \(int offset = 0; offset < prompt_count; \)/);
  assert.match(llamaShim, /ALYTE_LLAMA_STATUS_PROMPT_DECODE_FAILED/);
});

test('binary identity hashing accepts normal signing representation but rejects tampering', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'alyte-eval-embedding-test-'));
  const toolDirectory = join(temporaryDirectory, 'tools');
  fs.mkdirSync(toolDirectory);
  const sourcePath = join(temporaryDirectory, 'source');
  const embeddedPath = join(temporaryDirectory, 'embedded');
  const tamperedPath = join(temporaryDirectory, 'tampered');
  const baseEnvironment = {
    ...process.env,
    TMPDIR: temporaryDirectory,
  };

  try {
    execFileSync('lipo', ['-thin', 'arm64e', '/usr/bin/true', '-output', sourcePath]);
    execFileSync('codesign', ['--remove-signature', sourcePath]);
    fs.copyFileSync(sourcePath, embeddedPath);
    execFileSync('codesign', ['--force', '--sign', '-', embeddedPath]);
    const valid = spawnSync('zsh', [hashScript, sourcePath], {
      env: baseEnvironment,
      encoding: 'utf8',
    });
    assert.equal(valid.status, 0, valid.stderr);

    const embedded = spawnSync('zsh', [hashScript, embeddedPath], {
      env: baseEnvironment,
      encoding: 'utf8',
    });
    assert.equal(embedded.status, 0, embedded.stderr);
    assert.equal(valid.stdout.trim(), embedded.stdout.trim());

    const tampered = Buffer.from(fs.readFileSync(embeddedPath));
    tampered[4096] ^= 0xff;
    writeFileSync(tamperedPath, tampered);
    const tamperedResult = spawnSync('zsh', [hashScript, tamperedPath], {
      env: baseEnvironment,
      encoding: 'utf8',
    });
    assert.equal(tamperedResult.status, 0, tamperedResult.stderr);
    assert.notEqual(tamperedResult.stdout.trim(), valid.stdout.trim());
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('binary identity hashing fails closed and cleans up when setup, copy, or hashing fails', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'alyte-eval-embedding-failure-test-'));
  const toolDirectory = join(temporaryDirectory, 'tools');
  fs.mkdirSync(toolDirectory);
  const binaryPath = join(temporaryDirectory, 'binary');
  writeFileSync(binaryPath, Buffer.from('synthetic runtime bytes\n', 'utf8'));
  const baseEnvironment = {
    ...process.env,
    TMPDIR: temporaryDirectory,
  };

  try {
    const missing = spawnSync('zsh', [hashScript, join(temporaryDirectory, 'missing')], {
      env: baseEnvironment,
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);

    const failingDitto = join(toolDirectory, 'ditto');
    writeFileSync(failingDitto, '#!/bin/zsh\nexit 41\n');
    chmodSync(failingDitto, 0o755);
    const copyFailure = spawnSync('zsh', [hashScript, binaryPath], {
      env: { ...baseEnvironment, PATH: `${toolDirectory}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.notEqual(copyFailure.status, 0);

    const failingNode = join(toolDirectory, 'node');
    writeFileSync(failingNode, '#!/bin/zsh\nexit 42\n');
    chmodSync(failingNode, 0o755);
    const hashFailure = spawnSync('zsh', [hashScript, binaryPath], {
      env: { ...baseEnvironment, PATH: `${toolDirectory}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.notEqual(hashFailure.status, 0);
    assert.deepEqual(
      readdirSync(temporaryDirectory).filter((entry) => entry.startsWith('alyte-eval-llama-hash.')),
      [],
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
