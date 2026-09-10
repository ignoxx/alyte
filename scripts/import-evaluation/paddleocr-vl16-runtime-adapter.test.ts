import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildHybridRetryPlan } from './hybrid-band-retry';
import { PADDLE_OCR_VL16_PROMPT, runPaddleOcrV16Runtime } from './paddleocr-vl16-runtime-adapter';

function fixtureRoot(): string {
  const root = mkdtempSync('/private/tmp/paddleocr-vl16-runtime-');
  chmodSync(root, 0o700);
  return root;
}

function writeRuntime(root: string): { readonly path: string; readonly log: string } {
  const path = join(root, 'fake-llama-mtmd');
  const log = join(root, 'runtime-args.log');
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
umask 077
printf '%s\\n' "$@" >> "$FAKE_PADDLE_ARGS_LOG"
case "$*" in
  *-full-v1.png*)
    # Repeated three-line block: this exercises the generic repetition guard without
    # depending on a single ordinary line being repeated.
    printf '%s\\n' 'PaddleOCR-VL heading' 'PaddleOCR-VL body' 'PaddleOCR-VL footer' \\
      'PaddleOCR-VL heading' 'PaddleOCR-VL body' 'PaddleOCR-VL footer'
    ;;
  *)
    printf '%s\\n' 'Synthetic Marker 12 mg/dL 0-20'
    ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return { path, log };
}

function writeModelFixtures(root: string): {
  readonly modelPath: string;
  readonly projectorPath: string;
} {
  const modelPath = join(root, 'paddleocr-vl16-q8.gguf');
  const projectorPath = join(root, 'paddleocr-vl16-q8.mmproj.gguf');
  writeFileSync(modelPath, 'synthetic q8 model', { mode: 0o600 });
  writeFileSync(projectorPath, 'synthetic q8 projector', { mode: 0o600 });
  return { modelPath, projectorPath };
}

function plan(reason: 'initial' | 'repetition-detected') {
  return buildHybridRetryPlan({
    deferredPageIndexes: [0],
    observationCounts: { 0: 0 },
    reason,
  });
}

function renderer() {
  return ({ outputPath }: { readonly outputPath: string }) => {
    writeFileSync(outputPath, 'synthetic rendered image', { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    return { imagePath: outputPath, width: 100, height: 100 };
  };
}

test('pathological full-page output is stored, omitted, and requests a band retry', async () => {
  const root = fixtureRoot();
  const previousLog = process.env.FAKE_PADDLE_ARGS_LOG;
  try {
    const reportPath = join(root, 'report.pdf');
    const outputPath = join(root, 'run', 'result.json');
    const runtime = writeRuntime(root);
    const models = writeModelFixtures(root);
    writeFileSync(reportPath, 'synthetic report', { mode: 0o600 });
    process.env.FAKE_PADDLE_ARGS_LOG = runtime.log;

    const result = await runPaddleOcrV16Runtime({
      reportPath,
      reportId: 'synthetic',
      privateRoot: root,
      outputPath,
      plan: plan('initial'),
      retry: false,
      modelPath: models.modelPath,
      projectorPath: models.projectorPath,
      runtimePath: runtime.path,
      renderer: renderer(),
    });

    assert.deepEqual(result.pipeline.measurements, []);
    assert.deepEqual(result.repetitionDetectedPageIndexes, [0]);
    assert.deepEqual(result.pipeline.pipeline.configuration.retryPageIndexes, [0]);
    assert.equal(result.pipeline.diagnostics.counts.pathologicalResponses, 1);
    assert.equal(result.pipeline.diagnostics.counts.acceptedRawResponses, 0);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    const rawPath = join(
      root,
      'raw',
      'paddleocr-vl16-runtime',
      'synthetic',
      'initial',
      'page-1',
      'paddleocr-vl16-q8-synthetic-page1-full-v1.raw.txt',
    );
    assert.equal(
      readFileSync(rawPath, 'utf8').trim(),
      'PaddleOCR-VL heading\nPaddleOCR-VL body\nPaddleOCR-VL footer\n' +
        'PaddleOCR-VL heading\nPaddleOCR-VL body\nPaddleOCR-VL footer',
    );
    assert.equal(statSync(rawPath).mode & 0o777, 0o600);
    assert.equal((result.pipeline.pipeline.configuration.modelSha256 as string).length, 64);
    assert.equal((result.pipeline.pipeline.configuration.projectorSha256 as string).length, 64);
    assert.equal((result.pipeline.pipeline.configuration.runtimeSha256 as string).length, 64);
    assert.ok(
      (result.pipeline.stages.find((stage) => stage.name === 'paddle-local-pdf-render')
        ?.elapsedMs ?? -1) >= 0,
    );
    assert.ok(
      (result.pipeline.stages.find((stage) => stage.name === 'paddle-local-llama-mtmd-inference')
        ?.elapsedMs ?? -1) >= 0,
    );
    const args = readFileSync(runtime.log, 'utf8').split('\n').filter(Boolean);
    assert.ok(args.includes(PADDLE_OCR_VL16_PROMPT));
    assert.deepEqual(
      ['--temp', '--top-p', '--top-k', '--seed', '--ctx-size'].map((flag) => args.includes(flag)),
      [true, true, true, true, true],
    );
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_PADDLE_ARGS_LOG;
    else process.env.FAKE_PADDLE_ARGS_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('retry plan renders every overlapping band and admits rows through the v2 parser', async () => {
  const root = fixtureRoot();
  const previousLog = process.env.FAKE_PADDLE_ARGS_LOG;
  try {
    const reportPath = join(root, 'report.pdf');
    const outputPath = join(root, 'run', 'result.json');
    const runtime = writeRuntime(root);
    const models = writeModelFixtures(root);
    writeFileSync(reportPath, 'synthetic report', { mode: 0o600 });
    process.env.FAKE_PADDLE_ARGS_LOG = runtime.log;

    const result = await runPaddleOcrV16Runtime({
      reportPath,
      reportId: 'synthetic',
      privateRoot: root,
      outputPath,
      plan: plan('repetition-detected'),
      retry: true,
      modelPath: models.modelPath,
      projectorPath: models.projectorPath,
      runtimePath: runtime.path,
      renderer: renderer(),
    });

    assert.equal(result.pipeline.measurements.length, 1);
    assert.equal(result.pipeline.measurements[0]?.sourceLabel, 'Synthetic Marker');
    assert.equal(result.pipeline.measurements[0]?.sourceIds?.[0], 'p1-band1-line1');
    assert.equal(result.pipeline.diagnostics.counts.plannedAttempts, 4);
    assert.equal(result.pipeline.diagnostics.counts.renderedImages, 4);
    assert.equal(result.pipeline.diagnostics.counts.inferenceResponses, 4);
    assert.deepEqual(result.repetitionDetectedPageIndexes, []);
    assert.equal(result.pipeline.pipeline.configuration.retry, true);
    assert.equal(
      (result.pipeline.pipeline.configuration.rawResponseFiles as readonly string[]).length,
      4,
    );
    assert.equal(result.attemptTimings.length, 4);
    assert.ok(result.attemptTimings.every((timing) => timing.status === 'complete'));
    assert.equal(result.pageTimings[0]?.attempts, 4);
    assert.equal(result.pageTimings[0]?.status, 'complete');
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_PADDLE_ARGS_LOG;
    else process.env.FAKE_PADDLE_ARGS_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI invokes a fake llama-mtmd runtime with the OCR prompt and deterministic decoder', async () => {
  const root = fixtureRoot();
  try {
    const reportPath = join(root, 'report.pdf');
    const outputPath = join(root, 'run', 'result.json');
    const helperPath = join(root, 'fake-render-helper.sh');
    const runtimePath = join(root, 'fake-llama-mtmd');
    const argsPath = join(root, 'runtime-args.log');
    const models = writeModelFixtures(root);
    writeFileSync(reportPath, 'synthetic report', { mode: 0o600 });
    writeFileSync(
      helperPath,
      `#!/bin/sh
set -eu
umask 077
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then output="$2"; shift 2; else shift; fi
done
printf 'synthetic image' > "$output"
`,
      { mode: 0o700 },
    );
    chmodSync(helperPath, 0o700);
    writeFileSync(
      runtimePath,
      `#!/bin/sh
set -eu
umask 077
printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' 'Synthetic runtime row 3 mg/L 0-4'
`,
      { mode: 0o700 },
    );
    chmodSync(runtimePath, 0o700);

    const result = await runPaddleOcrV16Runtime({
      reportPath,
      reportId: 'synthetic',
      privateRoot: root,
      outputPath,
      plan: plan('initial'),
      retry: false,
      modelPath: models.modelPath,
      projectorPath: models.projectorPath,
      runtimePath,
      renderHelperPath: helperPath,
    });

    assert.equal(result.pipeline.measurements.length, 1);
    assert.equal(result.pipeline.measurements[0]?.sourceLabel, 'Synthetic runtime row');
    const args = readFileSync(argsPath, 'utf8').split('\n').filter(Boolean);
    assert.ok(args.includes(PADDLE_OCR_VL16_PROMPT));
    assert.ok(args.includes('--temp'));
    assert.ok(args.includes('--top-p'));
    assert.ok(args.includes('--top-k'));
    assert.ok(args.includes('--seed'));
    assert.ok(args.includes('--ctx-size'));
    assert.equal(
      result.pipeline.pipeline.configuration.modelSha256,
      createHash('sha256').update('synthetic q8 model').digest('hex'),
    );
    assert.equal(
      result.pipeline.pipeline.configuration.projectorSha256,
      createHash('sha256').update('synthetic q8 projector').digest('hex'),
    );
    assert.equal((result.pipeline.pipeline.configuration.runtimeSha256 as string).length, 64);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(
      statSync(
        join(
          root,
          'raw',
          'paddleocr-vl16-runtime',
          'synthetic',
          'initial',
          'page-1',
          'paddleocr-vl16-q8-synthetic-page1-full-v1.raw.txt',
        ),
      ).mode & 0o777,
      0o600,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
