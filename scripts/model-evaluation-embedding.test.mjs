import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const project = fs.readFileSync(
  'apps/model-evaluation/AlyteModelEvaluation.xcodeproj/project.pbxproj',
  'utf8',
);
const runner = fs.readFileSync('scripts/run-model-evaluation-device.sh', 'utf8');
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

test('binary identity hashing fails closed and cleans up when setup, copy, or hashing fails', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'alyte-eval-embedding-test-'));
  const toolDirectory = join(temporaryDirectory, 'tools');
  fs.mkdirSync(toolDirectory);
  const binaryPath = join(temporaryDirectory, 'binary');
  const binary = Buffer.from('synthetic runtime bytes\n', 'utf8');
  writeFileSync(binaryPath, binary);
  const expectedHash = crypto.createHash('sha256').update(binary).digest('hex');
  const baseEnvironment = {
    ...process.env,
    TMPDIR: temporaryDirectory,
  };

  try {
    const valid = spawnSync('zsh', [hashScript, binaryPath], {
      env: baseEnvironment,
      encoding: 'utf8',
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout.trim(), expectedHash);

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

    const failingShasum = join(toolDirectory, 'shasum');
    writeFileSync(failingShasum, '#!/bin/zsh\nexit 42\n');
    chmodSync(failingShasum, 0o755);
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
