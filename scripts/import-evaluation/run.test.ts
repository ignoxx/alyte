import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IMPORT_EVALUATION_SCHEMA_VERSION, writeJsonFile } from './contract';
import { runEvaluation } from './run';

const SYNTHETIC_MEASUREMENT = {
  id: 'synthetic-row',
  sourceLabel: 'Synthetic marker',
  valueString: '10',
  valueType: 'numeric',
  parsedValue: 10,
  comparator: '=',
  unit: 'unit-a',
  referenceInterval: null,
  flag: null,
  collectionDate: '2026-01-01',
  collectionGroup: 'group-a',
  specimen: 'serum',
  page: 1,
  location: null,
  ambiguousFields: [],
};

function createPrivateFixture(): {
  readonly root: string;
  readonly reportPath: string;
  readonly expectedPath: string;
  readonly reportSha256: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'alyte-import-runner-'));
  const reportPath = join(root, 'reports', 'synthetic.pdf');
  const reportBytes = Buffer.from('synthetic-document');
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(reportPath, reportBytes);
  const expectedPath = join(root, 'ground-truth', 'synthetic.json');
  mkdirSync(join(root, 'ground-truth'), { recursive: true });
  writeJsonFile(expectedPath, {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: 'synthetic',
    reportSha256,
    groundTruthVersion: 1,
    review: {
      status: 'source-checked',
      method: 'synthetic source check',
      reviewedPages: [1],
      notes: [],
    },
    measurements: [SYNTHETIC_MEASUREMENT],
  });
  return { root, reportPath, expectedPath, reportSha256 };
}

function adapterSource(): string {
  return `import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const report = value('--report');
const reportId = value('--report-id');
const output = value('--output');
const reportSha256 = createHash('sha256').update(readFileSync(report)).digest('hex');
writeFileSync(output, JSON.stringify({
  schemaVersion: 'alyte.import-eval.v1', reportId, reportSha256,
  pipeline: { id: 'synthetic-adapter', version: 'test', configuration: {}, runtime: {} },
  stages: [{ name: 'parse', elapsedMs: 1, status: 'success' }], elapsedMs: 1,
  measurements: [${JSON.stringify(SYNTHETIC_MEASUREMENT)}], diagnostics: { counts: {}, limitations: [] }
}));
console.log('adapter stdout is discarded');`;
}

test('runs an adapter under an immutable run id and writes only safe aggregates publicly', () => {
  const fixture = createPrivateFixture();
  const adapterPath = join(fixture.root, 'adapter.mjs');
  writeFileSync(adapterPath, adapterSource());
  const result = runEvaluation({
    reportPath: fixture.reportPath,
    reportId: 'synthetic',
    expectedPath: fixture.expectedPath,
    privateRoot: fixture.root,
    adapters: [{ id: 'synthetic-adapter', path: adapterPath }],
    runId: 'baseline',
  });
  assert.equal(result.failures.length, 0);
  assert.equal(result.aggregates[0]?.labelValueAssociation.correctCount, 1);
  assert.equal(statSync(fixture.root).mode & 0o777, 0o700);
  assert.equal(statSync(fixture.reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(fixture.expectedPath).mode & 0o777, 0o600);
  assert.equal(
    existsSync(join(fixture.root, 'runs', 'baseline', 'synthetic-adapter', 'synthetic.json')),
    true,
  );
  assert.equal(
    statSync(join(fixture.root, 'runs', 'baseline', 'synthetic-adapter', 'synthetic.json')).mode &
      0o777,
    0o600,
  );
  assert.equal(
    statSync(join(fixture.root, 'runs', 'baseline', 'synthetic-adapter')).mode & 0o777,
    0o700,
  );
  const aggregate = JSON.parse(
    readFileSync(
      join(fixture.root, 'runs', 'baseline', 'synthetic-adapter', 'synthetic.aggregate.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(JSON.stringify(aggregate).includes('Synthetic marker'), false);
  assert.match(
    readFileSync(join(fixture.root, 'aggregate', 'baseline', 'synthetic.md'), 'utf8'),
    /^# Import evaluation comparison/u,
  );
  assert.equal(
    statSync(join(fixture.root, 'aggregate', 'baseline', 'synthetic.md')).mode & 0o777,
    0o600,
  );
  assert.throws(
    () =>
      runEvaluation({
        reportPath: fixture.reportPath,
        reportId: 'synthetic',
        expectedPath: fixture.expectedPath,
        privateRoot: fixture.root,
        adapters: [{ id: 'synthetic-adapter', path: adapterPath }],
        runId: 'baseline',
      }),
    /run id already exists/u,
  );

  const danglingRunDirectory = join(fixture.root, 'runs', 'dangling', 'synthetic-adapter');
  mkdirSync(join(fixture.root, 'runs', 'dangling'), { recursive: true });
  symlinkSync(join(fixture.root, 'missing-adapter-target'), danglingRunDirectory);
  assert.throws(
    () =>
      runEvaluation({
        reportPath: fixture.reportPath,
        reportId: 'synthetic',
        expectedPath: fixture.expectedPath,
        privateRoot: fixture.root,
        adapters: [{ id: 'synthetic-adapter', path: adapterPath }],
        runId: 'dangling',
      }),
    /private root/u,
  );
});
