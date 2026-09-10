import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlainLayoutPrompt,
  classifyModelStatus,
  parsePageCount,
  parsePageSelection,
} from './text-layout-fullpage';

test('full-page plaintext runner parses Poppler page count without inspecting page text', () => {
  assert.equal(parsePageCount('Title: synthetic\nPages:   7\n'), 7);
  assert.throws(() => parsePageCount('Pages: 0\n'), /text-layout-fullpage-page-count-invalid/u);
});

test('full-page plaintext prompt preserves the complete layout payload', () => {
  const layout = 'Test   Current Result   Unit\nGlucose   5.2   mmol/L\n';
  assert.equal(
    buildPlainLayoutPrompt(layout),
    'Extract every laboratory result from this report page as a JSON array with label, value, unit, reference, flag. Copy printed text; absent optional fields are null. Include numeric, bounded and categorical results.\n' +
      layout,
  );
});

test('prompt v2 calls out current-result columns and administrative/reference-only exclusions', () => {
  const prompt = buildPlainLayoutPrompt('Test | Current Result | Unit\n', 'v2');
  assert.match(prompt, /complete test-name or label column/u);
  assert.match(prompt, /Current Result column/u);
  assert.match(prompt, /Previous or Prior Result/u);
  assert.match(prompt, /accreditation, method, staff/u);
  assert.match(prompt, /guidance, instructions, reference-only tables/u);
  assert.match(prompt, /\{"rows":\[\]\}/u);
  assert.ok(prompt.endsWith('Test | Current Result | Unit\n'));
});

test('page selection accepts a unique sorted comma-separated subset and rejects invalid pages', () => {
  assert.deepEqual(parsePageSelection('3,1,3'), [1, 3]);
  assert.throws(() => parsePageSelection('0'), /text-layout-fullpage-pages-invalid/u);
  assert.throws(() => parsePageSelection('3,x'), /text-layout-fullpage-pages-invalid/u);
  assert.throws(() => parsePageSelection(''), /text-layout-fullpage-pages-invalid/u);
});

test('classifies a completed CLI response with malformed JSON separately from valid empty JSON', () => {
  assert.equal(classifyModelStatus('complete', 'complete', false, false, false), 'malformed-json');
  assert.equal(classifyModelStatus('complete', 'complete', true, false, false), 'complete');
  assert.equal(classifyModelStatus('complete', 'complete', false, true, false), 'cli-error');
  assert.equal(classifyModelStatus('complete', 'complete', false, false, true), 'output-truncated');
  assert.equal(
    classifyModelStatus('failed', 'complete', false, false, false),
    'skipped-layout-failed',
  );
});
