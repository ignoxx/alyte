import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePdfTextLayerPage, PDF_TEXT_LAYER_CONTRACT_VERSION } from './pdf';

type SyntheticSpan = {
  id: string;
  parentObservationId: string;
  start: number;
  end: number;
  text: string;
  boundingBox: { x: number; y: number; width: number; height: number };
};

type SyntheticObservation = {
  id: string;
  text: string;
  sourceStart: number;
  sourceEnd: number;
  alternatives: string[];
  boundingBox: { x: number; y: number; width: number; height: number };
  pageIndex: number;
  orientation: number;
  structure: {
    kind: 'text';
    tableId: null;
    rowIndex: null;
    columnIndex: null;
  };
  spans: SyntheticSpan[];
  recognition: { level: 'accurate'; language: null; internalConfidence: null };
};

type SyntheticPage = {
  contractVersion: typeof PDF_TEXT_LAYER_CONTRACT_VERSION;
  pageIndex: number;
  orientation: 0;
  observations: SyntheticObservation[];
};

const box = (x: number, y: number) => ({ x, y, width: 0.1, height: 0.05 });

function makePage(
  text = 'LDL 118 mg/dL',
  ranges: readonly { start: number; end: number }[] = [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: text.length },
  ],
): SyntheticPage {
  const id = `pdf-2-line-0-${text.length}`;
  return {
    contractVersion: PDF_TEXT_LAYER_CONTRACT_VERSION,
    pageIndex: 2,
    orientation: 0,
    observations: [
      {
        id,
        text,
        sourceStart: 0,
        sourceEnd: text.length,
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 },
        pageIndex: 2,
        orientation: 0,
        structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
        spans: ranges.map(({ start, end }, index) => ({
          id: `${id}-span-${index}`,
          parentObservationId: id,
          start,
          end,
          text: text.slice(start, end),
          boundingBox: box(0.1 + index * 0.12, 0.2),
        })),
        recognition: { level: 'accurate', language: null, internalConfidence: null },
      },
    ],
  };
}

function clonePage(): SyntheticPage {
  return structuredClone(makePage());
}

test('decodes a complete PDFKit page into the existing Vision v3 result shape', () => {
  const result = decodePdfTextLayerPage(makePage(), 2);

  assert.ok(result);
  assert.equal(result.contractVersion, 'alyte.vision.document.v4');
  assert.equal(result.pageIndex, 2);
  assert.equal(result.orientation, 0);
  assert.equal(result.observations[0]?.text, 'LDL 118 mg/dL');
  assert.equal(result.observations[0]?.spans?.[1]?.text, '118');
});

test('returns null only for the native unavailable-page value', () => {
  assert.equal(decodePdfTextLayerPage(null, 2), null);
  assert.throws(() => decodePdfTextLayerPage(undefined, 2), /page result/);
  assert.throws(() => decodePdfTextLayerPage({}, 2), /page result/);
});

test('requires the exact page envelope, page context, and no raw source wall', () => {
  const wrongContract = clonePage();
  wrongContract.contractVersion =
    'alyte.pdf.text-layer.other' as typeof PDF_TEXT_LAYER_CONTRACT_VERSION;
  assert.throws(() => decodePdfTextLayerPage(wrongContract, 2), /contract version/);

  const wrongPage = clonePage();
  wrongPage.pageIndex = 3;
  assert.throws(() => decodePdfTextLayerPage(wrongPage, 2), /page index/);

  const wrongOrientation = clonePage();
  wrongOrientation.orientation = 90 as 0;
  assert.throws(() => decodePdfTextLayerPage(wrongOrientation, 2), /orientation/);

  const rawSourceWall = clonePage() as SyntheticPage & { sourceText?: string };
  rawSourceWall.sourceText = 'LDL 118 mg/dL';
  assert.throws(() => decodePdfTextLayerPage(rawSourceWall, 2), /raw sourceText/);

  const partial = clonePage();
  delete (partial.observations[0] as Partial<SyntheticObservation>).recognition;
  assert.throws(() => decodePdfTextLayerPage(partial, 2), /observation 0/);
});

test('rejects invalid geometry, source relationships, and duplicate IDs', () => {
  const invalidBox = clonePage();
  invalidBox.observations[0]!.spans[0]!.boundingBox.x = 1.1;
  assert.throws(() => decodePdfTextLayerPage(invalidBox, 2), /bounding box/);

  const wrongSpanText = clonePage();
  wrongSpanText.observations[0]!.spans[1]!.text = '1180';
  assert.throws(() => decodePdfTextLayerPage(wrongSpanText, 2), /source text/);

  const overlappingSpans = clonePage();
  overlappingSpans.observations[0]!.spans.reverse();
  assert.throws(() => decodePdfTextLayerPage(overlappingSpans, 2), /Overlapping/);

  const uncoveredVisibleCharacter = clonePage();
  uncoveredVisibleCharacter.observations[0]!.spans.splice(1, 1);
  assert.throws(() => decodePdfTextLayerPage(uncoveredVisibleCharacter, 2), /coverage/);

  const duplicateObservationID = clonePage();
  const duplicate = structuredClone(duplicateObservationID.observations[0]!);
  duplicate.id = duplicateObservationID.observations[0]!.id;
  duplicate.sourceStart = 13;
  duplicate.sourceEnd = 26;
  duplicateObservationID.observations.push(duplicate);
  assert.throws(() => decodePdfTextLayerPage(duplicateObservationID, 2), /Duplicate/);

  const duplicateSpanID = clonePage();
  duplicateSpanID.observations[0]!.spans[1]!.id = duplicateSpanID.observations[0]!.spans[0]!.id;
  assert.throws(() => decodePdfTextLayerPage(duplicateSpanID, 2), /Duplicate/);

  const sharedObservationAndSpanID = clonePage();
  sharedObservationAndSpanID.observations[0]!.spans[0]!.id =
    sharedObservationAndSpanID.observations[0]!.id;
  assert.throws(() => decodePdfTextLayerPage(sharedObservationAndSpanID, 2), /Duplicate/);
});

test('rejects caps and malformed source ranges before delegating to Vision decoding', () => {
  const tooManyObservations = clonePage();
  tooManyObservations.observations = Array.from({ length: 513 }, (_, index) => ({
    ...structuredClone(tooManyObservations.observations[0]!),
    id: `observation-${index}`,
  }));
  assert.throws(() => decodePdfTextLayerPage(tooManyObservations, 2), /observations/);

  const tooLongID = clonePage();
  tooLongID.observations[0]!.id = 'x'.repeat(257);
  assert.throws(() => decodePdfTextLayerPage(tooLongID, 2), /id/);

  const tooLongText = clonePage();
  tooLongText.observations[0]!.text = 'A'.repeat(64 * 1024 + 1);
  tooLongText.observations[0]!.sourceEnd = tooLongText.observations[0]!.text.length;
  assert.throws(() => decodePdfTextLayerPage(tooLongText, 2), /text/);

  const invalidSourceRange = clonePage();
  invalidSourceRange.observations[0]!.sourceEnd -= 1;
  assert.throws(() => decodePdfTextLayerPage(invalidSourceRange, 2), /source range/);

  const hugeSourceOffset = clonePage();
  hugeSourceOffset.observations[0]!.sourceStart = 100_000;
  hugeSourceOffset.observations[0]!.sourceEnd =
    100_000 + hugeSourceOffset.observations[0]!.text.length;
  assert.throws(() => decodePdfTextLayerPage(hugeSourceOffset, 2), /source range/);
});

test('keeps UTF-16 ranges on composed-character boundaries', () => {
  const emoji = 'A😀B';
  const intact = makePage(emoji, [{ start: 0, end: emoji.length }]);
  assert.equal(decodePdfTextLayerPage(intact, 2)?.observations[0]?.spans?.[0]?.text, emoji);

  const splitSurrogate = makePage(emoji, [{ start: 0, end: 2 }]);
  assert.throws(() => decodePdfTextLayerPage(splitSurrogate, 2), /span 0 range/);

  const zwjEmoji = '👩‍💻';
  const splitZWJSequence = makePage(zwjEmoji, [{ start: 0, end: 2 }]);
  assert.throws(() => decodePdfTextLayerPage(splitZWJSequence, 2), /span 0 range/);

  const splitModifierSequence = makePage('👍🏽', [{ start: 0, end: 2 }]);
  assert.throws(() => decodePdfTextLayerPage(splitModifierSequence, 2), /span 0 range/);
});
