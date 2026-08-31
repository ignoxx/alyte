import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = process.cwd();
const checker = join(root, 'scripts/check-local-model-runtime.mjs');
const revision = 'bb4caa7540188872173c44d161602d9271386413';

function makeRuntime() {
  const runtime = mkdtempSync(join(tmpdir(), 'alyte-local-model-runtime-'));
  const framework = join(runtime, 'ios-arm64', 'llama.framework');
  mkdirSync(join(framework, 'Headers'), { recursive: true });
  writeFileSync(join(framework, 'Headers', 'llama.h'), 'synthetic llama header');
  writeFileSync(join(framework, 'Headers', 'mtmd.h'), 'synthetic mtmd header');
  writeFileSync(join(framework, 'Headers', 'mtmd-helper.h'), 'synthetic mtmd helper header');
  const binary = Buffer.from(
    'synthetic pinned llama runtime mtmd_init_from_file mtmd_helper_bitmap_init_from_buf mtmd_tokenize mtmd_helper_eval_chunks mtmd_input_chunks_free mtmd_bitmap_free mtmd_free',
  );
  writeFileSync(join(framework, 'llama'), binary);
  const digest = createHash('sha256').update(binary).digest('hex');
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
      deviceBinarySha256: digest,
    })}\n`,
  );
  return { runtime, manifest: `${runtime}.alyte-eval.json` };
}

function run(args) {
  return spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
}

test('production/device configuration rejects an omitted pinned runtime', () => {
  const result = run(['--variant', 'production']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing pinned XCFramework/);
});

test('production/device configuration accepts only a verified pinned runtime', () => {
  const fixture = makeRuntime();
  try {
    const result = run(['--variant', 'production', '--runtime-path', fixture.runtime]);
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(
      fixture.manifest,
      readFileSync(fixture.manifest, 'utf8').replace(revision, 'tampered'),
    );
    const tampered = run(['--variant', 'production', '--runtime-path', fixture.runtime]);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /runtimeRevision/);
  } finally {
    rmSync(fixture.runtime, { recursive: true, force: true });
    rmSync(fixture.manifest, { force: true });
  }
});

test('simulator fake is explicit and cannot be used by production', () => {
  const simulator = run(['--variant', 'development', '--allow-simulator-fake']);
  assert.equal(simulator.status, 0, simulator.stderr);
  const production = run(['--variant', 'production', '--allow-simulator-fake']);
  assert.notEqual(production.status, 0);
});
