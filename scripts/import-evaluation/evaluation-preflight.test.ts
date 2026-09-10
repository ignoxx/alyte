import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validatePreflightPaths, type PreflightPaths } from './evaluation-preflight';

function paths(privateRoot: string): PreflightPaths {
  const input = (name: string): string => join(privateRoot, 'inputs', name);
  const output = (name: string): string => join(privateRoot, 'runs', name);
  return {
    privateRoot,
    report: input('report.pdf'),
    reportId: 'synthetic',
    expected: input('expected.json'),
    vision: input('vision.json'),
    binding: input('binding.json'),
    output: output('pipeline.json'),
    rawOutput: output('pipeline.model.json'),
    groundedOutput: output('pipeline.grounded.json'),
    excludedOutput: output('pipeline.excluded.json'),
    modelProposalsOutput: output('pipeline.model-proposals.json'),
    metadataOutput: output('pipeline.collection-date-metadata.json'),
    scoreOutput: output('pipeline.score.json'),
    aggregateOutput: output('pipeline.aggregate.json'),
    runnerLog: output('pipeline.runner.log'),
    groundingLog: output('pipeline.grounding.log'),
    scoreLog: output('pipeline.score.log'),
  };
}

function writeExpected(path: string, status: 'draft' | 'source-checked') {
  const reportSha256 = createHash('sha256').update('synthetic').digest('hex');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 'alyte.import-eval.v1',
      reportId: 'synthetic',
      reportSha256,
      groundTruthVersion: 1,
      review: { status, method: 'synthetic', reviewedPages: [1], notes: [] },
      measurements: [],
    }),
  );
}

test('preflight verifies private inputs and allows a new private output set', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-preflight-'));
  const candidate = paths(root);
  mkdirSync(join(root, 'inputs'));
  writeFileSync(candidate.report, 'synthetic');
  writeExpected(candidate.expected, 'source-checked');
  writeFileSync(candidate.vision, 'synthetic');
  writeFileSync(candidate.binding, 'synthetic');
  chmodSync(root, 0o700);
  assert.doesNotThrow(() => validatePreflightPaths(candidate));
});

test('preflight rejects an existing output and a symlinked source path', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-preflight-'));
  const candidate = paths(root);
  mkdirSync(join(root, 'inputs'));
  mkdirSync(join(root, 'runs'));
  writeFileSync(candidate.report, 'synthetic');
  writeExpected(candidate.expected, 'source-checked');
  writeFileSync(candidate.vision, 'synthetic');
  writeFileSync(candidate.binding, 'synthetic');
  writeFileSync(candidate.output, 'already exists');
  assert.throws(() => validatePreflightPaths(candidate), /evaluation-preflight-output-exists/u);

  const outside = mkdtempSync(join(tmpdir(), 'alyte-preflight-outside-'));
  writeFileSync(join(outside, 'report.pdf'), 'outside');
  symlinkSync(join(outside, 'report.pdf'), candidate.report + '.link');
  const symlinked: PreflightPaths = {
    ...candidate,
    report: candidate.report + '.link',
    output: join(root, 'runs', 'symlink-pipeline.json'),
    rawOutput: join(root, 'runs', 'symlink-pipeline.model.json'),
    scoreOutput: join(root, 'runs', 'symlink-pipeline.score.json'),
    aggregateOutput: join(root, 'runs', 'symlink-pipeline.aggregate.json'),
    runnerLog: join(root, 'runs', 'symlink-pipeline.runner.log'),
    groundingLog: join(root, 'runs', 'symlink-pipeline.grounding.log'),
    scoreLog: join(root, 'runs', 'symlink-pipeline.score.log'),
  };
  assert.throws(() => validatePreflightPaths(symlinked), /resolves outside the private root/u);
});

test('preflight rejects draft, report-id, and report-hash mismatches', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-preflight-'));
  const candidate = paths(root);
  mkdirSync(join(root, 'inputs'));
  for (const path of [candidate.report, candidate.vision, candidate.binding]) {
    writeFileSync(path, 'synthetic');
  }
  writeExpected(candidate.expected, 'draft');
  assert.throws(
    () => validatePreflightPaths(candidate),
    /evaluation-preflight-ground-truth-not-source-checked/u,
  );

  writeExpected(candidate.expected, 'source-checked');
  const mismatchedId = { ...candidate, reportId: 'other' };
  assert.throws(() => validatePreflightPaths(mismatchedId), /report-id-mismatch/u);

  writeFileSync(
    candidate.expected,
    JSON.stringify({
      schemaVersion: 'alyte.import-eval.v1',
      reportId: 'synthetic',
      reportSha256: '0'.repeat(64),
      groundTruthVersion: 1,
      review: { status: 'source-checked', method: 'synthetic', reviewedPages: [1], notes: [] },
      measurements: [],
    }),
  );
  assert.throws(() => validatePreflightPaths(candidate), /report-hash-mismatch/u);
});
