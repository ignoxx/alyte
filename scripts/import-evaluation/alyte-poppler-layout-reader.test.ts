import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  parseBboxLayoutDocument,
  toVisionPages,
  type PopplerPage,
  writePopplerBinding,
} from './alyte-poppler-layout-reader';

test('decodes XML entities once and preserves every word as a span', () => {
  const pages = parseBboxLayoutDocument(`
    <page width="100" height="200">
      <flow><block>
        <line xMin="10" yMin="20" xMax="90" yMax="30">
          <word xMin="10" yMin="20" xMax="40" yMax="30">&amp;amp;lt;Marker</word>
          <word xMin="50" yMin="20" xMax="60" yMax="30">4.2</word>
          <word xMin="70" yMin="20" xMax="90" yMax="30">mg/dL</word>
        </line>
      </block></flow>
    </page>
  `);
  assert.equal(pages[0]?.lines[0]?.words[0]?.text, '&amp;lt;Marker');
  const vision = toVisionPages(pages);
  const observation = vision[0]!.result.observations[0]!;
  assert.equal(observation.text, '&amp;lt;Marker 4.2 mg/dL');
  assert.deepEqual(
    observation.spans.map((span) => span.start),
    [0, 15, 19],
  );
  assert.deepEqual(
    observation.spans.map((span) => span.end),
    [14, 18, 24],
  );
  assert.equal(observation.sourceStart, 0);
  assert.equal(observation.sourceEnd, observation.text.length);
  assert.equal(vision[0]!.sourceText, observation.text);
  assert.equal(vision[0]!.sourceOffsetKind, 'synthetic-page-text-utf16');
});

test('retains line order, normalized geometry, and surrogate UTF-16 offsets', () => {
  const pages = parseBboxLayoutDocument(`
    <page width="1000" height="2000">
      <line xMin="100" yMin="200" xMax="900" yMax="300">
        <word xMin="100" yMin="200" xMax="400" yMax="300">A😀</word>
        <word xMin="500" yMin="200" xMax="700" yMax="300">42</word>
      </line>
      <line xMin="100" yMin="400" xMax="700" yMax="500">
        <word xMin="100" yMin="400" xMax="700" yMax="500">Second</word>
      </line>
    </page>
  `);
  const vision = toVisionPages(pages);
  assert.equal(vision.length, 1);
  assert.equal(vision[0]!.result.observations.length, 2);
  const first = vision[0]!.result.observations[0]!;
  assert.equal(first.text, 'A😀 42');
  assert.equal(first.spans[0]!.start, 0);
  assert.equal(first.spans[0]!.end, 3);
  assert.equal(first.spans[1]!.start, 4);
  assert.equal(first.spans[1]!.end, 6);
  assert.deepEqual(first.boundingBox, { x: 0.1, y: 0.1, width: 0.6, height: 0.05 });
  assert.equal(vision[0]!.result.observations[1]!.sourceStart, first.text.length + 1);
  assert.equal(vision[0]!.sourceText, 'A😀 42\nSecond');
});

test('rejects missing attributes, non-positive dimensions, and out-of-page boxes', () => {
  assert.throws(
    () =>
      parseBboxLayoutDocument(
        '<page width="100" height="200"><line yMin="20" xMax="90" yMax="30"></line></page>',
      ),
    /attribute-invalid/u,
  );
  assert.throws(
    () => parseBboxLayoutDocument('<page width="0" height="200"></page>'),
    /page-size-invalid/u,
  );
  assert.throws(
    () =>
      parseBboxLayoutDocument(
        '<page width="100" height="200"><line xMin="10" yMin="20" xMax="110" yMax="30"><word xMin="10" yMin="20" xMax="110" yMax="30">x</word></line></page>',
      ),
    /outside-page/u,
  );
});

test('does not filter empty or image-only pages into invented observations', () => {
  const pages: PopplerPage[] = [{ pageIndex: 0, width: 100, height: 200, lines: [] }];
  const vision = toVisionPages(pages);
  assert.equal(vision[0]!.sourceText, '');
  assert.deepEqual(vision[0]!.result.observations, []);
});

test('writes a verified sibling binding with reader and source identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-poppler-binding-'));
  chmodSync(root, 0o700);
  const outputPath = join(root, 'snapshot.binding.json');
  const identity = {
    reportSha256: '1'.repeat(64),
    readerVersion: 'reader.v1',
    runtimeVersion: 'runtime.v1',
    readerBinarySha256: '2'.repeat(64),
    readerSourceSha256: '3'.repeat(64),
  };
  const rawText = '{"readerVersion":"reader.v1"}\n';
  const binding = {
    schemaVersion: 'binding.v1',
    ...identity,
    snapshotSha256: '4'.repeat(64),
  };
  let verified = false;
  writePopplerBinding({
    rawText,
    identity,
    outputPath,
    bindingModule: {
      createRawSnapshotBinding: () => binding,
      verifyRawSnapshotBinding: (actualText, actualBinding, expected) => {
        assert.equal(actualText, rawText);
        assert.deepEqual(actualBinding, binding);
        assert.deepEqual(expected, identity);
        verified = true;
      },
    },
  });
  assert.equal(verified, true);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), binding);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});
