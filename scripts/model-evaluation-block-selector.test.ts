import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractionSemanticCandidateRow, VisionTextObservation } from '@alyte/domain';
import {
  BLOCK_SELECTOR_CHUNK_VERSION,
  BLOCK_SELECTOR_SCHEMA_VERSION,
  blockSelectorPromptBudget,
  createBlockSelectorFormat,
  createBlockSelectorPrompt,
  estimateBlockSelectorTokens,
  planBlockSelectorBlocks,
  serializeBlockSelectorChunk,
  validateBlockSelectorOutput,
} from './model-evaluation-block-selector';

function observation(
  id: string,
  text: string,
  options: {
    readonly page?: number;
    readonly table?: string | null;
    readonly row?: number;
    readonly column?: number;
    readonly language?: string;
    readonly x?: number;
    readonly y?: number;
  } = {},
): VisionTextObservation {
  const pageIndex = options.page ?? 0;
  const tableId = options.table === undefined ? 'table-a' : options.table;
  const rowIndex = options.row ?? 0;
  const columnIndex = options.column ?? 0;
  return {
    id,
    text,
    alternatives: [],
    pageIndex,
    orientation: 0,
    boundingBox: {
      x: options.x ?? 0.05 + columnIndex * 0.2,
      y: options.y ?? 0.1 + rowIndex * 0.05,
      width: 0.16,
      height: 0.03,
    },
    recognition: {
      level: 'accurate',
      language: options.language ?? 'en',
      internalConfidence: null,
    },
    structure:
      tableId === null
        ? { kind: 'text', tableId: null, rowIndex: null, columnIndex: null }
        : { kind: 'table-cell', tableId, rowIndex, columnIndex },
  };
}

function row(
  rowId: string,
  cells: readonly string[],
  options: {
    readonly page?: number;
    readonly table?: string | null;
    readonly row?: number;
    readonly language?: string;
  } = {},
): ExtractionSemanticCandidateRow {
  const observations = cells.map((text, index) =>
    observation(`${rowId}-source-${index}`, text, {
      ...options,
      row: options.row ?? 0,
      column: index,
    }),
  );
  return {
    rowId,
    sourceObservationIds: observations.map((item) => item.id),
    observations,
  };
}

const english = row('english', ['Asterase', '7.2', 'mg/L', '1.0–8.0'], {
  row: 1,
  language: 'en',
});
const german = row('german', ['Synthetase', '3,4', 'mmol/L', '<4,0'], {
  row: 2,
  language: 'de',
});
const lithuanian = row('lithuanian', ['Transferazė', '12', 'U/L', '5–30'], {
  row: 3,
  language: 'lt',
});
const unsupported = row('unsupported', ['Fabricated marker', 'present', 'qualitative', 'absent'], {
  row: 4,
});
const heading = observation('private-heading-source-id', 'Test Result Unit Reference', {
  row: 0,
  column: 0,
});

function valueAuthority(...rows: readonly ExtractionSemanticCandidateRow[]) {
  return new Map(rows.map((item) => [item.rowId, [item.sourceObservationIds[1]!]] as const));
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    labelKey: 'c0',
    valueKey: 'c1',
    unitKey: 'c2',
    referenceIntervalKey: 'c3',
    flagKey: null,
    ...overrides,
  };
}

test('serializes ordered multilingual rows and read-only headings without source identifiers', () => {
  const serialized = serializeBlockSelectorChunk(
    [english, german, lithuanian, unsupported],
    [heading],
    'lt-LT',
    8,
  );
  const wire = JSON.parse(serialized) as {
    v: string;
    a: [number, boolean];
    r: Array<[string, Array<[string, string]>]>;
    h: Array<[string]>;
  };
  assert.equal(wire.v, BLOCK_SELECTOR_CHUNK_VERSION);
  assert.deepEqual(
    wire.r.map((item) => item[0]),
    ['r0', 'r1', 'r2', 'r3'],
  );
  assert.deepEqual(
    wire.r[0]![1].map((cell) => cell[0]),
    ['c0', 'c1', 'c2', 'c3'],
  );
  assert.equal(wire.h[0]![0], 'h0');
  assert.equal(wire.a[1], true);
  for (const sourceId of [
    ...english.sourceObservationIds,
    ...german.sourceObservationIds,
    ...lithuanian.sourceObservationIds,
    heading.id,
  ])
    assert.equal(serialized.includes(sourceId), false);
  assert.equal(serialized.includes('biomarkerId'), false);
  assert.equal(serialized.includes('specimenType'), false);
});

test('schema binds every row branch to its row-local compact cell range', () => {
  const short = row('short', ['Label', '9'], { row: 5 });
  const format = createBlockSelectorFormat(
    [short, english],
    [heading],
    2,
    valueAuthority(short, english),
  ) as {
    properties: {
      selections: {
        required: string[];
        properties: Record<string, { anyOf: Array<{ properties?: Record<string, unknown> }> }>;
      };
    };
  };
  const selections = format.properties.selections;
  assert.deepEqual(selections.required, ['r0', 'r1']);
  assert.deepEqual(selections.properties.r0!.anyOf[1]!.properties!.valueKey, {
    enum: ['c1'],
  });
  assert.equal(JSON.stringify(format).includes('h0'), false);
});

test('expands exact row-local keys while identical visible text keeps distinct source identity', () => {
  const repeated = row('repeated', ['Marker', 'negative', 'qualitative', 'negative'], { row: 6 });
  const state = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection() },
    },
    [repeated],
    valueAuthority(repeated),
  );
  assert.equal(state.malformedEnvelope, false);
  assert.equal(state.failures.length, 0);
  assert.equal(state.selections.length, 1);
  assert.deepEqual(state.selections[0]!.sourceFields, {
    label: repeated.sourceObservationIds[0],
    value: repeated.sourceObservationIds[1],
    unit: repeated.sourceObservationIds[2],
    referenceInterval: repeated.sourceObservationIds[3],
    flag: null,
  });
});

test('rejects unknown cross-row keys and heading keys without accepting siblings incorrectly', () => {
  const short = row('short', ['Label', '9'], { row: 5 });
  const crossRow = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection({ valueKey: 'c3' }), r1: selection() },
    },
    [short, english],
    valueAuthority(short, english),
  );
  assert.ok(crossRow.failures.includes('unknown-cell-key'));
  assert.equal(crossRow.selections.length, 1);
  assert.equal(crossRow.selections[0]!.rowId, english.rowId);

  const headingAttempt = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection({ labelKey: 'h0' }) },
    },
    [english],
    valueAuthority(english),
  );
  assert.deepEqual(headingAttempt.selections, []);
  assert.ok(headingAttempt.failures.includes('heading-cell-key'));
});

test('requires exactly one structurally unique output slot for every input row', () => {
  const missing = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection() },
    },
    [english, german],
    valueAuthority(english, german),
  );
  assert.equal(missing.malformedEnvelope, true);
  assert.deepEqual(missing.selections, []);
  assert.deepEqual(missing.rejectedRows, [english, german]);
});

test('rejects unknown or extra row slots without partially accepting valid siblings', () => {
  const state = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection(), r999: selection() },
    },
    [english],
    valueAuthority(english),
  );
  assert.equal(state.malformedEnvelope, true);
  assert.deepEqual(state.selections, []);
  assert.ok(state.failures.includes('malformed-envelope'));
});

test('rejects unvalidated source alignment before expanding compact keys', () => {
  const invalid = {
    ...english,
    sourceObservationIds: [
      english.sourceObservationIds[1]!,
      english.sourceObservationIds[0]!,
      ...english.sourceObservationIds.slice(2),
    ],
  };
  const state = validateBlockSelectorOutput(
    { schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION, selections: { r0: selection() } },
    [invalid],
    valueAuthority(invalid),
  );
  assert.equal(state.malformedEnvelope, true);
  assert.deepEqual(state.selections, []);
  assert.ok(state.failures.includes('invalid-input'));
});

test('rejects duplicate cell reuse, extra fields, malformed envelopes, and oversized output', () => {
  const duplicateCell = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: selection({ labelKey: 'c1' }) },
    },
    [english],
    valueAuthority(english),
  );
  assert.ok(duplicateCell.failures.includes('duplicate-cell'));

  const extra = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: { ...selection(), explanation: 'not allowed' } },
    },
    [english],
    valueAuthority(english),
  );
  assert.ok(extra.failures.includes('invalid-selection'));

  assert.equal(
    validateBlockSelectorOutput(null, [english], valueAuthority(english)).malformedEnvelope,
    true,
  );
  const oversized = validateBlockSelectorOutput(
    {
      schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null },
      padding: 'x'.repeat(25_000),
    },
    [english],
    valueAuthority(english),
  );
  assert.ok(oversized.failures.includes('oversized-output'));
});

test('binds the value key to the caller-validated source-anchor authority', () => {
  const alternateAuthority = new Map([
    [english.rowId, [english.sourceObservationIds[2]!]],
  ] as const);
  const state = validateBlockSelectorOutput(
    { schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION, selections: { r0: selection() } },
    [english],
    alternateAuthority,
  );
  assert.deepEqual(state.selections, []);
  assert.ok(state.failures.includes('value-outside-authority'));

  const foreignAuthority = new Map([[english.rowId, ['not-a-row-source']]] as const);
  assert.throws(
    () => createBlockSelectorFormat([english], [], 2, foreignAuthority),
    /block-selector-authority/u,
  );
  assert.ok(
    validateBlockSelectorOutput(
      { schemaVersion: BLOCK_SELECTOR_SCHEMA_VERSION, selections: { r0: null } },
      [english],
      foreignAuthority,
    ).failures.includes('invalid-input'),
  );
});

test('plans stable physical blocks without crossing page or table and retains oversized rows', () => {
  const laterPage = row('later-page', ['Marker', '4'], { page: 1, row: 0 });
  const otherTable = row('other-table', ['Marker', '5'], { table: 'table-b', row: 0 });
  const oversized = row(
    'oversized',
    Array.from({ length: 129 }, (_, index) => String(index)),
    { row: 8 },
  );
  const plan = planBlockSelectorBlocks(
    [laterPage, german, english, otherTable, lithuanian, oversized],
    2,
  );
  assert.deepEqual(
    plan.blocks.map((block) => block.map((item) => item.rowId)),
    [['other-table'], ['english', 'german'], ['lithuanian'], ['later-page']],
  );
  assert.deepEqual(
    plan.rejectedRows.map((item) => item.rowId),
    ['oversized'],
  );
});

test('fails closed on cross-context input, heading overlap, excessive headings, and oversized block', () => {
  const otherPage = row('other-page', ['Marker', '8'], { page: 1 });
  assert.throws(
    () => serializeBlockSelectorChunk([english, otherPage], [], 'en-US', 2),
    /block-selector-context/u,
  );
  assert.throws(
    () =>
      serializeBlockSelectorChunk(
        [english],
        [{ ...heading, id: english.sourceObservationIds[0]! }],
        'en-US',
        2,
      ),
    /block-selector-input/u,
  );
  assert.throws(
    () =>
      serializeBlockSelectorChunk(
        [english],
        Array.from({ length: 5 }, (_, index) => ({ ...heading, id: `heading-${index}` })),
        'en-US',
        2,
      ),
    /block-selector-input/u,
  );
  assert.throws(
    () => serializeBlockSelectorChunk([english, german, lithuanian], [], 'en-US', 2),
    /block-selector-input/u,
  );
});

test('reports diagnostic and current production context fit separately', () => {
  const tiny = blockSelectorPromptBudget('tiny prompt', 2);
  assert.equal(tiny.diagnosticFits, true);
  assert.equal(tiny.productionContextFits, true);
  assert.equal(tiny.productionPlausible, true);

  const diagnosticOnly = blockSelectorPromptBudget('x '.repeat(1_500), 8);
  assert.equal(diagnosticOnly.diagnosticFits, true);
  assert.equal(diagnosticOnly.productionContextFits, false);
  assert.equal(diagnosticOnly.productionPlausible, false);
  assert.equal(blockSelectorPromptBudget('tiny prompt', 16).productionPlausible, false);
  const unicode = 'Transferazė 🧪 漢字';
  assert.ok(estimateBlockSelectorTokens(unicode) >= new TextEncoder().encode(unicode).byteLength);
});

test('prompt keeps headings read-only and rejects a block that exceeds diagnostic reserve', () => {
  const serialized = serializeBlockSelectorChunk([english, german], [heading], 'en-US', 2);
  const prompt = createBlockSelectorPrompt('en-US', serialized, 2);
  assert.match(prompt, /Headings are read-only/u);
  assert.match(prompt, new RegExp(BLOCK_SELECTOR_SCHEMA_VERSION, 'u'));
  assert.throws(
    () => createBlockSelectorPrompt('en-US', 'x'.repeat(20_000), 16),
    /block-selector-prompt/u,
  );
  assert.throws(
    () => createBlockSelectorPrompt('en-US', 'x'.repeat(1_500), 2),
    /block-selector-prompt/u,
  );
  assert.throws(
    () => createBlockSelectorPrompt('en-US', '{}', 99 as never),
    /block-selector-input/u,
  );
});
