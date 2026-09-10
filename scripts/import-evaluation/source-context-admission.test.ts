import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applySourceContextAdmission,
  runSourceContextAdmission,
  type RawSnapshotBindingModule,
} from './source-context-admission';
import type { VisionObservation, VisionPage } from './qwen35-grounding';
import type { EvaluationMeasurement, PipelineResult } from './contract';

const REPORT_BYTES = Buffer.from('source-context-report');
const REPORT_SHA256 = createHash('sha256').update(REPORT_BYTES).digest('hex');

function measurement(overrides: Partial<EvaluationMeasurement> = {}): EvaluationMeasurement {
  return {
    id: 'measurement-1',
    sourceLabel: 'Marker Alpha',
    valueString: '10',
    valueType: 'numeric',
    parsedValue: 10,
    comparator: '=',
    unit: 'unit-a',
    referenceInterval: '1-20',
    flag: null,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: 1,
    location: null,
    ambiguousFields: [],
    ...overrides,
  };
}

function pipeline(measurements: readonly EvaluationMeasurement[]): PipelineResult {
  return {
    schemaVersion: 'alyte.import-eval.v1',
    reportId: 'synthetic',
    reportSha256: REPORT_SHA256,
    pipeline: { id: 'synthetic-pipeline', version: '1', configuration: {}, runtime: {} },
    stages: [{ name: 'grounding', elapsedMs: 4, status: 'success' }],
    elapsedMs: 5,
    measurements,
    diagnostics: { counts: {}, limitations: [] },
  };
}

function observation(id: string, text: string, y = 0.1): VisionObservation {
  return {
    id,
    text,
    pageIndex: 0,
    boundingBox: { x: 0.1, y, width: 0.1, height: 0.02 },
  };
}

function rawEnvelope(pages: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    readerVersion: 'synthetic-reader.v1',
    reportSha256: REPORT_SHA256,
    runtimeVersion: 'synthetic-runtime.v1',
    pages,
  };
}

function bindingFor(rawText: string): Record<string, string> {
  return {
    schemaVersion: 'alyte.import-eval.raw-snapshot-binding.v1',
    reportSha256: REPORT_SHA256,
    readerVersion: 'synthetic-reader.v1',
    runtimeVersion: 'synthetic-runtime.v1',
    readerBinarySha256: '1'.repeat(64),
    readerSourceSha256: '2'.repeat(64),
    snapshotSha256: createHash('sha256').update(rawText).digest('hex'),
  };
}

const bindingModule: RawSnapshotBindingModule = {
  verifyRawSnapshotBinding(rawText, binding, expected) {
    const value = binding as Record<string, unknown>;
    if (value.reportSha256 !== expected.reportSha256) throw new Error('binding report mismatch');
    return JSON.parse(rawText) as {
      readonly readerVersion: string;
      readonly reportSha256: string;
      readonly runtimeVersion: string;
      readonly pages: readonly unknown[];
    };
  },
};

function page(
  pageIndex: number,
  observations: readonly VisionObservation[],
): Record<string, unknown> {
  return { pageIndex, result: { observations } };
}

test('excludes only imaging pages while retaining mixed and unknown pages', () => {
  const pages = [
    page(0, [observation('heading', 'MRI findings')]),
    page(1, [observation('imaging', 'MRI Befund'), observation('laboratory', 'Blutbericht')]),
    page(2, []),
  ];
  const result = applySourceContextAdmission({
    pipeline: pipeline([
      measurement({ id: 'imaging-row', page: 1 }),
      measurement({ id: 'mixed-row', page: 2 }),
      measurement({ id: 'unknown-row', page: 3 }),
    ]),
    pages: pages.map((item) => {
      const record = item as {
        pageIndex: number;
        result: { observations: readonly Record<string, unknown>[] };
      };
      return {
        pageIndex: record.pageIndex,
        observations: record.result.observations.map(
          (item) => item as VisionPage['observations'][number],
        ),
      };
    }),
    sourceSnapshot: {
      schemaVersion: 'binding.v1',
      snapshotSha256: '3'.repeat(64),
      reportSha256: REPORT_SHA256,
      readerVersion: 'reader.v1',
      runtimeVersion: 'runtime.v1',
      readerBinarySha256: '4'.repeat(64),
      readerSourceSha256: '5'.repeat(64),
    },
    classifierSha256: '6'.repeat(64),
  });
  assert.deepEqual(
    result.excludedMeasurements.map((item) => item.id),
    ['imaging-row'],
  );
  assert.deepEqual(
    result.pipeline.measurements.map((item) => item.id),
    ['mixed-row', 'unknown-row'],
  );
  assert.equal(result.classifications[0]?.classification.kind, 'imaging-narrative');
  assert.equal(result.classifications[1]?.classification.kind, 'unknown');
  assert.equal(result.classifications[2]?.classification.kind, 'unknown');
  assert.equal(result.pipeline.stages.at(-1)?.name, 'source-context-admission');
});

test('retains a page with generic laboratory table headers', () => {
  const result = applySourceContextAdmission({
    pipeline: pipeline([measurement({ page: 1 })]),
    pages: [
      {
        pageIndex: 0,
        observations: [
          observation('test', 'Test', 0.3),
          observation('result', 'Current Result', 0.3),
          observation('unit', 'Unit', 0.3),
          observation('reference', 'Reference Interval', 0.3),
        ],
      },
    ],
    sourceSnapshot: {
      schemaVersion: 'binding.v1',
      snapshotSha256: '3'.repeat(64),
      reportSha256: REPORT_SHA256,
      readerVersion: 'reader.v1',
      runtimeVersion: 'runtime.v1',
      readerBinarySha256: '4'.repeat(64),
      readerSourceSha256: '5'.repeat(64),
    },
    classifierSha256: '6'.repeat(64),
  });
  assert.equal(result.classifications[0]?.classification.kind, 'laboratory-table');
  assert.equal(result.excludedMeasurements.length, 0);
  assert.equal(result.pipeline.measurements.length, 1);
});

test('verifies report binding before writing output and excluded rows privately', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-source-context-'));
  mkdirSync(join(root, 'inputs'));
  const reportPath = join(root, 'inputs', 'report.pdf');
  const pipelinePath = join(root, 'inputs', 'pipeline.json');
  const sourcePath = join(root, 'inputs', 'source.json');
  const bindingPath = join(root, 'inputs', 'source.binding.json');
  const outputPath = join(root, 'outputs', 'pipeline.json');
  const rawText = JSON.stringify(rawEnvelope([page(0, [observation('heading', 'MRI findings')])]));
  writeFileSync(reportPath, REPORT_BYTES);
  writeFileSync(pipelinePath, JSON.stringify(pipeline([measurement({ page: 1 })])));
  writeFileSync(sourcePath, rawText);
  writeFileSync(bindingPath, JSON.stringify(bindingFor(rawText)));
  const result = await runSourceContextAdmission({
    reportPath,
    pipelinePath,
    sourcePath,
    bindingPath,
    outputPath,
    privateRoot: root,
    bindingModule,
  });
  assert.equal(result.pipeline.measurements.length, 0);
  assert.match(result.pipeline.pipeline.version, /source-context-admission\.v1/u);
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).measurements.length, 0);
  const excludedPath = join(root, 'outputs', 'pipeline.excluded.json');
  const excluded = JSON.parse(readFileSync(excludedPath, 'utf8')) as {
    readonly excludedMeasurements: readonly EvaluationMeasurement[];
  };
  assert.equal(excluded.excludedMeasurements.length, 1);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(statSync(excludedPath).mode & 0o777, 0o600);

  writeFileSync(reportPath, Buffer.from('changed-report'));
  await assert.rejects(
    () =>
      runSourceContextAdmission({
        reportPath,
        pipelinePath,
        sourcePath,
        bindingPath,
        outputPath: join(root, 'outputs', 'rejected.json'),
        privateRoot: root,
        bindingModule,
      }),
    /source-context-report-binding-mismatch/u,
  );
});

test('rejects output collisions and preserves existing output artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-source-context-collision-'));
  mkdirSync(join(root, 'inputs'));
  const reportPath = join(root, 'inputs', 'report.pdf');
  const pipelinePath = join(root, 'inputs', 'pipeline.json');
  const sourcePath = join(root, 'inputs', 'source.json');
  const bindingPath = join(root, 'inputs', 'source.binding.json');
  const rawText = JSON.stringify(rawEnvelope([page(0, [])]));
  writeFileSync(reportPath, REPORT_BYTES);
  writeFileSync(pipelinePath, JSON.stringify(pipeline([])));
  writeFileSync(sourcePath, rawText);
  writeFileSync(bindingPath, JSON.stringify(bindingFor(rawText)));

  await assert.rejects(
    () =>
      runSourceContextAdmission({
        reportPath,
        pipelinePath,
        sourcePath,
        bindingPath,
        outputPath: pipelinePath,
        privateRoot: root,
        bindingModule,
      }),
    /output-collides-with-input/u,
  );

  const outputPath = join(root, 'outputs', 'pipeline.json');
  mkdirSync(join(root, 'outputs'));
  writeFileSync(outputPath, 'preserve me');
  await assert.rejects(
    () =>
      runSourceContextAdmission({
        reportPath,
        pipelinePath,
        sourcePath,
        bindingPath,
        outputPath,
        privateRoot: root,
        bindingModule,
      }),
    /output-already-exists/u,
  );
  assert.equal(readFileSync(outputPath, 'utf8'), 'preserve me');

  const freshOutputPath = join(root, 'outputs', 'fresh.json');
  writeFileSync(join(root, 'outputs', 'fresh.excluded.json'), 'preserve excluded');
  await assert.rejects(
    () =>
      runSourceContextAdmission({
        reportPath,
        pipelinePath,
        sourcePath,
        bindingPath,
        outputPath: freshOutputPath,
        privateRoot: root,
        bindingModule,
      }),
    /excluded-already-exists/u,
  );
  assert.equal(
    readFileSync(join(root, 'outputs', 'fresh.excluded.json'), 'utf8'),
    'preserve excluded',
  );
});
