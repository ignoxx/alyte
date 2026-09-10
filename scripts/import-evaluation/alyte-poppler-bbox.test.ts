import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractMeasurements, parseBboxLayoutDocument } from './alyte-poppler-bbox';

test('Poppler bbox parser preserves page and word geometry for a generic row', () => {
  const pages = parseBboxLayoutDocument(`
    <page width="100" height="200">
      <flow><block>
        <line xMin="10" yMin="20" xMax="90" yMax="30">
          <word xMin="10" yMin="20" xMax="40" yMax="30">Synthetic Marker</word>
          <word xMin="50" yMin="20" xMax="60" yMax="30">4.2</word>
          <word xMin="70" yMin="20" xMax="90" yMax="30">mg/dL</word>
        </line>
      </block></flow>
    </page>
  `);

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.pageIndex, 0);
  assert.equal(pages[0]?.lines[0]?.words.length, 3);
  assert.equal(pages[0]?.lines[0]?.words[0]?.id, 'p1-l1-w1');
  const measurements = extractMeasurements(pages);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0]?.sourceLabel, 'Synthetic Marker');
  assert.equal(measurements[0]?.valueString, '4.2');
  assert.equal(measurements[0]?.parsedValue, 4.2);
  assert.equal(measurements[0]?.unit, 'mg/dL');
  assert.equal(measurements[0]?.page, 1);
  assert.deepEqual(measurements[0]?.location, { x: 0.1, y: 0.1, width: 0.8, height: 0.05 });
  assert.deepEqual(measurements[0]?.sourceIds, ['p1-l1-w1', 'p1-l1-w2', 'p1-l1-w3']);
  assert.deepEqual(measurements[0]?.sourceWordBoxes, [
    {
      id: 'p1-l1-w1',
      text: 'Synthetic Marker',
      box: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
      page: 1,
    },
    { id: 'p1-l1-w2', text: '4.2', box: { x: 0.5, y: 0.1, width: 0.1, height: 0.05 }, page: 1 },
    { id: 'p1-l1-w3', text: 'mg/dL', box: { x: 0.7, y: 0.1, width: 0.2, height: 0.05 }, page: 1 },
  ]);
});

test('image-only pages fall through with zero measurements', () => {
  const pages = parseBboxLayoutDocument('<page width="100" height="200"></page>');
  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.lines.length, 0);
  assert.deepEqual(extractMeasurements(pages), []);
});
