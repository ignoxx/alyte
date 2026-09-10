import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adaptProposal,
  ensurePrivateDirectory,
  ensurePrivateFile,
  sourceFieldsFromRaw,
  structuralErrorCategory,
  validatePrivatePaths,
} from './vitametr.mjs';

test('adapts a decimal-comma numeric row without confusing a numbered label', () => {
  assert.deepEqual(
    sourceFieldsFromRaw({ rawText: '25-OH vitamin D 25 ng/mL 50 - 100', value: 25 }),
    { sourceLabel: '25-OH vitamin D', valueString: '25', unit: 'ng/mL', flag: null },
  );
});

test('keeps a censoring comparator in the source value string', () => {
  assert.deepEqual(
    sourceFieldsFromRaw({ rawText: 'Glucose < 0,10 mg/L', value: 0.1, operator: '<' }),
    { sourceLabel: 'Glucose', valueString: '< 0,10', unit: 'mg/L', flag: null },
  );
});

test('adapts categorical rows without inventing a unit', () => {
  assert.deepEqual(sourceFieldsFromRaw({ rawText: 'CRP negativ', textValue: 'negativ' }), {
    sourceLabel: 'CRP',
    valueString: 'negativ',
    unit: null,
    flag: null,
  });
});

test('keeps the exact public proposal beside adapted fields', () => {
  const proposal = {
    metric: { unresolvedName: 'Marker H' },
    value: 3.2,
    unit: 'mg/L',
    confidence: 'low',
    rawText: 'Marker H 3.2 mg/L',
  };
  const adapted = adaptProposal(proposal, 0, { page: 2 }, { byId: () => undefined });
  assert.deepEqual(adapted.rawProposal, proposal);
  assert.equal(adapted.sourceLabel, 'Marker H');
  assert.equal(adapted.canonicalBiomarkerId, null);
});

test('bounds failure categories and rejects output outside the private root', () => {
  assert.equal(structuralErrorCategory(new Error('sensitive source text')), 'adapter-failed');
  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        '/private/evaluation/reports/lt.pdf',
        '/tmp/out.json',
        '/private/evaluation',
      ),
    (error) => error?.code === 'private-path',
  );
});

test('rejects an input whose existing symlink parent escapes the private reports root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitametr-private-'));
  const reports = join(root, 'reports');
  const outside = mkdtempSync(join(tmpdir(), 'vitametr-outside-'));
  mkdirSync(reports, { recursive: true });
  symlinkSync(outside, join(reports, 'escape'));
  writeFileSync(join(outside, 'report.pdf'), 'synthetic');

  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        join(reports, 'escape', 'report.pdf'),
        join(root, 'result.json'),
        root,
      ),
    (error) => error?.code === 'private-path',
  );
});

test('rejects an output whose existing symlink parent escapes the private root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitametr-private-'));
  const reports = join(root, 'reports');
  const outside = mkdtempSync(join(tmpdir(), 'vitametr-outside-'));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'lt.pdf'), 'synthetic');
  symlinkSync(outside, join(root, 'escape'));

  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        join(reports, 'lt.pdf'),
        join(root, 'escape', 'result.json'),
        root,
      ),
    (error) => error?.code === 'private-path',
  );
});

test('accepts a staged output path and tightens existing private modes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vitametr-private-'));
  const reports = join(root, 'reports');
  const staged = join(root, 'staged');
  mkdirSync(reports, { recursive: true, mode: 0o755 });
  mkdirSync(staged, { recursive: true, mode: 0o755 });
  chmodSync(reports, 0o755);
  chmodSync(staged, 0o755);
  const report = join(reports, 'lt.pdf');
  writeFileSync(report, 'synthetic', { mode: 0o644 });
  chmodSync(report, 0o644);
  const output = join(staged, 'result.json');

  assert.doesNotThrow(() => validatePrivatePaths({ 'report-id': 'lt' }, report, output, root));
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(reports);
  await ensurePrivateDirectory(staged);
  await ensurePrivateFile(report, 'synthetic');
  await ensurePrivateFile(output, '{}\n');
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(reports).mode & 0o777, 0o700);
  assert.equal(statSync(staged).mode & 0o777, 0o700);
  assert.equal(statSync(report).mode & 0o777, 0o600);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(lstatSync(output).isSymbolicLink(), false);
});

test('rejects dangling symlink ancestors before a nonexistent suffix is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitametr-private-'));
  const reports = join(root, 'reports');
  mkdirSync(reports, { recursive: true });
  const outsideTarget = join(tmpdir(), 'vitametr-missing-target', 'nested');
  symlinkSync(outsideTarget, join(reports, 'dangling-input'));
  symlinkSync(outsideTarget, join(root, 'dangling-output'));

  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        join(reports, 'dangling-input', 'report.pdf'),
        join(root, 'result.json'),
        root,
      ),
    (error) => error?.code === 'private-path',
  );
  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        join(reports, 'placeholder.pdf'),
        join(root, 'dangling-output', 'result.json'),
        root,
      ),
    (error) => error?.code === 'private-path',
  );
});

test('rejects a private runs directory that resolves outside the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'vitametr-private-'));
  const reports = join(root, 'reports');
  const outside = mkdtempSync(join(tmpdir(), 'vitametr-outside-'));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'lt.pdf'), 'synthetic');
  symlinkSync(outside, join(root, 'runs'));

  assert.throws(
    () =>
      validatePrivatePaths(
        { 'report-id': 'lt' },
        join(reports, 'lt.pdf'),
        join(root, 'result.json'),
        root,
      ),
    (error) => error?.code === 'private-path',
  );
});
