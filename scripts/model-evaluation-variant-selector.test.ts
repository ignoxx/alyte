import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
  reconstructGeometryLattice,
  type GeometryCandidateWindowGroup,
  type GeometrySourceObservation,
  type VisionTextObservation,
} from '@alyte/domain';
import {
  VARIANT_SELECTOR_CHUNK_VERSION,
  VARIANT_SELECTOR_SCHEMA_VERSION,
  createVariantSelectorFormat,
  createVariantSelectorPrompt,
  enumerateRoleVariants,
  estimateVariantSelectorTokens,
  planVariantSelectorBlocks,
  projectVariantSourceFields,
  serializeVariantSelectorChunk,
  validateVariantSelectorOutput,
  variantSelectorPromptBudget,
} from './model-evaluation-variant-selector';

function cell(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
  options: { readonly page?: number; readonly table?: string; readonly language?: string } = {},
): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    pageIndex: options.page ?? 0,
    orientation: 0,
    boundingBox: {
      x: 0.04 + columnIndex * 0.18,
      y: 0.12 + rowIndex * 0.07,
      width: 0.15,
      height: 0.03,
    },
    recognition: {
      level: 'accurate',
      language: options.language ?? 'en',
      internalConfidence: null,
    },
    structure: {
      kind: 'table-cell',
      tableId: options.table ?? 'results',
      rowIndex,
      columnIndex,
    },
  };
}

function groupsFrom(source: readonly VisionTextObservation[]) {
  const lattice = reconstructGeometryLattice(source as readonly GeometrySourceObservation[]);
  return groupGeometryCandidateWindows(buildGeometryCandidateWindows(lattice, source));
}

function overfullRoleGroup(): GeometryCandidateWindowGroup {
  const source: VisionTextObservation[] = [];
  for (let index = 0; index < 7; index += 1) {
    source.push(
      {
        ...cell(
          `dense-label-${index}`,
          `Synthetic marker ${String.fromCharCode(65 + index)}`,
          0,
          0,
        ),
        boundingBox: { x: 0.02 + index * 0.045, y: 0.12, width: 0.04, height: 0.03 },
        structure: { kind: 'table-cell', tableId: 'results', rowIndex: 0, columnIndex: index },
      },
      {
        ...cell(`dense-value-${index}`, `${10 + index}`, 0, 0),
        boundingBox: { x: 0.62 + index * 0.045, y: 0.12, width: 0.04, height: 0.03 },
        structure: {
          kind: 'table-cell',
          tableId: 'results',
          rowIndex: 0,
          columnIndex: index + 7,
        },
      },
    );
  }
  return groupsFrom(source)[0]!;
}

const source = [
  cell('label-a', 'Fabricated marker A', 0, 0),
  cell('value-a', '7.2', 0, 1),
  cell('unit-a', 'mg/L', 0, 2),
  cell('range-a', '4-8', 0, 3),
  cell('flag-a', 'H', 0, 4),
  cell('label-b', 'Transferazė', 1, 0, { language: 'lt' }),
  cell('value-b-first', '12,4', 1, 1, { language: 'lt' }),
  cell('unit-b', 'U/L', 1, 2, { language: 'lt' }),
  cell('value-b-second', '13,1', 1, 3, { language: 'lt' }),
];
const baseGroups = groupsFrom(source);
const first = baseGroups[0]!;
const second = baseGroups[1]!;
const heading = cell('heading', 'Test Result Unit Reference', 0, 0);

test('synthetic fixture exposes one physical group and all exact anchor variants', () => {
  assert.equal(baseGroups.length, 2);
  assert.equal(first.variants.length, 1);
  assert.equal(second.variants.length, 2);
});

test('serializes deduplicated cells and local variants without durable identities', () => {
  const serialized = serializeVariantSelectorChunk([second], [heading], 'lt-LT', 2);
  const wire = JSON.parse(serialized) as {
    v: string;
    r: Array<
      [
        string,
        unknown[],
        Array<[string, string, string, string | null, string | null, string | null]>,
      ]
    >;
  };
  assert.equal(wire.v, VARIANT_SELECTOR_CHUNK_VERSION);
  assert.equal(wire.r[0]![1].length, second.observations.length);
  assert.deepEqual(
    wire.r[0]![2].map((variant) => variant[0]),
    ['v0', 'v1'],
  );
  assert.deepEqual(
    wire.r[0]![2].map((variant) => variant.slice(1, 3)),
    [
      ['c0', 'c1'],
      ['c0', 'c3'],
    ],
  );
  for (const forbidden of [
    second.rowId,
    second.physicalRowId,
    second.physicalRowKey,
    ...second.sourceObservationIds,
    ...second.variants.map((variant) => variant.rowId),
  ])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(serialized.includes('specimenKey'), false);
  assert.equal(serialized.includes('biomarker'), false);
});

test('schema and validator accept one exact variant plus an explicit null omission', () => {
  const format = createVariantSelectorFormat([first, second], [], 2) as {
    properties: { selections: { required: string[]; properties: Record<string, unknown> } };
  };
  assert.deepEqual(format.properties.selections.required, ['r0', 'r1']);
  assert.deepEqual(format.properties.selections.properties.r0, { enum: [null, 'v0'] });
  assert.deepEqual(format.properties.selections.properties.r1, {
    enum: [null, 'v0', 'v1'],
  });

  const state = validateVariantSelectorOutput(
    {
      schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: 'v0', r1: null },
    },
    [first, second],
  );
  assert.equal(state.malformedEnvelope, false);
  assert.equal(state.failures.length, 0);
  assert.deepEqual(state.selections, [{ rowKey: 'r0', variantKey: 'v0' }]);
  const serializedSelection = JSON.stringify(state.selections);
  for (const forbidden of [
    first.physicalRowId,
    first.physicalRowKey,
    first.variants[0]!.rowId,
    ...first.sourceObservationIds,
  ])
    assert.equal(serializedSelection.includes(forbidden), false);
  assert.deepEqual(state.rejectedGroups, [second]);
});

test('rejects missing, extra, cross-row, and unknown variant keys without partial invention', () => {
  for (const selections of [{ r0: 'v0' }, { r0: 'v0', r1: null, r2: 'v0' }]) {
    const state = validateVariantSelectorOutput(
      { schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION, selections },
      [first, second],
    );
    assert.equal(state.malformedEnvelope, true);
    assert.deepEqual(state.selections, []);
  }
  const crossRow = validateVariantSelectorOutput(
    {
      schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: 'v1', r1: 'v9' },
    },
    [first, second],
  );
  assert.equal(crossRow.malformedEnvelope, false);
  assert.deepEqual(crossRow.selections, []);
  assert.equal(crossRow.failures.filter((failure) => failure === 'unknown-variant-key').length, 2);

  const stale = validateVariantSelectorOutput(
    {
      schemaVersion: 'alyte.geometry-variant-selector.v1',
      selections: { r0: null, r1: null },
    },
    [first, second],
  );
  assert.equal(stale.malformedEnvelope, true);
  assert.deepEqual(stale.selections, []);
});

test('rejects malformed, oversized, and provenance-corrupt inputs fail closed', () => {
  assert.equal(validateVariantSelectorOutput(null, [first]).malformedEnvelope, true);
  const oversized = validateVariantSelectorOutput(
    {
      schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null },
      padding: 'x'.repeat(9_000),
    },
    [first],
  );
  assert.ok(oversized.failures.includes('oversized-output'));

  const corrupt = {
    ...first,
    variants: [{ ...first.variants[0]!, physicalRowId: 'forged' }],
  };
  assert.throws(
    () => serializeVariantSelectorChunk([corrupt], [], 'en-US', 2),
    /variant-selector-input/u,
  );
  assert.ok(
    validateVariantSelectorOutput(
      { schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION, selections: { r0: null } },
      [corrupt],
    ).failures.includes('invalid-input'),
  );

  const forgedGroup = { ...first, rowId: 'forged-group' };
  assert.throws(
    () => serializeVariantSelectorChunk([forgedGroup], [], 'en-US', 2),
    /variant-selector-input/u,
  );

  const forgedSourceCell = {
    ...first,
    sourceCells: [
      { ...first.sourceCells[0]!, text: `${first.sourceCells[0]!.text} forged` },
      ...first.sourceCells.slice(1),
    ],
  };
  assert.throws(
    () => serializeVariantSelectorChunk([forgedSourceCell], [], 'en-US', 2),
    /variant-selector-input/u,
  );
});

test('plans stable context-local blocks and keeps an out-of-bounds group as review work', () => {
  const later = groupsFrom([
    cell('later-label', 'Later marker', 0, 0, { page: 1 }),
    cell('later-value', '4.2', 0, 1, { page: 1 }),
  ])[0]!;
  const outOfBounds = { ...first, rowId: 'out-of-bounds', withinInputBounds: false };
  const plan = planVariantSelectorBlocks([later, second, outOfBounds, first], [], 'en-US', 2);
  assert.deepEqual(
    plan.blocks.map((block) => block.map((group) => group.rowId)),
    [[first.rowId, second.rowId], [later.rowId]],
  );
  assert.deepEqual(plan.rejectedGroups, [outOfBounds]);
});

test('deterministically projects exact numeric fields without model-authored values', () => {
  const fields = projectVariantSourceFields(first.variants[0]!);
  assert.deepEqual(fields, {
    sourceFields: {
      label: 'label-a',
      value: 'value-a',
      unit: 'unit-a',
      referenceInterval: 'range-a',
      flag: 'flag-a',
    },
    ambiguousSourceRoles: [],
  });
});

test('projects categorical values and leaves ambiguous label roles unresolved', () => {
  const categorical = groupsFrom([
    cell('cat-label', 'Fabricated antibody', 0, 0),
    cell('cat-value', 'Negative', 0, 1),
  ])[0]!;
  assert.deepEqual(projectVariantSourceFields(categorical.variants[0]!), {
    sourceFields: {
      label: 'cat-label',
      value: 'cat-value',
      unit: null,
      referenceInterval: null,
      flag: null,
    },
    ambiguousSourceRoles: [],
  });

  const ambiguous = groupsFrom([
    cell('amb-label-a', 'Marker alpha', 0, 0),
    cell('amb-label-b', 'Marker beta', 0, 1),
    cell('amb-value', '8.4', 0, 2),
  ])[0]!;
  assert.deepEqual(projectVariantSourceFields(ambiguous.variants[0]!), {
    sourceFields: ambiguous.variants[0]!.provisionalSourceFields,
    ambiguousSourceRoles: ['label'],
  });
  const roleVariants = enumerateRoleVariants(ambiguous);
  assert.deepEqual(
    roleVariants?.map((variant) => variant.sourceFields),
    [
      {
        label: 'amb-label-a',
        value: 'amb-value',
        unit: null,
        referenceInterval: null,
        flag: null,
      },
      {
        label: 'amb-label-b',
        value: 'amb-value',
        unit: null,
        referenceInterval: null,
        flag: null,
      },
    ],
  );
  const ambiguousFormat = createVariantSelectorFormat([ambiguous], [], 2) as {
    properties: { selections: { properties: Record<string, unknown> } };
  };
  assert.deepEqual(ambiguousFormat.properties.selections.properties.r0, {
    enum: [null, 'v0', 'v1'],
  });
  const rejectedAmbiguous = validateVariantSelectorOutput(
    {
      schemaVersion: VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: 'v0' },
    },
    [ambiguous],
  );
  assert.deepEqual(rejectedAmbiguous.selections, [{ rowKey: 'r0', variantKey: 'v0' }]);

  const rightHandLabel = groupsFrom([
    cell('left-label', 'Marker left', 0, 0),
    cell('center-value', '8.4', 0, 1),
    cell('right-label', 'Marker right', 0, 2),
  ])[0]!;
  assert.deepEqual(
    enumerateRoleVariants(rightHandLabel)?.map((variant) => variant.sourceFields.label),
    ['left-label'],
  );

  const ambiguousUnit = groupsFrom([
    cell('amb-unit-label', 'Marker gamma', 0, 0),
    cell('amb-unit-value', '8.4', 0, 1),
    cell('amb-unit-first', 'mg/L', 0, 2),
    cell('amb-unit-second', 'ng/mL', 0, 3),
  ])[0]!;
  assert.deepEqual(projectVariantSourceFields(ambiguousUnit.variants[0]!), {
    sourceFields: ambiguousUnit.variants[0]!.provisionalSourceFields,
    ambiguousSourceRoles: ['unit'],
  });
});

test('enforces production budget with a multilingual byte-fallback bound', () => {
  const serialized = serializeVariantSelectorChunk([first, second], [heading], 'lt-LT', 2);
  const prompt = createVariantSelectorPrompt('lt-LT', serialized, 2);
  const budget = variantSelectorPromptBudget(prompt, 2);
  assert.equal(budget.productionPlausible, true);
  const unicode = 'Transferazė 🧪 漢字';
  assert.ok(estimateVariantSelectorTokens(unicode) >= new TextEncoder().encode(unicode).byteLength);
  assert.throws(
    () => createVariantSelectorPrompt('en-US', 'x'.repeat(1_700), 2),
    /variant-selector-prompt/u,
  );
});

test('fails closed on cross-context blocks and heading/source overlap', () => {
  const otherTable = groupsFrom([
    cell('other-label', 'Other marker', 0, 0, { table: 'other' }),
    cell('other-value', '4.2', 0, 1, { table: 'other' }),
  ])[0]!;
  assert.throws(
    () => serializeVariantSelectorChunk([first, otherTable], [], 'en-US', 2),
    /variant-selector-input/u,
  );
  assert.throws(
    () =>
      serializeVariantSelectorChunk(
        [first],
        [{ ...heading, id: first.sourceObservationIds[0]! }],
        'en-US',
        2,
      ),
    /variant-selector-input/u,
  );

  const overfull = overfullRoleGroup();
  assert.equal(enumerateRoleVariants(overfull), null);
  assert.throws(
    () => serializeVariantSelectorChunk([overfull], [], 'en-US', 2),
    /variant-selector-input/u,
  );
});

void (baseGroups satisfies readonly GeometryCandidateWindowGroup[]);
