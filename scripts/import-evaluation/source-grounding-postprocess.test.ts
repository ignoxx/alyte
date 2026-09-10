import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { convertModelProposals, runSourceGrounding } from './source-grounding-postprocess';

test('converts every full-runner model proposal before grounding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-source-grounding-postprocess-'));
  chmodSync(root, 0o700);
  const modulePath = join(root, 'grounder.mjs');
  writeFileSync(
    modulePath,
    `import { readFileSync } from 'node:fs';
export function runGrounding(options) {
  const pipeline = JSON.parse(readFileSync(options.proposalsPath, 'utf8'));
  return { options, measurements: pipeline.measurements, stages: pipeline.stages, elapsedMs: pipeline.elapsedMs };
}
`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const modelProposals = Array.from({ length: 77 }, (_, index) => ({
    label: `Label ${index + 1}`,
    value: String(index + 1),
    rawValue: index + 1,
    unit: null,
    reference: null,
    flag: null,
    page: (index % 4) + 1,
  }));
  writeFileSync(
    join(root, 'pipeline.json'),
    JSON.stringify({
      schemaVersion: 'alyte.import-eval.v1',
      reportId: 'synthetic',
      reportSha256: '1'.repeat(64),
      pipeline: { id: 'fullrunner', version: 'v1', configuration: { model: 'local' }, runtime: {} },
      stages: [
        { name: 'model', elapsedMs: 7, status: 'complete' },
        { name: 'source-grounding', elapsedMs: 2, status: 'complete' },
      ],
      elapsedMs: 9,
      measurements: Array.from({ length: 62 }, () => ({})),
      modelProposals,
      diagnostics: { counts: { groundedMeasurements: 62 }, limitations: [] },
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const result = (await runSourceGrounding({
    proposalsPath: join(root, 'pipeline.json'),
    sourcePath: join(root, 'source.json'),
    bindingPath: join(root, 'source.binding.json'),
    outputPath: join(root, 'grounded.json'),
    privateRoot: root,
    groundingModulePath: modulePath,
  })) as {
    readonly options: Record<string, unknown>;
    readonly measurements: readonly unknown[];
    readonly stages: readonly { readonly name: string }[];
    readonly elapsedMs: number;
  };
  assert.equal(result.options.proposalsPath, join(root, 'grounded.model-proposals.json'));
  assert.equal(result.options.visionPath, join(root, 'source.json'));
  assert.equal(result.options.bindingPath, join(root, 'source.binding.json'));
  assert.equal(result.options.outputPath, join(root, 'grounded.json'));
  assert.equal(result.options.privateRoot, root);
  assert.equal(result.measurements.length, 77);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].name, 'model');
  assert.equal(result.elapsedMs, 7);
});

test('keeps model values unresolved until native grounding', () => {
  const [measurement] = convertModelProposals([
    {
      label: 'Arbitrary marker',
      value: '5,2',
      rawValue: 5.2,
      unit: 'mg/L',
      reference: '1-9',
      flag: 'H',
      page: 2,
    },
  ]);
  assert.equal(measurement?.id, 'fullrunner-model-proposal-0001');
  assert.equal(measurement?.sourceLabel, 'Arbitrary marker');
  assert.equal(measurement?.valueString, '5,2');
  assert.equal(measurement?.valueType, 'unknown');
  assert.equal(measurement?.parsedValue, null);
  assert.equal(measurement?.comparator, null);
  assert.equal(measurement?.referenceInterval, '1-9');
  assert.equal(measurement?.page, 2);
});
