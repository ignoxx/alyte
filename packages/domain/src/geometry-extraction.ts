import type { GeometryCell, GeometryRow } from './geometry';
import { enumerateGeometryFieldCandidates } from './geometry';
import {
  geometryResultAnchorKind,
  groupGeometryCandidateWindows,
  isGeometryCandidateLabelText,
  type GeometryCandidateWindowRow,
} from './geometry-candidate-windows';
import {
  groupObservationsIntoRows,
  parseComparatorValue,
  reparseExtractionRowFromSemanticFields,
  type ExtractionAliasEntry,
  type ExtractionDateContext,
  type ExtractionDraftRow,
  type ExtractionSourceLocation,
  type NormalizedBoundingBox,
  type VisionTextObservation,
} from './extraction';
import { isExtractionCategoricalResultValue } from './extraction-value-shapes';
import type { LabDateState, LabSourceArtifact, SpecimenType } from './labs';

/** Options shared by the pure geometry-to-draft adapter and the ordinary extraction parser. */
export type GeometryExtractionRowOptions = {
  readonly observations: readonly VisionTextObservation[];
  readonly locale?: string;
  readonly collectionDate?: LabDateState;
  readonly collectionDateDefaulted?: boolean;
  readonly collectionDateContexts?: readonly ExtractionDateContext[];
  readonly specimenType?: SpecimenType;
  readonly aliases?: readonly ExtractionAliasEntry[];
  readonly artifact?: LabSourceArtifact | null;
  /** Explicit evidence that this row belongs to a laboratory result table. */
  readonly resultTableContext?: boolean;
  /** Explicit sibling-result evidence supplied by the caller that owns the full lattice. */
  readonly siblingMeasurementEvidence?: boolean;
};

/**
 * A parsed row that was not admitted by deterministic catalogue extraction. It is still an
 * editable Extraction Draft shape, but its `kind` keeps the review boundary explicit for callers.
 * The row contains no model-authored value, label, unit, or interpretation.
 */
export type GeometryProvisionalRow = {
  readonly kind: 'geometry-provisional';
  readonly physicalRowId: string;
  readonly row: ExtractionDraftRow;
  readonly fieldCellIds: {
    readonly label: string;
    readonly value: string;
    readonly unit: string | null;
    readonly referenceInterval: string | null;
    readonly flag: string | null;
  };
};

/** Result of parsing one physical row without invoking a semantic model or persisting anything. */
export type GeometryExtractionRowResult = {
  readonly deterministicRows: readonly ExtractionDraftRow[];
  readonly provisionalRows: readonly GeometryProvisionalRow[];
};

/**
 * Parses one resolved physical OCR row into ordinary deterministic rows or a bounded provisional
 * row. A provisional row requires one distinct, exact label cell and one distinct scalar value
 * cell. The selected cells remain source-linked; no substring, conversion, or mapping is guessed.
 */
export function parseGeometryRowIntoExtractionRows(
  physicalRow: GeometryRow,
  options: GeometryExtractionRowOptions,
): GeometryExtractionRowResult {
  const cells = validatedGeometryCells(physicalRow, options.observations);
  if (cells === null) return { deterministicRows: [], provisionalRows: [] };

  const cellObservations = cells.map(({ cell, parent }) => geometryCellObservation(cell, parent));
  const parserOptions = {
    locale: options.locale ?? 'en-US',
    collectionDate: options.collectionDate ?? { kind: 'missing' },
    collectionDateDefaulted: options.collectionDateDefaulted ?? false,
    collectionDateContexts: options.collectionDateContexts ?? [],
    specimenType: options.specimenType ?? 'unknown',
    aliases: options.aliases ?? [],
    artifact: options.artifact ?? null,
  } as const;
  // The deterministic branch is exactly the ordinary parser's default output. An opt-in
  // unshaped pass below is only allowed to discover a geometry-qualified provisional candidate.
  const deterministicRows = groupObservationsIntoRows(cellObservations, parserOptions);
  if (deterministicRows.length > 0) return { deterministicRows, provisionalRows: [] };

  const parsedRows = groupObservationsIntoRows(cellObservations, {
    ...parserOptions,
    includeUnshapedRows: true,
  });
  if (parsedRows.length !== 1) return { deterministicRows: [], provisionalRows: [] };
  const parsed = parsedRows[0]!;

  const fieldCandidates = enumerateGeometryFieldCandidates(physicalRow);
  if (
    physicalRow.status !== 'resolved' ||
    fieldCandidates.requiresReview ||
    !isSingleDistinctRequiredFieldSet(fieldCandidates)
  )
    return { deterministicRows: [], provisionalRows: [] };

  const label = fieldCandidates.roles.label.selectedCellId;
  const value = fieldCandidates.roles.value.selectedCellId;
  if (label === null || value === null || label === value) {
    return { deterministicRows: [], provisionalRows: [] };
  }

  const selectedValue = cells.find((candidate) => candidate.cell.id === value)?.cell.text.trim();
  const selectedLabel = cells.find((candidate) => candidate.cell.id === label)?.cell.text.trim();
  // Geometry role matching is intentionally broad enough for unfamiliar units, so re-check the
  // exact selected cells here. A value cell containing a range, unit, date, or prose is not scalar.
  if (!isPlausibleLabel(selectedLabel) || !isExactScalarValue(selectedValue)) {
    return { deterministicRows: [], provisionalRows: [] };
  }

  const sourceFields = {
    label,
    value,
    unit: fieldCandidates.roles.unit.selectedCellId,
    referenceInterval: fieldCandidates.roles.reference.selectedCellId,
    flag: fieldCandidates.roles.flag.selectedCellId,
  };
  if (
    parsed.proposedValue.kind === 'numeric' ||
    parsed.proposedValue.kind === 'bounded' ||
    parsed.proposedValue.kind === 'categorical'
  ) {
    if (
      sourceFields.unit === null &&
      sourceFields.referenceInterval === null &&
      sourceFields.flag === null &&
      !physicalRow.seededByTableStructure &&
      options.resultTableContext !== true &&
      options.siblingMeasurementEvidence !== true
    )
      return { deterministicRows: [], provisionalRows: [] };
  }
  const sourceProvenanceRow = withGeometrySourceProvenance(
    parsed,
    physicalRow,
    cellObservations,
    sourceFields,
  );
  let provisional: ExtractionDraftRow;
  try {
    provisional = reparseExtractionRowFromSemanticFields(
      sourceProvenanceRow,
      sourceFields,
      options.aliases ?? [],
    );
  } catch {
    // This is the final promotion gate for the provisional shape. A model can later select the
    // same exact fields, but this pure domain pass must never emit a row that cannot be reparsed.
    return { deterministicRows: [], provisionalRows: [] };
  }
  return {
    deterministicRows: [],
    provisionalRows: [
      {
        kind: 'geometry-provisional',
        physicalRowId: physicalRow.id,
        row: {
          ...provisional,
          // Unknown rows must remain explicit review work. In particular, a missing unit is not
          // silently converted into an auto-skipped candidate at this boundary.
          decision: 'preserve',
          reviewState: 'needs-review',
        },
        fieldCellIds: {
          label,
          value,
          unit: fieldCandidates.roles.unit.selectedCellId,
          referenceInterval: fieldCandidates.roles.reference.selectedCellId,
          flag: fieldCandidates.roles.flag.selectedCellId,
        },
      },
    ],
  };
}

/** Parses only the provisional branch for callers that already own deterministic rows. */
export function parseGeometryRowAsProvisional(
  physicalRow: GeometryRow,
  options: GeometryExtractionRowOptions,
): GeometryProvisionalRow | null {
  return parseGeometryRowIntoExtractionRows(physicalRow, options).provisionalRows[0] ?? null;
}

/** Short alias for the report extraction adapter. */
export const buildGeometryProvisionalRow = parseGeometryRowAsProvisional;

/**
 * Builds a review-only draft row from one already-selected geometry variant.
 *
 * The variant owns exact source fields and ambiguity metadata. This adapter creates only the base
 * draft shape needed by the unchanged semantic reparser; it never chooses a different cell,
 * normalizes a value authoritatively, or turns the provisional row into a Measurement.
 */
export function parseGeometryCandidateVariantAsProvisional(
  variant: GeometryCandidateWindowRow,
  options: Omit<GeometryExtractionRowOptions, 'observations'>,
): GeometryProvisionalRow | null {
  // Revalidate the complete opaque physical-row preimage before using an exported variant. The
  // model can only select a local variant key, but this domain API must also fail closed when a
  // caller passes a forged or stale in-memory candidate.
  const validatedGroup = groupGeometryCandidateWindows([variant])[0];
  const validatedVariant = validatedGroup?.variants[0];
  if (
    validatedGroup === undefined ||
    !validatedGroup.withinInputBounds ||
    validatedGroup.variants.length !== 1 ||
    validatedVariant === undefined ||
    validatedVariant.rowId !== variant.rowId
  )
    return null;

  const observations = validatedVariant.observations;
  const fields = validatedVariant.provisionalSourceFields;
  if (
    observations.length === 0 ||
    observations.length !== validatedVariant.sourceObservationIds.length ||
    observations.length !== validatedVariant.sourceCells.length ||
    observations.some(
      (observation, index) =>
        observation.id !== validatedVariant.sourceObservationIds[index] ||
        observation.id !== validatedVariant.sourceCells[index]?.id ||
        observation.text !== validatedVariant.sourceCells[index]?.text ||
        observation.pageIndex !== validatedVariant.context.pageIndex ||
        !sameBox(observation.boundingBox, validatedVariant.sourceCells[index]?.boundingBox) ||
        !matchesCellSourceSpan(observation, validatedVariant.sourceCells[index]),
    ) ||
    fields.value !== validatedVariant.anchorCellId ||
    validatedVariant.ambiguousSourceRoles.some((role) => role === 'value')
  )
    return null;
  const selectedIds = Object.values(fields).filter((value): value is string => value !== null);
  if (
    selectedIds.length < 2 ||
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !validatedVariant.sourceObservationIds.includes(id))
  )
    return null;
  const sourceGeometryRow: GeometryRow = {
    id: validatedVariant.rowId,
    status: 'resolved',
    pageIndex: validatedVariant.context.pageIndex,
    tableId: validatedVariant.context.tableId,
    sectionId: validatedVariant.context.sectionId,
    specimenKey: validatedVariant.context.specimenKey,
    collectionDateKey: validatedVariant.context.collectionDateKey,
    seededByTableStructure: validatedVariant.context.tableId !== null,
    sourceObservationIds: [...validatedVariant.sourceObservationIds],
    parentIds: [...new Set(validatedVariant.sourceCells.map((cell) => cell.parentId))],
    yBandCount: 1,
    cells: validatedVariant.sourceCells,
  };
  const roles = enumerateGeometryFieldCandidates(sourceGeometryRow).roles;
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
    if (
      selectedField !== null &&
      !roles[role].candidates.some((candidate) => candidate.cellId === selectedField)
    )
      return null;
  }
  const declaredAmbiguity = new Set(validatedVariant.ambiguousSourceRoles);
  if (
    (['label', 'unit', 'reference', 'flag'] as const).some(
      (role) => roles[role].resolution === 'ambiguous' && !declaredAmbiguity.has(role),
    )
  )
    return null;
  const sourceText = (id: string | null): string | null =>
    id === null ? null : (observations.find((observation) => observation.id === id)?.text ?? null);
  const selectedLabelText = sourceText(fields.label);
  const selectedValueText = sourceText(fields.value);
  if (selectedLabelText === null || !isGeometryCandidateLabelText(selectedLabelText)) return null;
  if (
    selectedValueText === null ||
    geometryResultAnchorKind(selectedValueText) !== validatedVariant.anchorKind
  )
    return null;

  const first = observations[0]!;
  const box = observations.slice(1).reduce(
    (result, observation) => ({
      x: Math.min(result.x, observation.boundingBox.x),
      y: Math.min(result.y, observation.boundingBox.y),
      width:
        Math.max(
          result.x + result.width,
          observation.boundingBox.x + observation.boundingBox.width,
        ) - Math.min(result.x, observation.boundingBox.x),
      height:
        Math.max(
          result.y + result.height,
          observation.boundingBox.y + observation.boundingBox.height,
        ) - Math.min(result.y, observation.boundingBox.y),
    }),
    first.boundingBox,
  );
  const joinedSourceText = observations.map((observation) => observation.text.trim()).join('  ');
  // The temporary row-shape scaffold uses only the already-validated proposal. Extra source cells
  // can contain another result anchor or ambiguous label and must not influence this base parse.
  // The complete exact source remains attached below and replaces every synthetic source field.
  const syntheticText = [
    fields.label,
    fields.value,
    fields.unit,
    fields.referenceInterval,
    fields.flag,
  ]
    .map(sourceText)
    .filter((value): value is string => value !== null)
    .map((value) => value.trim())
    .join('  ');
  const synthetic: VisionTextObservation = {
    id: `provisional:${validatedVariant.rowId}`,
    text: syntheticText,
    alternatives: [],
    boundingBox: box,
    pageIndex: validatedVariant.context.pageIndex,
    orientation: first.orientation,
    recognition: first.recognition,
    structure: {
      kind: 'text',
      tableId: validatedVariant.context.tableId,
      rowIndex: null,
      columnIndex: null,
    },
  };
  const parserOptions = {
    locale: options.locale ?? 'en-US',
    collectionDate: options.collectionDate ?? { kind: 'missing' },
    collectionDateDefaulted: options.collectionDateDefaulted ?? false,
    collectionDateContexts: options.collectionDateContexts ?? [],
    specimenType: options.specimenType ?? 'unknown',
    aliases: options.aliases ?? [],
    artifact: options.artifact ?? null,
    includeUnshapedRows: true,
  } as const;
  const base = groupObservationsIntoRows([synthetic], parserOptions)[0];
  if (base === undefined) return null;
  const sourceRow: ExtractionDraftRow = {
    ...base,
    sourceText: joinedSourceText,
    source: {
      ...base.source,
      observationIds: observations.map((observation) => observation.id),
      observations,
      raw: {
        label: sourceText(fields.label),
        value: sourceText(fields.value),
        unit: sourceText(fields.unit),
        referenceInterval: sourceText(fields.referenceInterval),
        flag: sourceText(fields.flag),
        collectionDate: base.source.raw?.collectionDate ?? null,
      },
    },
  };
  try {
    const reparsed = reparseExtractionRowFromSemanticFields(
      sourceRow,
      fields,
      options.aliases ?? [],
    );
    const ambiguityReasons =
      validatedVariant.ambiguousSourceRoles.length > 0 ? (['unsupported-layout'] as const) : [];
    return {
      kind: 'geometry-provisional',
      physicalRowId: validatedVariant.physicalRowId,
      row: {
        ...reparsed,
        reviewReasons: [...new Set([...reparsed.reviewReasons, ...ambiguityReasons])],
        decision: 'preserve',
        reviewState: 'needs-review',
      },
      fieldCellIds: fields,
    };
  } catch {
    return null;
  }
}

function isSingleDistinctRequiredFieldSet(
  candidates: ReturnType<typeof enumerateGeometryFieldCandidates>,
): boolean {
  const label = candidates.roles.label.selectedCellId;
  const value = candidates.roles.value.selectedCellId;
  return label !== null && value !== null && label !== value;
}

function validatedGeometryCells(
  row: GeometryRow,
  observations: readonly VisionTextObservation[],
): readonly { readonly cell: GeometryCell; readonly parent: VisionTextObservation }[] | null {
  if (row.status !== 'resolved' || row.id.length === 0 || row.cells.length === 0) return null;
  const sourceIds = new Set(row.sourceObservationIds);
  if (sourceIds.size !== row.sourceObservationIds.length) return null;
  const cells = new Set<string>();
  const parents = new Map(observations.map((observation) => [observation.id, observation]));
  if (parents.size !== observations.length) return null;
  const selected: { cell: GeometryCell; parent: VisionTextObservation }[] = [];
  for (const cell of row.cells) {
    if (
      cell.id.length === 0 ||
      cells.has(cell.id) ||
      !sourceIds.has(cell.sourceObservationId) ||
      !Number.isInteger(cell.sourceStart) ||
      !Number.isInteger(cell.sourceEnd) ||
      cell.sourceStart < 0 ||
      cell.sourceEnd <= cell.sourceStart
    )
      return null;
    const parent = parents.get(cell.sourceObservationId);
    if (parent === undefined) return null;
    if (
      cell.parentId !== parent.id ||
      cell.sourceEnd > parent.text.length ||
      cell.pageIndex !== parent.pageIndex ||
      cell.pageIndex !== row.pageIndex ||
      cell.text !== parent.text.slice(cell.sourceStart, cell.sourceEnd) ||
      !validBox(cell.boundingBox)
    )
      return null;
    // A geometry row cannot smuggle a source cell from another parent through a matching ID.
    if (
      cell.parentId.length === 0 ||
      selected.some(
        ({ cell: prior }) =>
          prior.sourceObservationId === cell.sourceObservationId &&
          prior.sourceStart === cell.sourceStart &&
          prior.sourceEnd === cell.sourceEnd,
      )
    )
      return null;
    cells.add(cell.id);
    selected.push({ cell, parent });
  }
  if (
    new Set(selected.map(({ cell }) => cell.sourceObservationId)).size !== sourceIds.size ||
    ![...sourceIds].every((id) => selected.some(({ cell }) => cell.sourceObservationId === id))
  )
    return null;
  // A derived row may contain several exact children of one OCR parent, but their source spans
  // must describe a stable, non-overlapping partition of that parent's text. This keeps later
  // source selection from aliasing or silently reordering provenance.
  const cellsByParent = new Map<string, GeometryCell[]>();
  for (const { cell } of selected) {
    const siblings = cellsByParent.get(cell.parentId) ?? [];
    siblings.push(cell);
    cellsByParent.set(cell.parentId, siblings);
  }
  for (const siblings of cellsByParent.values()) {
    const ordered = [...siblings].sort(
      (left, right) => left.sourceStart - right.sourceStart || left.sourceEnd - right.sourceEnd,
    );
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.sourceStart < ordered[index - 1]!.sourceEnd) return null;
    }
  }
  if (!resolvedPhysicalBand(row, selected)) return null;
  return selected;
}

/**
 * Verifies the physical-row invariant independently of a permissive aggregate bounding box. A
 * tall OCR cell may bridge adjacent rows, so it cannot be allowed to define the row's y-band.
 */
function resolvedPhysicalBand(
  row: GeometryRow,
  selected: readonly { readonly cell: GeometryCell; readonly parent: VisionTextObservation }[],
): boolean {
  if (row.yBandCount !== 1) return false;
  const tableStructures = selected.map(({ parent }) => parent.structure);
  if (tableStructures.some((structure) => structure?.kind === 'table-cell')) {
    if (
      tableStructures.some(
        (structure) =>
          structure?.kind !== 'table-cell' ||
          structure.tableId === null ||
          structure.rowIndex === null,
      )
    )
      return false;
    const first = tableStructures[0]!;
    return tableStructures.every(
      (structure) =>
        structure?.kind === 'table-cell' &&
        structure.tableId === first?.tableId &&
        structure.rowIndex === first?.rowIndex,
    );
  }

  const cells = selected.map(({ cell }) => cell);
  const heights = cells.map(({ boundingBox }) => boundingBox.height).sort((a, b) => a - b);
  const typicalHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  if (typicalHeight <= 0) return false;
  const center = (cell: GeometryCell) => cell.boundingBox.y + cell.boundingBox.height / 2;
  const shortCells = cells.filter((cell) => cell.boundingBox.height <= typicalHeight * 1.8);
  const representatives = shortCells.length > 0 ? shortCells : cells;
  const representativeCenters = [...representatives].map(center).sort((a, b) => a - b);
  const tolerance = typicalHeight * 0.7;
  const bands: number[] = [];
  for (const value of representativeCenters) {
    const prior = bands.at(-1);
    if (prior === undefined || value - prior > tolerance) bands.push(value);
    else bands[bands.length - 1] = (prior + value) / 2;
  }
  if (bands.length !== 1) return false;
  const bandCenter = bands[0]!;
  return cells.every((cell) => {
    const box = cell.boundingBox;
    const overlap = Math.max(
      0,
      Math.min(box.y + box.height, bandCenter + typicalHeight / 2) -
        Math.max(box.y, bandCenter - typicalHeight / 2),
    );
    return overlap / Math.max(0.000001, Math.min(box.height, typicalHeight)) >= 0.2;
  });
}

function geometryCellObservation(
  cell: GeometryCell,
  parent: VisionTextObservation,
): VisionTextObservation {
  const structure = parent.structure;
  return {
    id: cell.id,
    text: cell.text,
    alternatives: parent.alternatives,
    boundingBox: cell.boundingBox,
    pageIndex: cell.pageIndex,
    orientation: parent.orientation,
    structure:
      structure?.kind === 'table-cell'
        ? {
            kind: 'table-cell',
            tableId: structure.tableId,
            rowIndex: structure.rowIndex,
            columnIndex: structure.columnIndex,
          }
        : {
            kind: 'text',
            tableId: structure?.tableId ?? null,
            rowIndex: null,
            columnIndex: cell.columnIndex,
          },
    sourceSpan: {
      id: `${cell.id}:source`,
      parentObservationId: parent.id,
      start: cell.sourceStart,
      end: cell.sourceEnd,
      text: cell.text,
      boundingBox: cell.boundingBox,
      parentText: parent.text,
    },
    recognition: parent.recognition,
  };
}

function withGeometrySourceProvenance(
  parsed: ExtractionDraftRow,
  row: GeometryRow,
  observations: readonly VisionTextObservation[],
  fields: {
    readonly label: string;
    readonly value: string;
    readonly unit: string | null;
    readonly referenceInterval: string | null;
    readonly flag: string | null;
  },
): ExtractionDraftRow {
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  const sourceObservations = row.cells
    .map((cell) => observationById.get(cell.id))
    .filter((observation): observation is VisionTextObservation => observation !== undefined);
  const source = parsed.source;
  const rawText = (id: string | null): string | null =>
    id === null
      ? null
      : (sourceObservations.find((observation) => observation.id === id)?.text ?? null);
  const sourceLocation: ExtractionSourceLocation = {
    ...source,
    // Derived cell observations are the source-addressable units presented to later selection.
    // Keep this list positional with `observations`; each cell retains its original parent in its
    // validated sourceSpan below.
    observationIds: sourceObservations.map((observation) => observation.id),
    observations: sourceObservations,
    raw: {
      label: rawText(fields.label),
      value: rawText(fields.value),
      unit: rawText(fields.unit),
      referenceInterval: rawText(fields.referenceInterval),
      flag: rawText(fields.flag),
      collectionDate: source.raw?.collectionDate ?? null,
    },
  };
  return {
    ...parsed,
    source: sourceLocation,
    sourceText: sourceObservations.map((observation) => observation.text.trim()).join('  '),
  };
}

function isPlausibleLabel(input: string | undefined): input is string {
  if (input === undefined || input.length < 2 || !/\p{L}/u.test(input)) return false;
  const normalized = input
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[.:;,()[\]{}]/gu, ' ')
    .trim();
  if (
    !normalized ||
    /^(?:page|p|date|time|patient|name|address|phone|license|licence|report|result|results|reference|range|unit|units|specimen|collection|laboratory|lab|sample|probe|proben|probenentnahme|probenahme|muster|id|identifier|kennung|patientenkennung|numeris|nr|number|nummer|eingangsdatum|empfangsdatum|meginys|meginio|paemimas|paemimo|ataskaita)$/u.test(
      normalized,
    )
  )
    return false;
  if (
    /\b(?:page|patient|address|phone|email|fax|license|licence|report|result|results|reference|range|unit|units|specimen|collection|laboratory|lab|sample|probe|proben|probenentnahme|probenahme|muster|generated|printed|contact|accession|identifier|kennung|patientenkennung|nummer|numeris|number|record|confidential|hospital|clinic|physician|doctor|birth|gender|sex|entnahme|received|eingang|erhalten|gauta|paemimas|paemimo|ataskaita|patientas|pacientas|meginys|meginio|datum|data)\b/iu.test(
      normalized,
    )
  )
    return false;
  return normalized.split(/\s+/u).length <= 12;
}

function isExactScalarValue(input: string | undefined): boolean {
  if (input === undefined || input.length === 0) return false;
  // `parseComparatorValue` intentionally tolerates a suffix for ordinary row discovery. The
  // geometry adapter needs the stricter source-cell contract: no unit, date, or prose may trail a
  // selected numeric cell. Units are selected from their own exact cell below.
  if (
    /^[<>≤≥]?\s*[+-]?(?:(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?)|(?:\d+(?:[.,]\d+)?)|(?:\.\d+))\s*$/u.test(
      input,
    )
  ) {
    const parsed = parseComparatorValue(input);
    return parsed?.kind === 'numeric' || parsed?.kind === 'bounded';
  }
  return isNarrowCategoricalValue(input);
}

function isNarrowCategoricalValue(input: string): boolean {
  return isExtractionCategoricalResultValue(input);
}

function validBox(box: NormalizedBoundingBox): boolean {
  return (
    [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.000001 &&
    box.y + box.height <= 1.000001
  );
}

function sameBox(left: NormalizedBoundingBox, right: NormalizedBoundingBox | undefined): boolean {
  return (
    right !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function matchesCellSourceSpan(
  observation: VisionTextObservation,
  cell: GeometryCell | undefined,
): boolean {
  const span = observation.sourceSpan;
  if (
    cell === undefined ||
    span === undefined ||
    span.text !== cell.text ||
    span.parentText.slice(span.start, span.end) !== cell.text ||
    !sameBox(span.boundingBox, cell.boundingBox)
  )
    return false;
  const directCellSpan =
    span.parentObservationId === cell.sourceObservationId &&
    span.start === cell.sourceStart &&
    span.end === cell.sourceEnd;
  // A whole-cell observation may already carry an exact span to an earlier OCR parent. Its full
  // observation is bound into the candidate row ID, so retaining that chain is source-preserving
  // and tamper-evident even though its offsets are relative to the earlier parent.
  const inheritedWholeCellSpan =
    observation.id === cell.sourceObservationId &&
    cell.sourceStart === 0 &&
    cell.sourceEnd === observation.text.length;
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= span.parentText.length &&
    (directCellSpan || inheritedWholeCellSpan)
  );
}
