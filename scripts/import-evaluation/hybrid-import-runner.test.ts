import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRawSnapshotBinding } from './raw-snapshot-binding';
import {
  buildHybridRetryPlan,
  createOverlappingVerticalBands,
  deduplicateExactRows,
} from './hybrid-band-retry';
import { runHybridImport } from './hybrid-import-runner';
import type { EvaluationMeasurement } from './contract';

function measurement(overrides: Partial<EvaluationMeasurement> = {}): EvaluationMeasurement {
  return {
    id: 'm-1',
    sourceLabel: 'Synthetic marker',
    valueString: '1.2',
    valueType: 'numeric',
    parsedValue: 1.2,
    comparator: null,
    unit: 'mg/L',
    referenceInterval: '0-2',
    flag: null,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: 1,
    location: { x: 0.1, y: 0.2, width: 0.2, height: 0.03 },
    ambiguousFields: ['collectionDate', 'specimen'],
    ...overrides,
  };
}

test('builds overlapping full-width bands and marks dense deferred pages', () => {
  const bands = createOverlappingVerticalBands(0.6, 0.2);
  assert.equal(bands[0]?.x, 0);
  assert.equal(bands[0]?.width, 1);
  const lastBand = bands.at(-1);
  assert.ok(lastBand);
  assert.equal(lastBand.y + lastBand.height, 1);
  const plan = buildHybridRetryPlan({
    deferredPageIndexes: [2, 0],
    observationCounts: { 0: 40, 2: 1 },
    routeReasons: { 0: 'empty-observations', 2: 'mixed-or-unknown-provenance' },
    denseObservationThreshold: 10,
  });
  assert.deepEqual(
    plan.pages.map((page) => page.pageIndex),
    [0, 2],
  );
  assert.equal(plan.pages[0]?.dense, true);
  assert.equal(plan.pages[0]?.bands.length, 0);
  assert.equal(plan.pages[1]?.bands.length, 0);
  const retryPlan = buildHybridRetryPlan({
    deferredPageIndexes: [0],
    observationCounts: { 0: 40 },
    reason: 'repetition-detected',
  });
  assert.equal(retryPlan.pages[0]?.bands.length, 4);
});

test('deduplicates exact rows across crop-relative locations', () => {
  const first = measurement();
  const second = measurement({ id: 'm-2', location: { x: 0.1, y: 0.6, width: 0.2, height: 0.03 } });
  const result = deduplicateExactRows([first, second, measurement({ id: 'm-3', page: 2 })]);
  assert.equal(result.measurements.length, 2);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.duplicatePageIndexes, [0]);
});

test('runs Poppler route plus Paddle seam only for deferred pages and writes private artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-hybrid-runner-'));
  chmodSync(root, 0o700);
  const reportPath = join(root, 'reports', 'synthetic.pdf');
  const expectedPath = join(root, 'ground-truth', 'synthetic.json');
  const snapshotPath = join(root, 'raw', 'synthetic.poppler-layout.json');
  const bindingPath = join(root, 'raw', 'synthetic.poppler-layout.binding.json');
  const adapterPath = join(root, 'fake-paddle.mjs');
  mkdirSync(join(root, 'reports'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'ground-truth'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'raw'), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, 'synthetic PDF bytes', { mode: 0o600 });
  const reportSha256 = createHash('sha256').update('synthetic PDF bytes').digest('hex');
  const expected = {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: 'synthetic',
    reportSha256,
    groundTruthVersion: 1,
    review: { status: 'source-checked', method: 'synthetic', reviewedPages: [1], notes: [] },
    measurements: [measurement()],
  };
  writeFileSync(expectedPath, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
  const snapshot = {
    readerVersion: 'alyte.mac.poppler-layout-reader.v1',
    runtimeVersion: 'synthetic-runtime.v1',
    reportSha256,
    readerBinarySha256: '1'.repeat(64),
    readerSourceSha256: '2'.repeat(64),
    sourceTextConstruction: 'poppler-word-lines.v1',
    sourceOffsetKind: 'synthetic-page-text-utf16',
    pageCount: 1,
    pages: [
      {
        pageIndex: 0,
        width: 100,
        height: 100,
        sourceText: null,
        result: { observations: [] },
      },
    ],
  };
  const snapshotText = `${JSON.stringify(snapshot)}\n`;
  writeFileSync(snapshotPath, snapshotText, { mode: 0o600 });
  writeFileSync(
    bindingPath,
    `${JSON.stringify(
      createRawSnapshotBinding(snapshotText, {
        reportSha256,
        readerVersion: snapshot.readerVersion,
        runtimeVersion: snapshot.runtimeVersion,
        readerBinarySha256: snapshot.readerBinarySha256,
        readerSourceSha256: snapshot.readerSourceSha256,
      }),
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    adapterPath,
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
    const report = arg('--report');
    const output = arg('--output');
    const plan = JSON.parse(readFileSync(arg('--plan'), 'utf8'));
    const page = plan.pages[0];
    const reportSha256 = createHash('sha256').update(readFileSync(report)).digest('hex');
    const row = {
      id: 'paddle-1', sourceLabel: plan.reason === 'initial' ? 'Synthetic pathological' : 'Synthetic marker', valueString: '1.2', valueType: 'numeric',
      parsedValue: 1.2, comparator: null, unit: 'mg/L', referenceInterval: '0-2', flag: null,
      collectionDate: null, collectionGroup: null, specimen: null, page: page.pageNumber,
      location: { x: 0.1, y: 0.2, width: 0.2, height: 0.03 },
      ambiguousFields: ['collectionDate', 'specimen'],
    };
    writeFileSync(output, JSON.stringify({
      schemaVersion: 'alyte.import-eval.v1', reportId: 'synthetic', reportSha256,
      pipeline: { id: 'fake-paddle', version: 'synthetic', configuration: { repetitionDetectedPageIndexes: [0] }, runtime: {} },
      stages: [{ name: 'paddle', elapsedMs: 2, inputCount: 1, outputCount: 1, status: 'complete' }],
      elapsedMs: 2, measurements: [row], diagnostics: { counts: {}, limitations: [] },
    }) + '\\n', { mode: 0o600 });
  `,
    { mode: 0o700 },
  );
  chmodSync(adapterPath, 0o700);

  const result = await runHybridImport({
    reportPath,
    reportId: 'synthetic',
    expectedPath,
    privateRoot: root,
    rawSnapshotPath: snapshotPath,
    bindingPath,
    paddleAdapterPath: adapterPath,
    runId: 'synthetic-run',
  });
  assert.deepEqual(
    result.routes.map((route) => route.kind),
    ['unstructured-or-image'],
  );
  assert.equal(result.pipeline.measurements.length, 1);
  assert.equal(result.pipeline.measurements[0]?.sourceLabel, 'Synthetic marker');
  assert.equal(result.aggregate.counts.recoveredMeasurements, 1);
  assert.equal(statSync(result.paths.output).mode & 0o777, 0o600);
  assert.equal(statSync(result.paths.aggregateOutput).mode & 0o777, 0o600);
  assert.equal(result.retryPlan?.reason, 'repetition-detected');
  assert.equal(result.retryPlan?.pages[0]?.bands.length, 4);
  assert.equal(result.pipeline.diagnostics.counts.hybridExactDuplicateRows, 0);
});
