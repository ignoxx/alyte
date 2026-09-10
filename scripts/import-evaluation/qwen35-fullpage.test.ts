import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseLocaleArgument,
  parsePageSelection,
  resolveSelectedPages,
} from './qwen35-fullpage.ts';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('full-page runner defaults locale to en-US and accepts Lithuanian locale', () => {
  assert.equal(parseLocaleArgument(undefined), 'en-US');
  assert.equal(parseLocaleArgument('lt-LT'), 'lt-LT');
});

test('full-page runner rejects malformed locale values', () => {
  assert.throws(() => parseLocaleArgument('lt_LT'), /qwen35-fullpage-locale-invalid/u);
  assert.throws(() => parseLocaleArgument(''), /qwen35-fullpage-locale-invalid/u);
});

test('full-page runner parses and validates one-based selected pages', () => {
  assert.deepEqual(parsePageSelection('3,1,3'), [1, 3]);
  assert.deepEqual(resolveSelectedPages(4, '3,1,3'), [1, 3]);
  assert.deepEqual(resolveSelectedPages(3, undefined), [1, 2, 3]);
  assert.throws(() => parsePageSelection('0'), /qwen35-fullpage-pages-invalid/u);
  assert.throws(() => parsePageSelection('3,x'), /qwen35-fullpage-pages-invalid/u);
  assert.throws(() => resolveSelectedPages(2, '3'), /qwen35-fullpage-pages-out-of-range/u);
});

test('full-page runner imports the Qwen3.5 adapter and passes explicit dense-page limits', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-qwen35-fullpage-'));
  const sourceImageDir = join(root, 'source');
  mkdirSync(sourceImageDir, { recursive: true, mode: 0o700 });
  const report = join(root, 'report.pdf');
  const image = join(sourceImageDir, 'en-01.png');
  const binary = join(root, 'fake-llama-mtmd-cli');
  const model = join(root, 'model.gguf');
  const mmproj = join(root, 'mmproj.gguf');
  const output = join(root, 'out', 'result.json');
  writeFileSync(report, 'synthetic report bytes', { mode: 0o600 });
  writeFileSync(image, 'synthetic image bytes', { mode: 0o600 });
  writeFileSync(model, 'synthetic model bytes', { mode: 0o600 });
  writeFileSync(mmproj, 'synthetic projector bytes', { mode: 0o600 });
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s' 'fake-llama-mtmd'
  exit 0
fi
printf '%s\n' "$@" > "$PWD/invocation-args.txt"
printf '%s' '{"rows":[{"label":"Analyte","value":"42","unit":"mg/L","reference_interval":null,"flag":null}]}'
`,
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);

  const script = join(dirname(fileURLToPath(import.meta.url)), 'qwen35-fullpage.ts');
  const adapter = join(dirname(fileURLToPath(import.meta.url)), 'qwen35-mac-cli.ts');
  const tsxLoader = resolve('node_modules/tsx/dist/loader.mjs');
  execFileSync(
    process.execPath,
    [
      '--import',
      tsxLoader,
      script,
      '--report',
      report,
      '--report-id',
      'en',
      '--page-count',
      '1',
      '--source-image-dir',
      sourceImageDir,
      '--adapter',
      adapter,
      '--private-root',
      root,
      '--output',
      output,
      '--qwen-binary',
      binary,
      '--model',
      model,
      '--mmproj',
      mmproj,
      '--model-id',
      'synthetic-qwen35',
      '--model-revision',
      'synthetic-revision',
      '--model-expected-sha256',
      sha256(model),
      '--projector-expected-sha256',
      sha256(mmproj),
      '--runtime-revision',
      'synthetic-runtime',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const result = JSON.parse(readFileSync(output, 'utf8')) as {
    readonly measurements: readonly unknown[];
    readonly diagnostics: { readonly counts: Record<string, number> };
    readonly pipeline: {
      readonly configuration: {
        readonly model: {
          readonly cliConfiguration: {
            readonly contextTokens: number;
            readonly maxOutputTokens: number;
          };
        };
      };
    };
  };
  assert.equal(result.measurements.length, 1);
  assert.equal(result.diagnostics.counts.pageFailures, 0);
  assert.equal(result.pipeline.configuration.model.cliConfiguration.contextTokens, 12_288);
  assert.equal(result.pipeline.configuration.model.cliConfiguration.maxOutputTokens, 8_192);
  const invocation = readFileSync(join(root, 'invocation-args.txt'), 'utf8');
  assert.match(invocation, /--ctx-size\n12288\n/u);
  assert.match(invocation, /--n-predict\n8192\n/u);
});
