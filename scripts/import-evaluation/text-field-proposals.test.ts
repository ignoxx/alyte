import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTextFieldProposalPrompt,
  decodeTextFieldProposals,
  groundTextFieldProposals,
} from './text-field-proposals';

function syntheticPage() {
  const cell = (id: string, text: string, x: number, y: number, width = 0.12) => {
    const rowIndex = y <= 0.1 ? 0 : Math.round(y * 10) - 1;
    const columnIndex = x < 0.2 ? 0 : x < 0.7 ? 1 : x < 0.9 ? 2 : x < 0.97 ? 3 : 4;
    const sourceStart = Math.round(y * 10_000) + Math.round(x * 1_000);
    return {
      id,
      text,
      pageIndex: 0,
      sourceStart,
      sourceEnd: sourceStart + text.length,
      structure: {
        kind: 'table-cell',
        tableId: 'synthetic-table',
        rowIndex,
        columnIndex,
      },
      boundingBox: { x, y, width, height: 0.02 },
    };
  };
  return {
    pageIndex: 0,
    observations: [
      cell('header-test', 'Test', 0.08, 0.1),
      cell('header-current', 'Current Result', 0.48, 0.1, 0.16),
      cell('header-unit', 'Unit', 0.8, 0.1),
      cell('header-flag', 'Flag', 0.99, 0.1, 0.02),
      cell('label-glucose', 'Glucose', 0.08, 0.2),
      cell('value-glucose', '5.2', 0.48, 0.2, 0.08),
      cell('unit-glucose', 'mmol/L', 0.8, 0.2),
      cell('reference-glucose', '3.9-5.5', 0.92, 0.2, 0.08),
      cell('flag-glucose', 'H', 0.99, 0.2, 0.02),
      cell('label-pulse', 'Pulse', 0.08, 0.3),
      cell('value-pulse', '60-80', 0.48, 0.3, 0.1),
      cell('unit-pulse', 'bpm', 0.8, 0.3, 0.06),
      cell('label-appearance', 'Appearance', 0.08, 0.4),
      cell('value-appearance', 'clear', 0.48, 0.4, 0.08),
    ],
  };
}

test('prompt describes source field strings and a separated result token', () => {
  const prompt = buildTextFieldProposalPrompt(syntheticPage());
  assert.match(prompt, /Schema: \{"rows":\[\{"label"/u);
  assert.match(prompt, /"reference":null,"flag":null/u);
  assert.match(prompt, /value "5\.2" and unit "mmol\/L"/u);
  assert.match(prompt, /r3\|y410\|x520\|"clear"/u);
});

test('parser uses the response after the CLI user prompt', () => {
  const raw =
    'system example {"rows":[{"label":"wrong","value":"wrong","unit":null}]}\n' +
    '> Use the system table and return the requested field-string rows now.\n' +
    '{"rows":[{"label":"Glucose","value":"5.2","unit":"mmol/L"},{"label":"Pulse","value":"60-80","unit":"bpm"},{"label":"Appearance","value":"clear","unit":null}]}';
  const result = decodeTextFieldProposals(raw);
  assert.equal(result.valid, true);
  assert.equal(result.proposals.length, 3);
  assert.equal(result.proposals[2]?.value, 'clear');
});

test('parser accepts the plain JSON array requested by the layout experiment', () => {
  const raw =
    'Loading model\n> full table prompt\n' +
    '[{"label":"Glucose","value":"5.2","unit":"mmol/L"},{"label":"Pulse","value":"60-80","unit":"bpm"}]';
  const result = decodeTextFieldProposals(raw);
  assert.equal(result.valid, true);
  assert.equal(result.proposals.length, 2);
  assert.equal(result.proposals[1]?.label, 'Pulse');
});

test('parser preserves an untrusted numeric proposal and nullable optional fields', () => {
  const result = decodeTextFieldProposals(
    '[{"label":"Glucose","value":5.2,"unit":null,"reference":null,"flag":null}]',
  );
  assert.equal(result.valid, true);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.rawValue, 5.2);
  assert.equal(result.proposals[0]?.value, '5.2');
  assert.equal(result.proposals[0]?.reference, null);
  assert.equal(result.proposals[0]?.flag, null);
});

test('parser carries typed reference and flag fields to the grounder', () => {
  const result = decodeTextFieldProposals(
    '[{"label":"Glucose","value":"5.2","unit":"mmol/L","reference":"3.9-5.5","flag":"H"}]',
  );
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.reference, '3.9-5.5');
  assert.equal(result.proposals[0]?.flag, 'H');
});

test('parser rejects non-string optional source fields', () => {
  const result = decodeTextFieldProposals(
    '[{"label":"Glucose","value":"5.2","unit":"mmol/L","reference":5.5,"flag":null}]',
  );
  assert.equal(result.valid, true);
  assert.equal(result.proposals.length, 0);
});

test('grounding reconstructs native strings for numeric, bounded, and categorical proposals', () => {
  const decoded = decodeTextFieldProposals(
    '[{"label":"Glucose","value":"5.2","unit":"mmol/L","reference":"3.9-5.5","flag":"H"},{"label":"Pulse","value":"60-80","unit":"bpm","reference":null,"flag":null},{"label":"Appearance","value":"clear","unit":null,"reference":null,"flag":null}]',
  );
  assert.equal(decoded.proposals.length, 3);
  const result = groundTextFieldProposals(decoded.proposals, syntheticPage());
  assert.equal(result.measurements.length, 3);
  assert.deepEqual(
    result.measurements.map((measurement) => [
      measurement.sourceLabel,
      measurement.valueString,
      measurement.unit,
      measurement.referenceInterval,
      measurement.flag,
    ]),
    [
      ['Glucose', '5.2', 'mmol/L', '3.9-5.5', 'H'],
      ['Pulse', '60-80', 'bpm', null, null],
      ['Appearance', 'clear', null, null, null],
    ],
  );
});
