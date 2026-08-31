import {
  sortExtractionSemanticCandidateRows,
  type ExtractionSemanticCandidateRow,
  type ExtractionSemanticFieldSelection,
  type VisionTextObservation,
} from '@alyte/domain';

export const BLOCK_SELECTOR_SCHEMA_VERSION = 'alyte.block-source-selector.v1' as const;
export const BLOCK_SELECTOR_CHUNK_VERSION = 'alyte.block-source-selector.chunk.v1' as const;
export const BLOCK_SELECTOR_PROMPT_VERSION = 'alyte.block-source-selector.prompt.v1' as const;

export type BlockSelectorSize = 2 | 8 | 16;
export type BlockSelectorValueAuthority = ReadonlyMap<string, readonly string[]>;

export const BLOCK_SELECTOR_LIMITS = Object.freeze({
  maxRows: 16,
  maxObservations: 128,
  maxHeadings: 4,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxInputBytes: 24 * 1024,
  maxPromptBytes: 24 * 1024,
  maxOutputBytes: 24 * 1024,
  diagnosticContextTokens: 8_192,
  diagnosticOutputTokens: 1_024,
  productionContextTokens: 2_048,
  productionOutputTokens: 192,
});

const OUTPUT_FIELDS = Object.freeze([
  'labelKey',
  'valueKey',
  'unitKey',
  'referenceIntervalKey',
  'flagKey',
] as const);
const HEADING_CELL_KEY = Symbol('heading-cell-key');

export type BlockSelectorSelection = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly sourceFields: ExtractionSemanticFieldSelection;
};

export type BlockSelectorFailureCode =
  | 'invalid-input'
  | 'malformed-envelope'
  | 'oversized-output'
  | 'invalid-selection'
  | 'unknown-row-key'
  | 'unknown-cell-key'
  | 'heading-cell-key'
  | 'value-outside-authority'
  | 'duplicate-cell'
  | 'duplicate-row';

export type BlockSelectorValidation = {
  readonly selections: readonly BlockSelectorSelection[];
  readonly rejectedRows: readonly ExtractionSemanticCandidateRow[];
  readonly malformedEnvelope: boolean;
  readonly failures: readonly BlockSelectorFailureCode[];
};

export type BlockSelectorPlan = {
  readonly blocks: readonly (readonly ExtractionSemanticCandidateRow[])[];
  readonly rejectedRows: readonly ExtractionSemanticCandidateRow[];
};

function fail(code: string): never {
  throw new Error(`model-evaluation-failed:${code}`);
}

function contextFor(row: ExtractionSemanticCandidateRow): {
  readonly pageIndex: number;
  readonly tableId: string | null;
} {
  const first = row.observations[0];
  if (first === undefined) fail('block-selector-input');
  const pageIndex = first.pageIndex;
  const tableId = first.structure?.tableId ?? null;
  if (
    row.observations.some(
      (observation) =>
        observation.pageIndex !== pageIndex || (observation.structure?.tableId ?? null) !== tableId,
    )
  )
    fail('block-selector-context');
  return { pageIndex, tableId };
}

function sameContext(
  left: ExtractionSemanticCandidateRow,
  right: ExtractionSemanticCandidateRow,
): boolean {
  const leftContext = contextFor(left);
  const rightContext = contextFor(right);
  return (
    leftContext.pageIndex === rightContext.pageIndex && leftContext.tableId === rightContext.tableId
  );
}

function validateBlockInput(
  rows: readonly ExtractionSemanticCandidateRow[],
  headings: readonly VisionTextObservation[],
  blockSize: BlockSelectorSize,
): void {
  if (![2, 8, 16].includes(blockSize) || rows.length === 0 || rows.length > blockSize)
    fail('block-selector-input');
  if (
    rows.length > BLOCK_SELECTOR_LIMITS.maxRows ||
    headings.length > BLOCK_SELECTOR_LIMITS.maxHeadings
  )
    fail('block-selector-input');
  const first = rows[0]!;
  const context = contextFor(first);
  if (rows.some((row) => !sameContext(first, row))) fail('block-selector-context');
  const rowIds = new Set<string>();
  const sourceIds = new Set<string>();
  let observationCount = 0;
  for (const row of rows) {
    if (
      row.rowId.length === 0 ||
      row.rowId.length > 96 ||
      rowIds.has(row.rowId) ||
      row.observations.length === 0 ||
      row.observations.length !== row.sourceObservationIds.length
    )
      fail('block-selector-input');
    rowIds.add(row.rowId);
    observationCount += row.observations.length;
    row.observations.forEach((observation, index) => {
      const sourceId = row.sourceObservationIds[index];
      if (
        sourceId === undefined ||
        sourceId !== observation.id ||
        sourceIds.has(sourceId) ||
        observation.text.length > BLOCK_SELECTOR_LIMITS.maxObservationTextCharacters ||
        observation.alternatives.some(
          (alternative) => alternative.length > BLOCK_SELECTOR_LIMITS.maxAlternativeCharacters,
        )
      )
        fail('block-selector-input');
      sourceIds.add(sourceId);
    });
  }
  if (observationCount > BLOCK_SELECTOR_LIMITS.maxObservations) fail('block-selector-input');
  const headingIds = new Set<string>();
  for (const heading of headings) {
    if (
      heading.id.length === 0 ||
      headingIds.has(heading.id) ||
      sourceIds.has(heading.id) ||
      heading.pageIndex !== context.pageIndex ||
      heading.text.length > BLOCK_SELECTOR_LIMITS.maxObservationTextCharacters ||
      heading.alternatives.some(
        (alternative) => alternative.length > BLOCK_SELECTOR_LIMITS.maxAlternativeCharacters,
      )
    )
      fail('block-selector-input');
    headingIds.add(heading.id);
  }
}

function validateValueAuthority(
  rows: readonly ExtractionSemanticCandidateRow[],
  authority: BlockSelectorValueAuthority,
): void {
  if (authority.size !== rows.length) fail('block-selector-authority');
  for (const row of rows) {
    const allowed = authority.get(row.rowId);
    if (
      allowed === undefined ||
      allowed.length === 0 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some((sourceId) => !row.sourceObservationIds.includes(sourceId))
    )
      fail('block-selector-authority');
  }
}

function bucket(value: number): number {
  if (!Number.isFinite(value)) fail('block-selector-input');
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

/** Serializes source text with compact request-local keys; durable source IDs never leave JS. */
export function serializeBlockSelectorChunk(
  rows: readonly ExtractionSemanticCandidateRow[],
  headings: readonly VisionTextObservation[],
  locale: string,
  blockSize: BlockSelectorSize,
): string {
  validateBlockInput(rows, headings, blockSize);
  const value = JSON.stringify({
    v: BLOCK_SELECTOR_CHUNK_VERSION,
    l: locale,
    a: [blockSize, blockSize !== 2],
    r: rows.map((row, rowIndex) => [
      `r${rowIndex}`,
      row.observations.map((observation, cellIndex) =>
        wireObservation(observation, `c${cellIndex}`),
      ),
    ]),
    h: headings.map((heading, index) => wireObservation(heading, `h${index}`)),
  });
  if (new TextEncoder().encode(value).byteLength > BLOCK_SELECTOR_LIMITS.maxInputBytes)
    fail('block-selector-input');
  return value;
}

/** Hard byte-fallback upper bound plus a lexical diagnostic; never claims tokenizer equivalence. */
export function estimateBlockSelectorTokens(input: string): number {
  const lexical = (input.match(/[A-Za-z0-9]+|\s+|[^A-Za-z0-9\s]+/gu) ?? []).reduce(
    (total, segment) => {
      if (/^[A-Za-z0-9]+$/u.test(segment))
        return total + Math.max(1, Math.ceil(segment.length / 6));
      if (/^\s+$/u.test(segment)) return total + 1;
      return total + Math.max(1, Math.ceil([...segment].length / 5));
    },
    0,
  );
  return Math.max(lexical, new TextEncoder().encode(input).byteLength);
}

export function blockSelectorPromptBudget(prompt: string, blockSize: BlockSelectorSize) {
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  const promptTokens = estimateBlockSelectorTokens(prompt);
  const diagnosticFits =
    promptBytes <= BLOCK_SELECTOR_LIMITS.maxPromptBytes &&
    promptTokens + BLOCK_SELECTOR_LIMITS.diagnosticOutputTokens <=
      BLOCK_SELECTOR_LIMITS.diagnosticContextTokens;
  const productionContextFits =
    promptTokens + BLOCK_SELECTOR_LIMITS.productionOutputTokens <=
    BLOCK_SELECTOR_LIMITS.productionContextTokens;
  return {
    promptBytes,
    promptTokens,
    diagnosticFits,
    productionContextFits,
    productionPlausible: blockSize === 2 && productionContextFits,
  } as const;
}

export function createBlockSelectorPrompt(
  locale: string,
  serializedChunk: string,
  blockSize: BlockSelectorSize,
): string {
  if (![2, 8, 16].includes(blockSize)) fail('block-selector-input');
  const prompt = `Select exact source cells from ordered lab rows. Headings are read-only and cannot be selected. Return every input rN key exactly once in selections; use null to omit a row. For a measurement select distinct row-local cN keys for label and complete result; add unit, range, and flag when present. Omit ambiguous or non-measurement rows. Output no source text, IDs, values, mappings, explanations, or extra fields. Wire: v version, l locale, a [size,diagnostic], r rows [rowKey,cells], h headings; cell [cellKey,text,alternatives,x,y,width,height].\nSchema ${BLOCK_SELECTOR_SCHEMA_VERSION}; locale ${locale}; block ${serializedChunk}\nJSON only.`;
  const budget = blockSelectorPromptBudget(prompt, blockSize);
  if (!budget.diagnosticFits || (blockSize === 2 && !budget.productionContextFits))
    fail('block-selector-prompt');
  return prompt;
}

function rowSchema(cellCount: number, allowedValueKeys: readonly string[]) {
  const cellKeys = Array.from({ length: cellCount }, (_, index) => `c${index}`);
  return {
    type: 'object',
    additionalProperties: false,
    required: [...OUTPUT_FIELDS],
    properties: {
      labelKey: { enum: cellKeys },
      valueKey: { enum: allowedValueKeys },
      unitKey: { enum: [null, ...cellKeys] },
      referenceIntervalKey: { enum: [null, ...cellKeys] },
      flagKey: { enum: [null, ...cellKeys] },
    },
  } as const;
}

export function createBlockSelectorFormat(
  rows: readonly ExtractionSemanticCandidateRow[],
  headings: readonly VisionTextObservation[],
  blockSize: BlockSelectorSize,
  valueAuthority: BlockSelectorValueAuthority,
): Readonly<Record<string, unknown>> {
  validateBlockInput(rows, headings, blockSize);
  validateValueAuthority(rows, valueAuthority);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'selections'],
    properties: {
      schemaVersion: { const: BLOCK_SELECTOR_SCHEMA_VERSION },
      selections: {
        type: 'object',
        additionalProperties: false,
        required: rows.map((_, index) => `r${index}`),
        properties: Object.fromEntries(
          rows.map((row, index) => [
            `r${index}`,
            {
              anyOf: [
                { type: 'null' },
                rowSchema(
                  row.observations.length,
                  row.sourceObservationIds.flatMap((sourceId, cellIndex) =>
                    valueAuthority.get(row.rowId)!.includes(sourceId) ? [`c${cellIndex}`] : [],
                  ),
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
  rows: readonly ExtractionSemanticCandidateRow[],
  code: BlockSelectorFailureCode,
): BlockSelectorValidation {
  return {
    selections: [],
    rejectedRows: rows,
    malformedEnvelope: true,
    failures: [code],
  };
}

export function validateBlockSelectorOutput(
  raw: unknown,
  rows: readonly ExtractionSemanticCandidateRow[],
  valueAuthority: BlockSelectorValueAuthority,
): BlockSelectorValidation {
  try {
    const inferredBlockSize: BlockSelectorSize = rows.length <= 2 ? 2 : rows.length <= 8 ? 8 : 16;
    validateBlockInput(rows, [], inferredBlockSize);
    validateValueAuthority(rows, valueAuthority);
  } catch {
    return rejectAll(rows, 'invalid-input');
  }
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (encoded > BLOCK_SELECTOR_LIMITS.maxOutputBytes) return rejectAll(rows, 'oversized-output');
  } catch {
    return rejectAll(rows, 'malformed-envelope');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return rejectAll(rows, 'malformed-envelope');
  const root = raw as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => !['schemaVersion', 'selections'].includes(key)) ||
    root.schemaVersion !== BLOCK_SELECTOR_SCHEMA_VERSION ||
    typeof root.selections !== 'object' ||
    root.selections === null ||
    Array.isArray(root.selections)
  )
    return rejectAll(rows, 'malformed-envelope');

  const rawSelections = root.selections as Record<string, unknown>;
  const expectedRowKeys = rows.map((_, index) => `r${index}`);
  if (
    Object.keys(rawSelections).length !== expectedRowKeys.length ||
    Object.keys(rawSelections).some((key) => !expectedRowKeys.includes(key))
  )
    return rejectAll(rows, 'malformed-envelope');

  const selections: BlockSelectorSelection[] = [];
  const failures: BlockSelectorFailureCode[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const rowKey = `r${rowIndex}`;
    const item = rawSelections[rowKey];
    if (item === null) continue;
    if (typeof item !== 'object' || item === undefined || Array.isArray(item)) {
      failures.push('invalid-selection');
      continue;
    }
    const value = item as Record<string, unknown>;
    if (
      Object.keys(value).length !== OUTPUT_FIELDS.length ||
      Object.keys(value).some(
        (key) => !OUTPUT_FIELDS.includes(key as (typeof OUTPUT_FIELDS)[number]),
      )
    ) {
      failures.push('invalid-selection');
      continue;
    }
    const sourceId = (
      key: unknown,
      required: boolean,
    ): string | null | undefined | typeof HEADING_CELL_KEY => {
      if (key === null) return required ? undefined : null;
      if (typeof key !== 'string') return undefined;
      if (/^h(?:0|[1-9]\d*)$/u.test(key)) return HEADING_CELL_KEY;
      if (!/^c(?:0|[1-9]\d*)$/u.test(key)) return undefined;
      return row.sourceObservationIds[Number(key.slice(1))];
    };
    const label = sourceId(value.labelKey, true);
    const selectedValue = sourceId(value.valueKey, true);
    const unit = sourceId(value.unitKey, false);
    const referenceInterval = sourceId(value.referenceIntervalKey, false);
    const flag = sourceId(value.flagKey, false);
    if ([label, selectedValue, unit, referenceInterval, flag].includes(HEADING_CELL_KEY)) {
      failures.push('heading-cell-key');
      continue;
    }
    if (
      label === undefined ||
      selectedValue === undefined ||
      unit === undefined ||
      referenceInterval === undefined ||
      flag === undefined ||
      typeof label !== 'string' ||
      typeof selectedValue !== 'string'
    ) {
      failures.push('unknown-cell-key');
      continue;
    }
    if (!valueAuthority.get(row.rowId)!.includes(selectedValue)) {
      failures.push('value-outside-authority');
      continue;
    }
    const selected = [label, selectedValue, unit, referenceInterval, flag].filter(
      (id): id is string => id !== null,
    );
    if (new Set(selected).size !== selected.length) {
      failures.push('duplicate-cell');
      continue;
    }
    selections.push({
      rowId: row.rowId,
      sourceObservationIds: [...row.sourceObservationIds],
      sourceFields: { label, value: selectedValue, unit, referenceInterval, flag },
    });
  }
  const acceptedRows = new Set(selections.map((selection) => selection.rowId));
  return {
    selections,
    rejectedRows: rows.filter((row) => !acceptedRows.has(row.rowId)),
    malformedEnvelope: false,
    failures,
  };
}

/** Plans physically ordered, context-local blocks; an oversized row remains explicit review work. */
export function planBlockSelectorBlocks(
  rows: readonly ExtractionSemanticCandidateRow[],
  blockSize: BlockSelectorSize,
): BlockSelectorPlan {
  if (![2, 8, 16].includes(blockSize)) fail('block-selector-input');
  const ordered = sortExtractionSemanticCandidateRows(rows);
  const blocks: ExtractionSemanticCandidateRow[][] = [];
  const rejectedRows: ExtractionSemanticCandidateRow[] = [];
  let current: ExtractionSemanticCandidateRow[] = [];
  let observationCount = 0;
  const flush = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
    observationCount = 0;
  };
  for (const row of ordered) {
    try {
      contextFor(row);
    } catch {
      flush();
      rejectedRows.push(row);
      continue;
    }
    if (row.observations.length > BLOCK_SELECTOR_LIMITS.maxObservations) {
      flush();
      rejectedRows.push(row);
      continue;
    }
    if (
      current.length > 0 &&
      (current.length >= blockSize ||
        observationCount + row.observations.length > BLOCK_SELECTOR_LIMITS.maxObservations ||
        !sameContext(current[0]!, row))
    )
      flush();
    current.push(row);
    observationCount += row.observations.length;
  }
  flush();
  return { blocks, rejectedRows };
}
