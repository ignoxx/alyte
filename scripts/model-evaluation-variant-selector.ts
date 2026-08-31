import {
  enumerateGeometryFieldCandidates,
  isGeometryCandidateLabelText,
  type ExtractionSemanticFieldSelection,
  type GeometryCandidateContext,
  type GeometryCandidateWindowGroup,
  type GeometryCandidateWindowRow,
  type GeometryRow,
  type VisionTextObservation,
} from '@alyte/domain';

export const VARIANT_SELECTOR_SCHEMA_VERSION = 'alyte.geometry-variant-selector.v2' as const;
export const VARIANT_SELECTOR_CHUNK_VERSION = 'alyte.geometry-variant-selector.chunk.v2' as const;
export const VARIANT_SELECTOR_PROMPT_VERSION = 'alyte.geometry-variant-selector.prompt.v3' as const;

export type VariantSelectorSize = 2 | 8 | 16;

export const VARIANT_SELECTOR_LIMITS = Object.freeze({
  maxGroups: 16,
  maxGroupCells: 24,
  maxVariantCells: 6,
  maxVariantsPerGroup: 24,
  maxHeadings: 4,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxInputBytes: 24 * 1024,
  maxPromptBytes: 24 * 1024,
  maxOutputBytes: 8 * 1024,
  diagnosticContextTokens: 8_192,
  diagnosticOutputTokens: 512,
  productionContextTokens: 2_048,
  productionOutputTokens: 96,
});

export type VariantSelectorSelection = {
  /** Request-local keys only. Resolve against the in-memory input and retain its complete group. */
  readonly rowKey: string;
  readonly variantKey: string;
};

export type VariantSourceProjection = {
  readonly sourceFields: ExtractionSemanticFieldSelection;
  readonly ambiguousSourceRoles: readonly ('label' | 'unit' | 'reference' | 'flag')[];
};

export type VariantSelectorFailureCode =
  | 'invalid-input'
  | 'malformed-envelope'
  | 'oversized-output'
  | 'unknown-row-key'
  | 'unknown-variant-key'
  | 'unprojectable-variant';

export type VariantSelectorValidation = {
  readonly selections: readonly VariantSelectorSelection[];
  /** Sensitive source-bearing inputs for a device-local retry only; never log or aggregate. */
  readonly rejectedGroups: readonly GeometryCandidateWindowGroup[];
  readonly malformedEnvelope: boolean;
  readonly failures: readonly VariantSelectorFailureCode[];
};

export type VariantSelectorPlan = {
  readonly blocks: readonly (readonly GeometryCandidateWindowGroup[])[];
  readonly rejectedGroups: readonly GeometryCandidateWindowGroup[];
};

function fail(code: string): never {
  throw new Error(`model-evaluation-failed:${code}`);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateContextKey(context: GeometryCandidateContext): string {
  return JSON.stringify([
    context.pageIndex,
    context.tableId,
    context.sectionId,
    context.specimenKey,
    context.collectionDateKey,
  ]);
}

function opaqueCandidateId(sourceKey: string, prefix: 'pr-' | 'gw-'): string {
  const seeds = [2166136261, 2246822519, 3266489917, 668265263] as const;
  const digest = seeds
    .map((seed) => {
      let hash: number = seed;
      for (const character of sourceKey) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
  return `${prefix}${digest}`;
}

function sameContext(left: GeometryCandidateContext, right: GeometryCandidateContext): boolean {
  return (
    left.pageIndex === right.pageIndex &&
    left.tableId === right.tableId &&
    left.sectionId === right.sectionId &&
    left.specimenKey === right.specimenKey &&
    left.collectionDateKey === right.collectionDateKey
  );
}

function validateObservation(observation: VisionTextObservation): void {
  if (
    observation.id.length === 0 ||
    observation.id.length > 96 ||
    observation.text.length > VARIANT_SELECTOR_LIMITS.maxObservationTextCharacters ||
    observation.alternatives.some(
      (alternative) => alternative.length > VARIANT_SELECTOR_LIMITS.maxAlternativeCharacters,
    ) ||
    !Number.isFinite(observation.boundingBox.x) ||
    !Number.isFinite(observation.boundingBox.y) ||
    !Number.isFinite(observation.boundingBox.width) ||
    !Number.isFinite(observation.boundingBox.height) ||
    observation.boundingBox.width <= 0 ||
    observation.boundingBox.height <= 0
  )
    fail('variant-selector-input');
}

function validateGroup(group: GeometryCandidateWindowGroup): void {
  const expectedPhysicalRowKey = JSON.stringify([
    'physical-row',
    group.physicalRowCells,
    candidateContextKey(group.context),
  ]);
  const physicalCellIds = new Set<string>();
  for (const cell of group.physicalRowCells) {
    if (
      cell.id.length === 0 ||
      cell.id.length > 96 ||
      cell.parentId.length === 0 ||
      cell.sourceObservationId.length === 0 ||
      cell.sourceStart < 0 ||
      cell.sourceEnd <= cell.sourceStart ||
      cell.text.length === 0 ||
      !Number.isFinite(cell.boundingBox.x) ||
      !Number.isFinite(cell.boundingBox.y) ||
      !Number.isFinite(cell.boundingBox.width) ||
      !Number.isFinite(cell.boundingBox.height) ||
      cell.boundingBox.width <= 0 ||
      cell.boundingBox.height <= 0 ||
      physicalCellIds.has(cell.id)
    )
      fail('variant-selector-input');
    physicalCellIds.add(cell.id);
  }
  if (
    !group.withinInputBounds ||
    group.rowId.length === 0 ||
    group.physicalRowId.length === 0 ||
    group.physicalRowKey.length === 0 ||
    group.rowId !== group.physicalRowId ||
    group.physicalRowKey !== expectedPhysicalRowKey ||
    opaqueCandidateId(expectedPhysicalRowKey, 'pr-') !== group.physicalRowId ||
    group.physicalRowCells.length === 0 ||
    group.physicalRowCells.length > VARIANT_SELECTOR_LIMITS.maxGroupCells ||
    group.observations.length === 0 ||
    group.observations.length > VARIANT_SELECTOR_LIMITS.maxGroupCells ||
    group.observations.length !== group.sourceObservationIds.length ||
    group.variants.length === 0 ||
    group.variants.length > VARIANT_SELECTOR_LIMITS.maxVariantsPerGroup ||
    group.anchorCellIds.length !== group.variants.length ||
    group.anchorKinds.length !== group.variants.length ||
    new Set(group.anchorCellIds).size !== group.anchorCellIds.length ||
    new Set(group.sourceObservationIds).size !== group.sourceObservationIds.length
  )
    fail('variant-selector-input');
  group.observations.forEach((observation, index) => {
    validateObservation(observation);
    if (observation.id !== group.sourceObservationIds[index]) fail('variant-selector-input');
  });
  const groupCellById = new Map(group.sourceCells.map((cell) => [cell.id, cell]));
  const physicalCellById = new Map(group.physicalRowCells.map((cell) => [cell.id, cell]));
  if (
    groupCellById.size !== group.sourceCells.length ||
    group.sourceCells.length !== group.observations.length ||
    group.sourceCells.some(
      (cell) =>
        !group.sourceObservationIds.includes(cell.id) ||
        !physicalCellById.has(cell.id) ||
        !equal(physicalCellById.get(cell.id), cell),
    )
  )
    fail('variant-selector-input');
  const variantIds = new Set<string>();
  for (const [index, variant] of group.variants.entries()) {
    if (
      variantIds.has(variant.rowId) ||
      variant.rowId.length === 0 ||
      variant.rowId.length > 96 ||
      variant.physicalRowId !== group.physicalRowId ||
      variant.physicalRowKey !== group.physicalRowKey ||
      !equal(variant.physicalRowCells, group.physicalRowCells) ||
      !sameContext(variant.context, group.context) ||
      variant.anchorCellId !== group.anchorCellIds[index] ||
      variant.anchorKind !== group.anchorKinds[index] ||
      !['numeric', 'categorical'].includes(variant.anchorKind) ||
      opaqueCandidateId(
        JSON.stringify([group.physicalRowKey, variant.anchorCellId, variant.observations]),
        'gw-',
      ) !== variant.rowId ||
      variant.sourceCells.length === 0 ||
      variant.sourceCells.length > VARIANT_SELECTOR_LIMITS.maxVariantCells ||
      variant.sourceCells.length !== variant.observations.length ||
      variant.sourceObservationIds.length !== variant.observations.length ||
      new Set(variant.sourceObservationIds).size !== variant.sourceObservationIds.length ||
      !variant.sourceObservationIds.includes(variant.anchorCellId)
    )
      fail('variant-selector-input');
    variantIds.add(variant.rowId);
    variant.observations.forEach((observation, observationIndex) => {
      validateObservation(observation);
      const groupObservation = group.observations.find((item) => item.id === observation.id);
      const groupCell = groupCellById.get(observation.id);
      if (
        observation.id !== variant.sourceObservationIds[observationIndex] ||
        groupObservation === undefined ||
        groupCell === undefined ||
        !equal(observation, groupObservation) ||
        !equal(variant.sourceCells[observationIndex], groupCell)
      )
        fail('variant-selector-input');
    });
    if (projectVariantSourceFields(variant) === null) fail('variant-selector-input');
  }
  if (enumerateRoleVariants(group) === null) fail('variant-selector-input');
}

function validateInput(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  blockSize: VariantSelectorSize,
): void {
  if (![2, 8, 16].includes(blockSize) || groups.length === 0 || groups.length > blockSize)
    fail('variant-selector-input');
  if (
    groups.length > VARIANT_SELECTOR_LIMITS.maxGroups ||
    headings.length > VARIANT_SELECTOR_LIMITS.maxHeadings
  )
    fail('variant-selector-input');
  const groupIds = new Set<string>();
  const physicalRowIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const group of groups) {
    validateGroup(group);
    if (
      groupIds.has(group.rowId) ||
      physicalRowIds.has(group.physicalRowId) ||
      !sameContext(groups[0]!.context, group.context)
    )
      fail('variant-selector-input');
    groupIds.add(group.rowId);
    physicalRowIds.add(group.physicalRowId);
    for (const sourceId of group.sourceObservationIds) {
      if (sourceIds.has(sourceId)) fail('variant-selector-input');
      sourceIds.add(sourceId);
    }
  }
  const headingIds = new Set<string>();
  for (const heading of headings) {
    validateObservation(heading);
    if (
      headingIds.has(heading.id) ||
      sourceIds.has(heading.id) ||
      heading.pageIndex !== groups[0]!.context.pageIndex
    )
      fail('variant-selector-input');
    headingIds.add(heading.id);
  }
}

function bucket(value: number): number {
  return Math.max(0, Math.min(1_000, Math.round(value * 1_000)));
}

function wireObservation(observation: VisionTextObservation, key: string) {
  return [
    key,
    observation.text,
    [...observation.alternatives].sort((left, right) => left.localeCompare(right)),
    bucket(observation.boundingBox.x),
    bucket(observation.boundingBox.y),
    bucket(observation.boundingBox.width),
    bucket(observation.boundingBox.height),
  ] as const;
}

/** Enumerates only exact, locally validated role assignments; the model sees request-local keys. */
export function enumerateRoleVariants(
  group: GeometryCandidateWindowGroup,
): readonly VariantSourceProjection[] | null {
  const cellById = new Map(group.sourceCells.map((cell) => [cell.id, cell]));
  const result: VariantSourceProjection[] = [];
  const seen = new Set<string>();
  for (const anchorVariant of group.variants) {
    const base = projectVariantSourceFields(anchorVariant);
    const anchor = cellById.get(anchorVariant.anchorCellId);
    if (base === null || anchor === undefined) return null;
    const anchorCenter = anchor.boundingBox.x + anchor.boundingBox.width / 2;
    const labels = group.sourceCells
      .filter(
        (cell) =>
          cell.id !== anchor.id &&
          cell.boundingBox.x + cell.boundingBox.width / 2 < anchorCenter &&
          isGeometryCandidateLabelText(cell.text),
      )
      .sort(
        (left, right) =>
          left.boundingBox.x - right.boundingBox.x ||
          left.boundingBox.y - right.boundingBox.y ||
          left.id.localeCompare(right.id),
      );
    for (const label of labels) {
      const sourceFields = { ...base.sourceFields, label: label.id };
      const selected = Object.values(sourceFields).filter(
        (value): value is string => value !== null,
      );
      if (new Set(selected).size !== selected.length || selected.some((id) => !cellById.has(id)))
        continue;
      const key = JSON.stringify(sourceFields);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        sourceFields,
        ambiguousSourceRoles: [...base.ambiguousSourceRoles],
      });
      if (result.length > VARIANT_SELECTOR_LIMITS.maxVariantsPerGroup) return null;
    }
  }
  return result.length === 0 ? null : result;
}

/** Exact source text is serialized only with request-local keys; durable identities stay local. */
export function serializeVariantSelectorChunk(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  locale: string,
  blockSize: VariantSelectorSize,
): string {
  validateInput(groups, headings, blockSize);
  const value = JSON.stringify({
    v: VARIANT_SELECTOR_CHUNK_VERSION,
    l: locale,
    a: [blockSize, blockSize !== 2],
    r: groups.map((group, groupIndex) => {
      const variants = enumerateRoleVariants(group);
      if (variants === null) fail('variant-selector-input');
      const cellKeyById = new Map(
        group.observations.map((observation, cellIndex) => [observation.id, `c${cellIndex}`]),
      );
      return [
        `r${groupIndex}`,
        group.observations.map((observation, cellIndex) =>
          wireObservation(observation, `c${cellIndex}`),
        ),
        variants.map((variant, variantIndex) => [
          `v${variantIndex}`,
          cellKeyById.get(variant.sourceFields.label),
          cellKeyById.get(variant.sourceFields.value),
          variant.sourceFields.unit === null ? null : cellKeyById.get(variant.sourceFields.unit),
          variant.sourceFields.referenceInterval === null
            ? null
            : cellKeyById.get(variant.sourceFields.referenceInterval),
          variant.sourceFields.flag === null ? null : cellKeyById.get(variant.sourceFields.flag),
        ]),
      ];
    }),
    h: headings.map((heading, index) => wireObservation(heading, `h${index}`)),
  });
  if (new TextEncoder().encode(value).byteLength > VARIANT_SELECTOR_LIMITS.maxInputBytes)
    fail('variant-selector-input');
  return value;
}

/** UTF-8 bytes are a hard byte-fallback upper bound for the reviewed context gate. */
export function estimateVariantSelectorTokens(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function variantSelectorPromptBudget(prompt: string, blockSize: VariantSelectorSize) {
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  const promptTokens = estimateVariantSelectorTokens(prompt);
  const diagnosticFits =
    promptBytes <= VARIANT_SELECTOR_LIMITS.maxPromptBytes &&
    promptTokens + VARIANT_SELECTOR_LIMITS.diagnosticOutputTokens <=
      VARIANT_SELECTOR_LIMITS.diagnosticContextTokens;
  const productionContextFits =
    promptTokens + VARIANT_SELECTOR_LIMITS.productionOutputTokens <=
    VARIANT_SELECTOR_LIMITS.productionContextTokens;
  return {
    promptBytes,
    promptTokens,
    diagnosticFits,
    productionContextFits,
    productionPlausible: blockSize === 2 && productionContextFits,
  } as const;
}

export function createVariantSelectorPrompt(
  locale: string,
  serializedChunk: string,
  blockSize: VariantSelectorSize,
): string {
  if (![2, 8, 16].includes(blockSize)) fail('variant-selector-input');
  const prompt = `Choose one existing source-linked field-role variant only when the row clearly contains an analyte or biomarker label and that patient's measured result. A number alone is not a measurement. Return null for dates, identifiers, administrative text, addresses, headings, codes, reference-only rows, and anything ambiguous or not clearly a measured laboratory result. Prefer null over guessing. Return every rN exactly once. Use only that row's vN keys. Headings are read-only. Never output text, values, units, mappings, explanations, confidence, or extra fields. Wire: r row [rowKey,cells,variants]; cell [cN,text,alternatives,x,y,width,height]; variant [vN,labelCellKey,valueCellKey,unitCellKey|null,referenceCellKey|null,flagCellKey|null].\nSchema ${VARIANT_SELECTOR_SCHEMA_VERSION}; locale ${locale}; block ${serializedChunk}\nJSON only.`;
  const budget = variantSelectorPromptBudget(prompt, blockSize);
  if (!budget.diagnosticFits || (blockSize === 2 && !budget.productionContextFits))
    fail('variant-selector-prompt');
  return prompt;
}

export function createVariantSelectorFormat(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  blockSize: VariantSelectorSize,
): Readonly<Record<string, unknown>> {
  validateInput(groups, headings, blockSize);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'selections'],
    properties: {
      schemaVersion: { const: VARIANT_SELECTOR_SCHEMA_VERSION },
      selections: {
        type: 'object',
        additionalProperties: false,
        required: groups.map((_, index) => `r${index}`),
        properties: Object.fromEntries(
          groups.map((group, index) => [
            `r${index}`,
            {
              enum: [
                null,
                ...(enumerateRoleVariants(group) ?? []).map(
                  (_, variantIndex) => `v${variantIndex}`,
                ),
              ],
            },
          ]),
        ),
      },
    },
  } as const;
}

function rejectAll(
  groups: readonly GeometryCandidateWindowGroup[],
  code: VariantSelectorFailureCode,
): VariantSelectorValidation {
  return {
    selections: [],
    rejectedGroups: groups,
    malformedEnvelope: true,
    failures: [code],
  };
}

export function validateVariantSelectorOutput(
  raw: unknown,
  groups: readonly GeometryCandidateWindowGroup[],
): VariantSelectorValidation {
  try {
    const blockSize: VariantSelectorSize = groups.length <= 2 ? 2 : groups.length <= 8 ? 8 : 16;
    validateInput(groups, [], blockSize);
  } catch {
    return rejectAll(groups, 'invalid-input');
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      VARIANT_SELECTOR_LIMITS.maxOutputBytes
    )
      return rejectAll(groups, 'oversized-output');
  } catch {
    return rejectAll(groups, 'malformed-envelope');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return rejectAll(groups, 'malformed-envelope');
  const root = raw as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => !['schemaVersion', 'selections'].includes(key)) ||
    root.schemaVersion !== VARIANT_SELECTOR_SCHEMA_VERSION ||
    typeof root.selections !== 'object' ||
    root.selections === null ||
    Array.isArray(root.selections)
  )
    return rejectAll(groups, 'malformed-envelope');
  const rawSelections = root.selections as Record<string, unknown>;
  const expectedRowKeys = groups.map((_, index) => `r${index}`);
  if (
    Object.keys(rawSelections).length !== expectedRowKeys.length ||
    Object.keys(rawSelections).some((key) => !expectedRowKeys.includes(key))
  )
    return rejectAll(groups, 'unknown-row-key');

  const selections: VariantSelectorSelection[] = [];
  const failures: VariantSelectorFailureCode[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const selected = rawSelections[`r${groupIndex}`];
    if (selected === null) continue;
    if (typeof selected !== 'string' || !/^v(?:0|[1-9]\d*)$/u.test(selected)) {
      failures.push('unknown-variant-key');
      continue;
    }
    const variants = enumerateRoleVariants(group);
    const variant = variants?.[Number(selected.slice(1))];
    if (variant === undefined) {
      failures.push('unknown-variant-key');
      continue;
    }
    selections.push({ rowKey: `r${groupIndex}`, variantKey: selected });
  }
  const accepted = new Set(selections.map((selection) => selection.rowKey));
  return {
    selections,
    rejectedGroups: groups.filter((_, index) => !accepted.has(`r${index}`)),
    malformedEnvelope: false,
    failures,
  };
}

/** Deterministically projects exact source fields; ambiguity remains explicit review work. */
export function projectVariantSourceFields(
  variant: GeometryCandidateWindowRow,
): VariantSourceProjection | null {
  const sourceRow: GeometryRow = {
    id: variant.rowId,
    status: 'resolved',
    pageIndex: variant.context.pageIndex,
    tableId: variant.context.tableId,
    sectionId: variant.context.sectionId,
    specimenKey: variant.context.specimenKey,
    collectionDateKey: variant.context.collectionDateKey,
    seededByTableStructure: variant.context.tableId !== null,
    sourceObservationIds: [...variant.sourceObservationIds],
    parentIds: [...new Set(variant.sourceCells.map((cell) => cell.parentId))],
    yBandCount: 1,
    cells: variant.sourceCells,
  };
  const roles = enumerateGeometryFieldCandidates(sourceRow).roles;
  const fields = variant.provisionalSourceFields;
  const roleFields = {
    label: fields.label,
    value: fields.value,
    unit: fields.unit,
    reference: fields.referenceInterval,
    flag: fields.flag,
  } as const;
  for (const [role, selectedField] of Object.entries(roleFields) as readonly [
    keyof typeof roleFields,
    string | null,
  ][]) {
    if (role === 'value' && selectedField !== variant.anchorCellId) return null;
    if (
      selectedField !== null &&
      !roles[role].candidates.some((candidate) => candidate.cellId === selectedField)
    )
      return null;
  }
  const ambiguous = new Set(variant.ambiguousSourceRoles);
  if (
    variant.ambiguousSourceRoles.some((role) => role === 'value') ||
    (['label', 'unit', 'reference', 'flag'] as const).some(
      (role) => roles[role].resolution === 'ambiguous' && !ambiguous.has(role),
    )
  )
    return null;
  const selected = Object.values(fields).filter((value): value is string => value !== null);
  return new Set(selected).size === selected.length
    ? {
        sourceFields: fields,
        ambiguousSourceRoles: [...variant.ambiguousSourceRoles],
      }
    : null;
}

function compareGroups(
  left: GeometryCandidateWindowGroup,
  right: GeometryCandidateWindowGroup,
): number {
  return (
    left.context.pageIndex - right.context.pageIndex ||
    left.observations[0]!.boundingBox.y - right.observations[0]!.boundingBox.y ||
    left.observations[0]!.boundingBox.x - right.observations[0]!.boundingBox.x ||
    left.physicalRowId.localeCompare(right.physicalRowId)
  );
}

export function planVariantSelectorBlocks(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  locale: string,
  blockSize: VariantSelectorSize,
): VariantSelectorPlan {
  if (![2, 8, 16].includes(blockSize)) fail('variant-selector-input');
  const blocks: GeometryCandidateWindowGroup[][] = [];
  const rejectedGroups: GeometryCandidateWindowGroup[] = [];
  let current: GeometryCandidateWindowGroup[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  const fits = (candidate: readonly GeometryCandidateWindowGroup[]): boolean => {
    try {
      const candidateHeadings = headings.filter(
        (heading) => heading.pageIndex === candidate[0]!.context.pageIndex,
      );
      const serialized = serializeVariantSelectorChunk(
        candidate,
        candidateHeadings,
        locale,
        blockSize,
      );
      createVariantSelectorPrompt(locale, serialized, blockSize);
      return true;
    } catch {
      return false;
    }
  };
  for (const group of [...groups].sort(compareGroups)) {
    try {
      validateGroup(group);
    } catch {
      flush();
      rejectedGroups.push(group);
      continue;
    }
    if (current.length > 0) {
      const proposed = [...current, group];
      if (
        current.length >= blockSize ||
        !sameContext(current[0]!.context, group.context) ||
        !fits(proposed)
      )
        flush();
    }
    if (!fits([group])) rejectedGroups.push(group);
    else current.push(group);
  }
  flush();
  return { blocks, rejectedGroups };
}
