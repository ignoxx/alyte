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
  GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
  GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
  createGeometryVariantSelectorPrompt,
  createGeometryVariantSelectorRetryPrompt,
  enumerateGeometryRoleVariants,
  estimateGeometryVariantSelectorTokens,
  geometryVariantSelectorContractMetadata,
  serializeGeometryVariantSelectorChunk,
  validateGeometryVariantSelectorOutputWithState,
  variantSelectorPromptBudget,
} from './geometry-variant-contract';
import { ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR } from './geometry-variant-selector-grammar.generated';

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

const groups = groupsFrom([
  cell('label-a', 'Fabricated marker A', 0, 0),
  cell('value-a', '7.2', 0, 1),
  cell('unit-a', 'mg/L', 0, 2),
  cell('range-a', '4-8', 0, 3),
  cell('flag-a', 'H', 0, 4),
  cell('label-b', 'Transferazė', 1, 0, { language: 'lt' }),
  cell('value-b-first', '12,4', 1, 1, { language: 'lt' }),
  cell('unit-b', 'U/L', 1, 2, { language: 'lt' }),
  cell('value-b-second', '13,1', 1, 3, { language: 'lt' }),
]);
const first = groups[0]!;
const second = groups[1]!;
const heading = cell('heading', 'Test Result Unit Reference', 0, 0);

test('keeps the evaluated wire exact and source-free', () => {
  const serialized = serializeGeometryVariantSelectorChunk([second], [heading], 'lt-LT');
  const wire = JSON.parse(serialized) as {
    v: string;
    l: string;
    a: [number, boolean];
    r: Array<
      [
        string,
        unknown[],
        Array<[string, string, string, string | null, string | null, string | null]>,
      ]
    >;
  };
  assert.deepEqual(wire.v, GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION);
  assert.deepEqual(wire.a, [2, false]);
  assert.equal(wire.l, 'lt-LT');
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
});

test('uses the exact plain evaluator prompt and bounded retry prompt', () => {
  const chunk = serializeGeometryVariantSelectorChunk([first, second], [heading], 'lt-LT');
  const prompt = createGeometryVariantSelectorPrompt('lt-LT', chunk);
  assert.equal(
    prompt,
    `Choose one existing source-linked field-role variant only when the row clearly contains an analyte or biomarker label and that patient's measured result. A number alone is not a measurement. Return null for dates, identifiers, administrative text, addresses, headings, codes, reference-only rows, and anything ambiguous or not clearly a measured laboratory result. Prefer null over guessing. Return every rN exactly once. Use only that row's vN keys. Headings are read-only. Never output text, values, units, mappings, explanations, confidence, or extra fields. Wire: r row [rowKey,cells,variants]; cell [cN,text,alternatives,x,y,width,height]; variant [vN,labelCellKey,valueCellKey,unitCellKey|null,referenceCellKey|null,flagCellKey|null].\nSchema ${GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION}; locale lt-LT; block ${chunk}\nJSON only.`,
  );
  const retry = createGeometryVariantSelectorRetryPrompt('lt-LT', chunk);
  assert.equal(retry, prompt);
  assert.ok(variantSelectorPromptBudget(prompt).productionContextFits);
});

test('native grammar permits only the source-free v2 selection envelope', () => {
  assert.match(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /geometry-variant-selector\.v2/u);
  assert.match(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /selections/u);
  assert.match(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /r0/u);
  assert.match(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /r1/u);
  assert.doesNotMatch(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /proposals/u);
  assert.doesNotMatch(ALYTE_GEOMETRY_VARIANT_SELECTOR_GRAMMAR, /sourceObservation/u);
});

test('expands one accepted multi-anchor choice to one preserve proposal', () => {
  const state = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: 'v0', r1: 'v1' },
    },
    [first, second],
  );
  assert.equal(state.malformedEnvelope, false);
  assert.deepEqual(state.selections, [
    { rowKey: 'r0', variantKey: 'v0' },
    { rowKey: 'r1', variantKey: 'v1' },
  ]);
  assert.equal(state.proposals.length, 2);
  assert.deepEqual(state.proposals[0], {
    sourceObservationIds: [...first.sourceObservationIds],
    sourceFields: first.variants[0]!.provisionalSourceFields,
    proposedBiomarkerId: null,
    role: 'preserve',
  });
  assert.deepEqual(state.proposals[1], {
    sourceObservationIds: [...second.sourceObservationIds],
    sourceFields: second.variants[1]!.provisionalSourceFields,
    proposedBiomarkerId: null,
    role: 'preserve',
  });
  assert.equal(Object.hasOwn(state.proposals[0]!, 'proposedSpecimenType'), false);
});

test('keeps same-anchor label choices distinct and projects the selected exact label', () => {
  const ambiguous = groupsFrom([
    cell('amb-label-a', 'Marker alpha', 0, 0),
    cell('amb-label-b', 'Marker beta', 0, 1),
    cell('amb-value', '8.4', 0, 2),
  ])[0]!;
  const variants = enumerateGeometryRoleVariants(ambiguous);
  assert.deepEqual(
    variants?.map((variant) => variant.sourceFields),
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

  const state = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: 'v1' },
    },
    [ambiguous],
  );
  assert.deepEqual(state.proposals[0]?.sourceFields, variants?.[1]?.sourceFields);

  const rightHandLabel = groupsFrom([
    cell('left-label', 'Marker left', 0, 0),
    cell('center-value', '8.4', 0, 1),
    cell('right-label', 'Marker right', 0, 2),
  ])[0]!;
  assert.deepEqual(
    enumerateGeometryRoleVariants(rightHandLabel)?.map((variant) => variant.sourceFields.label),
    ['left-label'],
  );
});

test('serializes retained support prose without making it a selectable label', () => {
  const group = groupsFrom([
    cell('supported-label', 'Marker alpha', 0, 0),
    cell('supported-value', '8.4', 0, 1),
    cell('supporting-prose', 'This is a comment', 0, 2),
  ])[0]!;

  assert.deepEqual(group.variants[0]?.ambiguousSourceRoles, ['label']);
  assert.deepEqual(
    enumerateGeometryRoleVariants(group)?.map((variant) => variant.sourceFields.label),
    ['supported-label'],
  );
  assert.doesNotThrow(() => serializeGeometryVariantSelectorChunk([group], [], 'en-US'));
});

test('serializes extended English and German qualitative result groups through the strict contract', () => {
  for (const [language, locale, label, value] of [
    ['en', 'en-US', 'Culture response', 'resistant'],
    ['de', 'de-DE', 'Kulturantwort', 'empfindlich'],
  ] as const) {
    const group = groupsFrom([
      cell(`${language}-qualitative-label`, label, 0, 0, { language }),
      cell(`${language}-qualitative-value`, value, 0, 1, { language }),
    ])[0]!;

    assert.equal(enumerateGeometryRoleVariants(group)?.length, 1);
    assert.doesNotThrow(() => serializeGeometryVariantSelectorChunk([group], [], locale));
  }
});

test('keeps explicit null as deterministic review work', () => {
  const state = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null, r1: null },
    },
    [first, second],
  );
  assert.deepEqual(state.proposals, []);
  assert.deepEqual(state.rejectedGroups, [first, second]);
  assert.deepEqual(state.failures, []);
});

test('rejects malformed envelopes and cross-row keys without invention', () => {
  for (const selections of [
    { r0: 'v0' },
    { r0: 'v0', r1: null, r2: 'v0' },
    { r0: 'v1', r1: 'v9' },
  ]) {
    const state = validateGeometryVariantSelectorOutputWithState(
      { schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION, selections },
      [first, second],
    );
    assert.deepEqual(state.proposals, []);
    assert.equal(state.malformedEnvelope, selections.r1 === undefined || 'r2' in selections);
  }
  const extra = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null, r1: null, extra: null },
    },
    [first, second],
  );
  assert.equal(extra.malformedEnvelope, true);

  const stale = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: 'alyte.geometry-variant-selector.v1',
      selections: { r0: null, r1: null },
    },
    [first, second],
  );
  assert.equal(stale.malformedEnvelope, true);
  assert.deepEqual(stale.proposals, []);
});

test('fails closed on malformed or provenance-corrupt source groups', () => {
  assert.equal(
    validateGeometryVariantSelectorOutputWithState(null, [first]).malformedEnvelope,
    true,
  );
  const corrupt = {
    ...first,
    variants: [{ ...first.variants[0]!, physicalRowId: 'forged' }],
  };
  assert.ok(
    validateGeometryVariantSelectorOutputWithState(
      { schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION, selections: { r0: null } },
      [corrupt],
    ).failures.includes('invalid-input'),
  );
  assert.throws(
    () => serializeGeometryVariantSelectorChunk([corrupt], [], 'en-US'),
    /geometry-variant-selector-input-invalid/u,
  );
  const corruptFields = {
    ...first,
    variants: [
      {
        ...first.variants[0]!,
        provisionalSourceFields: {
          ...first.variants[0]!.provisionalSourceFields,
          label: first.variants[0]!.anchorCellId,
        },
      },
    ],
  };
  assert.ok(
    validateGeometryVariantSelectorOutputWithState(
      { schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION, selections: { r0: 'v0' } },
      [corruptFields],
    ).failures.includes('invalid-input'),
  );
});

test('rejects cross-context groups, headings outside the page, and oversized groups', () => {
  const other = groupsFrom([
    cell('other-label', 'Other marker', 0, 0, { table: 'other' }),
    cell('other-value', '4.2', 0, 1, { table: 'other' }),
  ])[0]!;
  assert.throws(
    () => serializeGeometryVariantSelectorChunk([first, other], [], 'en-US'),
    /geometry-variant-selector-input-invalid/u,
  );
  assert.throws(
    () => serializeGeometryVariantSelectorChunk([first], [{ ...heading, pageIndex: 1 }], 'en-US'),
    /geometry-variant-selector-input-invalid/u,
  );
  const tooMany = {
    ...first,
    physicalRowCells: [
      ...first.physicalRowCells,
      ...first.physicalRowCells,
      ...first.physicalRowCells,
      ...first.physicalRowCells,
      ...first.physicalRowCells,
    ],
  };
  assert.throws(
    () => serializeGeometryVariantSelectorChunk([tooMany], [], 'en-US'),
    /geometry-variant-selector-input-invalid/u,
  );

  const overfull = overfullRoleGroup();
  assert.equal(enumerateGeometryRoleVariants(overfull), null);
  assert.throws(
    () => serializeGeometryVariantSelectorChunk([overfull], [], 'en-US'),
    /geometry-variant-selector-input-invalid/u,
  );
});

test('enforces the 2,048-token and 96-output production budget', () => {
  assert.equal(geometryVariantSelectorContractMetadata.limits.maxGroups, 2);
  assert.equal(geometryVariantSelectorContractMetadata.limits.maxVariantCells, 6);
  assert.equal(geometryVariantSelectorContractMetadata.limits.outputTokens, 96);
  const chunk = serializeGeometryVariantSelectorChunk([first, second], [heading], 'lt-LT');
  const prompt = createGeometryVariantSelectorPrompt('lt-LT', chunk);
  const budget = variantSelectorPromptBudget(prompt);
  assert.ok(budget.promptTokens + 96 <= 2_048);
  assert.ok(estimateGeometryVariantSelectorTokens('Transferazė 🧪 漢字') >= 1);
  assert.throws(
    () => createGeometryVariantSelectorPrompt('en-US', 'x'.repeat(30_000)),
    /geometry-variant-selector-prompt-too-large/u,
  );
  const oversized = validateGeometryVariantSelectorOutputWithState(
    {
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null },
      padding: 'x'.repeat(9_000),
    },
    [first],
  );
  assert.ok(oversized.failures.includes('oversized-output'));
});

void (groups satisfies readonly GeometryCandidateWindowGroup[]);
