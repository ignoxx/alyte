import {
  enumerateGeometryFieldCandidates,
  isGeometryCandidateLabelText,
  type ExtractionSemanticFieldSelection,
  type ExtractionSemanticProposal,
  type GeometryCandidateContext,
  type GeometryCandidateWindowGroup,
  type GeometryCandidateWindowRow,
  type GeometryRow,
  type VisionTextObservation,
} from '@alyte/domain';

/** Production adapter versions. Keep these independent from the evaluation script. */
export const GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION =
  'alyte.geometry-variant-selector.v2' as const;
export const GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION =
  'alyte.geometry-variant-selector.chunk.v2' as const;
export const GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION =
  'alyte.geometry-variant-selector.prompt.v3' as const;

export const VARIANT_SELECTOR_SCHEMA_VERSION = GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION;
export const VARIANT_SELECTOR_CHUNK_VERSION = GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION;
export const VARIANT_SELECTOR_PROMPT_VERSION = GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION;

export const GEOMETRY_VARIANT_SELECTOR_LIMITS = Object.freeze({
  maxGroups: 2,
  maxGroupCells: 24,
  maxVariantCells: 6,
  maxVariantsPerGroup: 24,
  maxHeadings: 4,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxInputBytes: 24 * 1024,
  maxPromptBytes: 24 * 1024,
  maxOutputBytes: 8 * 1024,
  contextTokens: 2_048,
  outputTokens: 96,
  productionContextTokens: 2_048,
  productionOutputTokens: 96,
  reservedOutputTokens: 96,
});
export const VARIANT_SELECTOR_LIMITS = GEOMETRY_VARIANT_SELECTOR_LIMITS;

export const GEOMETRY_VARIANT_SELECTOR_CONTEXT = Object.freeze({
  version: 'alyte.geometry-variant-selector.context.v2',
  maxTokens: 2_048,
  reservedOutputTokens: 96,
  maxPromptTokens: 2_048 - 96,
});

export type GeometryVariantSelectorSize = 2;
export type VariantSelectorSize = GeometryVariantSelectorSize;

export type GeometryVariantSelectorSelection = {
  readonly rowKey: string;
  readonly variantKey: string;
};

export type GeometryRoleVariantProjection = {
  readonly sourceFields: ExtractionSemanticFieldSelection;
  readonly ambiguousSourceRoles: readonly ('label' | 'unit' | 'reference' | 'flag')[];
};

export type GeometryVariantSelectorFailureCode =
  | 'invalid-input'
  | 'malformed-envelope'
  | 'oversized-output'
  | 'unknown-row-key'
  | 'unknown-variant-key'
  | 'unprojectable-variant';

export type GeometryVariantSelectorValidation = {
  /** Accepted source-free keys, retained for diagnostics/retry routing only. */
  readonly selections: readonly GeometryVariantSelectorSelection[];
  /** Local, deterministic proposals expanded from accepted keys. */
  readonly proposals: readonly ExtractionSemanticProposal[];
  /** Sensitive source-bearing inputs for a device-local retry only; never log or aggregate. */
  readonly rejectedGroups: readonly GeometryCandidateWindowGroup[];
  readonly malformedEnvelope: boolean;
  readonly failures: readonly GeometryVariantSelectorFailureCode[];
};

export const geometryVariantSelectorContractMetadata = Object.freeze({
  schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
  promptVersion: GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION,
  chunkVersion: GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
  limits: GEOMETRY_VARIANT_SELECTOR_LIMITS,
  context: GEOMETRY_VARIANT_SELECTOR_CONTEXT,
});
export const localGeometryVariantContractMetadata = geometryVariantSelectorContractMetadata;

function fail(code: string): never {
  throw new Error(`geometry-variant-selector-${code}`);
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contextKey(context: GeometryCandidateContext): string {
  return JSON.stringify([
    context.pageIndex,
    context.tableId,
    context.sectionId,
    context.specimenKey,
    context.collectionDateKey,
  ]);
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

function opaqueCandidateId(sourceKey: string, prefix: 'pr-' | 'gw-' = 'gw-'): string {
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

function validateObservation(observation: VisionTextObservation): void {
  if (
    typeof observation.id !== 'string' ||
    observation.id.length === 0 ||
    observation.id.length > 96 ||
    typeof observation.text !== 'string' ||
    observation.text.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxObservationTextCharacters ||
    !Array.isArray(observation.alternatives) ||
    observation.alternatives.some(
      (alternative) =>
        typeof alternative !== 'string' ||
        alternative.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxAlternativeCharacters,
    ) ||
    !Number.isFinite(observation.boundingBox.x) ||
    !Number.isFinite(observation.boundingBox.y) ||
    !Number.isFinite(observation.boundingBox.width) ||
    !Number.isFinite(observation.boundingBox.height) ||
    observation.boundingBox.width <= 0 ||
    observation.boundingBox.height <= 0
  )
    fail('input-invalid');
}

function validateGroup(group: GeometryCandidateWindowGroup): void {
  const expectedPhysicalRowKey = JSON.stringify([
    'physical-row',
    group.physicalRowCells,
    contextKey(group.context),
  ]);
  const physicalCellIds = new Set<string>();
  for (const cell of group.physicalRowCells) {
    if (
      typeof cell.id !== 'string' ||
      cell.id.length === 0 ||
      cell.id.length > 96 ||
      typeof cell.parentId !== 'string' ||
      cell.parentId.length === 0 ||
      typeof cell.sourceObservationId !== 'string' ||
      cell.sourceObservationId.length === 0 ||
      !Number.isSafeInteger(cell.sourceStart) ||
      cell.sourceStart < 0 ||
      !Number.isSafeInteger(cell.sourceEnd) ||
      cell.sourceEnd <= cell.sourceStart ||
      typeof cell.text !== 'string' ||
      cell.text.length === 0 ||
      !Number.isFinite(cell.boundingBox.x) ||
      !Number.isFinite(cell.boundingBox.y) ||
      !Number.isFinite(cell.boundingBox.width) ||
      !Number.isFinite(cell.boundingBox.height) ||
      cell.boundingBox.width <= 0 ||
      cell.boundingBox.height <= 0 ||
      physicalCellIds.has(cell.id)
    )
      fail('input-invalid');
    physicalCellIds.add(cell.id);
  }
  if (
    group.withinInputBounds !== true ||
    typeof group.rowId !== 'string' ||
    group.rowId.length === 0 ||
    group.physicalRowId !== group.rowId ||
    typeof group.physicalRowId !== 'string' ||
    group.physicalRowId.length === 0 ||
    typeof group.physicalRowKey !== 'string' ||
    group.physicalRowKey.length === 0 ||
    group.physicalRowKey !== expectedPhysicalRowKey ||
    opaqueCandidateId(expectedPhysicalRowKey, 'pr-') !== group.physicalRowId ||
    group.physicalRowCells.length === 0 ||
    group.physicalRowCells.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroupCells ||
    group.observations.length === 0 ||
    group.observations.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroupCells ||
    group.observations.length !== group.sourceObservationIds.length ||
    group.variants.length === 0 ||
    group.variants.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxVariantsPerGroup ||
    group.anchorCellIds.length !== group.variants.length ||
    group.anchorKinds.length !== group.variants.length ||
    new Set(group.anchorCellIds).size !== group.anchorCellIds.length ||
    new Set(group.sourceObservationIds).size !== group.sourceObservationIds.length
  )
    fail('input-invalid');

  group.observations.forEach((observation, index) => {
    validateObservation(observation);
    if (observation.id !== group.sourceObservationIds[index]) fail('input-invalid');
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
    fail('input-invalid');

  const variantIds = new Set<string>();
  for (const [index, variant] of group.variants.entries()) {
    const provisionalFields = variant.provisionalSourceFields;
    const ambiguousRoles = variant.ambiguousSourceRoles;
    const selectedFieldIds = Object.values(provisionalFields).filter(
      (value): value is string => typeof value === 'string',
    );
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
      ) !== variant.rowId ||
      variant.sourceCells.length === 0 ||
      variant.sourceCells.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxVariantCells ||
      variant.sourceCells.length !== variant.observations.length ||
      variant.sourceObservationIds.length !== variant.observations.length ||
      new Set(variant.sourceObservationIds).size !== variant.sourceObservationIds.length ||
      !variant.sourceObservationIds.includes(variant.anchorCellId) ||
      typeof provisionalFields !== 'object' ||
      provisionalFields === null ||
      typeof provisionalFields.label !== 'string' ||
      typeof provisionalFields.value !== 'string' ||
      provisionalFields.value !== variant.anchorCellId ||
      ![provisionalFields.unit, provisionalFields.referenceInterval, provisionalFields.flag].every(
        (value) => value === null || typeof value === 'string',
      ) ||
      Object.keys(provisionalFields).some(
        (key) => !['label', 'value', 'unit', 'referenceInterval', 'flag'].includes(key),
      ) ||
      Object.keys(provisionalFields).length !== 5 ||
      selectedFieldIds.length < 2 ||
      new Set(selectedFieldIds).size !== selectedFieldIds.length ||
      selectedFieldIds.some((id) => !variant.sourceObservationIds.includes(id)) ||
      !Array.isArray(ambiguousRoles) ||
      new Set(ambiguousRoles).size !== ambiguousRoles.length ||
      ambiguousRoles.some((role) => !['label', 'unit', 'reference', 'flag'].includes(role))
    )
      fail('input-invalid');
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
        fail('input-invalid');
    });
    if (projectVariantSourceFields(variant) === null) fail('input-invalid');
  }
  if (enumerateGeometryRoleVariants(group) === null) fail('input-invalid');
}

function validateInput(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  locale: string,
): void {
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    groups.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroups ||
    !Array.isArray(headings) ||
    headings.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxHeadings ||
    typeof locale !== 'string' ||
    locale.length === 0 ||
    locale.length > 32
  )
    fail('input-invalid');
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
      fail('input-invalid');
    groupIds.add(group.rowId);
    physicalRowIds.add(group.physicalRowId);
    for (const sourceId of group.sourceObservationIds) {
      if (sourceIds.has(sourceId)) fail('input-invalid');
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
      fail('input-invalid');
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

/** Enumerates exact local role assignments without opening a model-authored field channel. */
export function enumerateGeometryRoleVariants(
  group: GeometryCandidateWindowGroup,
): readonly GeometryRoleVariantProjection[] | null {
  const cellById = new Map(group.sourceCells.map((cell) => [cell.id, cell]));
  const result: GeometryRoleVariantProjection[] = [];
  const seen = new Set<string>();
  for (const anchorVariant of group.variants) {
    const baseFields = projectGeometryVariantSourceFields(anchorVariant);
    const anchor = cellById.get(anchorVariant.anchorCellId);
    if (baseFields === null || anchor === undefined) return null;
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
      const sourceFields = { ...baseFields, label: label.id };
      const selected = Object.values(sourceFields).filter(
        (value): value is string => value !== null,
      );
      if (new Set(selected).size !== selected.length || selected.some((id) => !cellById.has(id)))
        continue;
      const key = JSON.stringify(sourceFields);
      if (seen.has(key)) continue;
      seen.add(key);
      const ambiguousSourceRoles = anchorVariant.ambiguousSourceRoles.filter(
        (role): role is 'label' | 'unit' | 'reference' | 'flag' => role !== 'value',
      );
      result.push({
        sourceFields,
        ambiguousSourceRoles,
      });
      if (result.length > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxVariantsPerGroup) return null;
    }
  }
  return result.length === 0 ? null : result;
}

/** Exact evaluator wire: request-local keys only; durable identities stay on-device. */
export function serializeGeometryVariantSelectorChunk(
  groups: readonly GeometryCandidateWindowGroup[],
  headings: readonly VisionTextObservation[],
  locale: string,
  blockSize: GeometryVariantSelectorSize = 2,
): string {
  if (blockSize !== 2) fail('input-invalid');
  validateInput(groups, headings, locale);
  const value = JSON.stringify({
    v: GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
    l: locale,
    a: [2, false],
    r: groups.map((group, groupIndex) => {
      const variants = enumerateGeometryRoleVariants(group);
      if (variants === null) fail('input-invalid');
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
  if (new TextEncoder().encode(value).byteLength > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxInputBytes)
    fail('input-too-large');
  return value;
}

export const serializeVariantSelectorChunk = serializeGeometryVariantSelectorChunk;

/** Conservative byte fallback used before native tokenization is available at this seam. */
export function estimateGeometryVariantSelectorTokens(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export const estimateVariantSelectorTokens = estimateGeometryVariantSelectorTokens;

export function variantSelectorPromptBudget(
  prompt: string,
  blockSize: GeometryVariantSelectorSize = 2,
) {
  if (blockSize !== 2) fail('input-invalid');
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  const promptTokens = estimateGeometryVariantSelectorTokens(prompt);
  return {
    promptBytes,
    promptTokens,
    productionContextFits:
      promptBytes <= GEOMETRY_VARIANT_SELECTOR_LIMITS.maxPromptBytes &&
      promptTokens + GEOMETRY_VARIANT_SELECTOR_LIMITS.reservedOutputTokens <=
        GEOMETRY_VARIANT_SELECTOR_LIMITS.contextTokens,
    productionPlausible:
      promptBytes <= GEOMETRY_VARIANT_SELECTOR_LIMITS.maxPromptBytes &&
      promptTokens + GEOMETRY_VARIANT_SELECTOR_LIMITS.reservedOutputTokens <=
        GEOMETRY_VARIANT_SELECTOR_LIMITS.contextTokens,
  } as const;
}

/** Exact plain prompt used by the evaluated selector. */
export function createGeometryVariantSelectorPrompt(
  locale: string,
  serializedChunk: string,
  blockSize: GeometryVariantSelectorSize = 2,
): string {
  if (typeof locale !== 'string' || typeof serializedChunk !== 'string' || blockSize !== 2)
    fail('input-invalid');
  const prompt = `Choose one existing source-linked field-role variant only when the row clearly contains an analyte or biomarker label and that patient's measured result. A number alone is not a measurement. Return null for dates, identifiers, administrative text, addresses, headings, codes, reference-only rows, and anything ambiguous or not clearly a measured laboratory result. Prefer null over guessing. Return every rN exactly once. Use only that row's vN keys. Headings are read-only. Never output text, values, units, mappings, explanations, confidence, or extra fields. Wire: r row [rowKey,cells,variants]; cell [cN,text,alternatives,x,y,width,height]; variant [vN,labelCellKey,valueCellKey,unitCellKey|null,referenceCellKey|null,flagCellKey|null].\nSchema ${GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION}; locale ${locale}; block ${serializedChunk}\nJSON only.`;
  const budget = variantSelectorPromptBudget(prompt, blockSize);
  if (
    !budget.productionContextFits ||
    budget.promptBytes > GEOMETRY_VARIANT_SELECTOR_LIMITS.maxPromptBytes
  )
    fail('prompt-too-large');
  return prompt;
}
export const createVariantSelectorPrompt = createGeometryVariantSelectorPrompt;

/** One bounded retry; it still has no source-bearing identity or model-authored field channel. */
export function createGeometryVariantSelectorRetryPrompt(
  locale: string,
  serializedChunk: string,
  blockSize: GeometryVariantSelectorSize = 2,
): string {
  // Retry the exact evaluated contract. A different instruction would be a new prompt bundle and
  // would need its own private benchmark before production use.
  return createGeometryVariantSelectorPrompt(locale, serializedChunk, blockSize);
}
export const createVariantSelectorRetryPrompt = createGeometryVariantSelectorRetryPrompt;

/** Deterministically projects exact source fields; ambiguity remains visible review work. */
export function projectGeometryVariantSourceFields(
  variant: GeometryCandidateWindowRow,
): ExtractionSemanticFieldSelection | null {
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
  return new Set(selected).size === selected.length ? fields : null;
}
export const projectVariantSourceFields = projectGeometryVariantSourceFields;

function rejectAll(
  groups: readonly GeometryCandidateWindowGroup[],
  code: GeometryVariantSelectorFailureCode,
): GeometryVariantSelectorValidation {
  return {
    selections: [],
    proposals: [],
    rejectedGroups: groups,
    malformedEnvelope: true,
    failures: [code],
  };
}

/**
 * Accepts only the source-free `{schemaVersion,selections:{rN:vN|null}}` envelope. Every accepted
 * key is resolved against the already validated in-memory group; the provider cannot supply any
 * source ID, value, unit, mapping, or other semantic field.
 */
export function validateGeometryVariantSelectorOutputWithState(
  raw: unknown,
  groups: readonly GeometryCandidateWindowGroup[],
): GeometryVariantSelectorValidation {
  try {
    validateInput(groups, [], 'en-US');
  } catch {
    return rejectAll(groups, 'invalid-input');
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      GEOMETRY_VARIANT_SELECTOR_LIMITS.maxOutputBytes
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
    root.schemaVersion !== GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION ||
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

  const selections: GeometryVariantSelectorSelection[] = [];
  const proposals: ExtractionSemanticProposal[] = [];
  const failures: GeometryVariantSelectorFailureCode[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const selected = rawSelections[`r${groupIndex}`];
    if (selected === null) continue;
    if (typeof selected !== 'string' || !/^v(?:0|[1-9]\d*)$/u.test(selected)) {
      failures.push('unknown-variant-key');
      continue;
    }
    const variant = enumerateGeometryRoleVariants(group)?.[Number(selected.slice(1))];
    if (variant === undefined) {
      failures.push('unknown-variant-key');
      continue;
    }
    selections.push({ rowKey: `r${groupIndex}`, variantKey: selected });
    proposals.push({
      sourceObservationIds: [...group.sourceObservationIds],
      sourceFields: { ...variant.sourceFields },
      proposedBiomarkerId: null,
      role: 'preserve',
    });
  }
  const accepted = new Set(selections.map((selection) => selection.rowKey));
  return {
    selections,
    proposals,
    rejectedGroups: groups.filter((_, index) => !accepted.has(`r${index}`)),
    malformedEnvelope: false,
    failures,
  };
}

export const validateVariantSelectorOutputWithState =
  validateGeometryVariantSelectorOutputWithState;

export function validateGeometryVariantSelectorOutput(
  raw: unknown,
  groups: readonly GeometryCandidateWindowGroup[],
): readonly ExtractionSemanticProposal[] {
  return validateGeometryVariantSelectorOutputWithState(raw, groups).proposals;
}
