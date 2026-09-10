import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverDocumentVLMRows } from './document-vlm-recovery';

const markerRow = {
  label: 'Marker A',
  value: '12.4',
  unit: 'unit-A',
  reference_interval: '1-20',
  flag: null,
};

test('keeps the strict production result for a complete response', () => {
  const result = recoverDocumentVLMRows(JSON.stringify({ rows: [markerRow] }));
  assert.equal(result.status, 'strict');
  assert.deepEqual(result.rows, [
    {
      label: markerRow.label,
      value: markerRow.value,
      unit: markerRow.unit,
      referenceInterval: markerRow.reference_interval,
      flag: markerRow.flag,
    },
  ]);
});

test('recovers complete rows from a truncated envelope and rejects its incomplete sibling', () => {
  const complete = JSON.stringify(markerRow);
  const truncated = `model output {"rows":[${complete},{"label":"Marker B","value":"7.1","unit":"unit-B"`;
  const result = recoverDocumentVLMRows(truncated);
  assert.equal(result.status, 'recovered');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.label, markerRow.label);
  assert.equal(result.rows[0]?.referenceInterval, markerRow.reference_interval);
  assert.equal(result.completeRowObjects, 1);
  assert.ok(result.rejectedRowObjects >= 1);
});

test('ignores garbage and objects that do not satisfy the exact row grammar', () => {
  const malformed = `prefix {"rows":[${JSON.stringify(markerRow)},{"label":null,"value":"3.1","unit":null,"reference_interval":null,"flag":null}]} suffix`;
  const result = recoverDocumentVLMRows(malformed);
  assert.equal(result.status, 'recovered');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.label, markerRow.label);
  assert.equal(result.rejectedRowObjects, 1);
});

test('retains a complete row with a nullable observed value for later review', () => {
  const row = {
    label: 'Marker without observed value',
    value: null,
    unit: null,
    reference_interval: null,
    flag: null,
  };
  const result = recoverDocumentVLMRows(`prefix {"rows":[${JSON.stringify(row)}]`);
  assert.equal(result.status, 'recovered');
  assert.equal(result.rows[0]?.value, null);
});

test('does not admit an incomplete row by itself', () => {
  const result = recoverDocumentVLMRows('{"rows":[{"label":"Marker D","value":"3.2"');
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.rows, []);
  assert.equal(result.completeRowObjects, 0);
  assert.ok(result.rejectedRowObjects >= 1);
});

test('does not scan arbitrary JSON without the production rows marker', () => {
  const result = recoverDocumentVLMRows(`garbage ${JSON.stringify(markerRow)}`);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.rows, []);
});

test('does not turn a copied prompt placeholder into a recovered row', () => {
  const result = recoverDocumentVLMRows(
    'prompt {"rows":[{"label":"...","value":"...","unit":null,"reference_interval":null,"flag":null}]}',
  );
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.rows, []);
});

test('does not read row-shaped objects after the rows array', () => {
  const trailing = JSON.stringify({
    label: 'Trailing metadata',
    value: '8.8',
    unit: 'unit-X',
    reference_interval: null,
    flag: null,
  });
  const result = recoverDocumentVLMRows(
    `prefix {"rows":[${JSON.stringify(markerRow)}]} suffix ${trailing}`,
  );
  assert.equal(result.status, 'recovered');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.label, markerRow.label);
});

test('stops at the first exact repeated row in a looping response', () => {
  const secondRow = { ...markerRow, label: 'Marker B', value: '7.1' };
  const looping = `model output {"rows":[${[markerRow, secondRow, markerRow, secondRow].map(JSON.stringify).join(',')}`;
  const result = recoverDocumentVLMRows(looping);
  assert.deepEqual(
    result.rows.map((row) => row.label),
    ['Marker A', 'Marker B'],
  );
  assert.equal(result.repetitionDetected, true);
  assert.equal(result.repeatedRowIndex, 2);
  assert.equal(result.deferredRowObjects, 2);
});
