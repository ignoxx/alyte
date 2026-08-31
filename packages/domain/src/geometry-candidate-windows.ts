import {
  type ExtractionSemanticFieldSelection,
  type ExtractionSemanticCandidateRow,
  type NormalizedBoundingBox,
  type VisionSourceSpan,
  type VisionTextObservation,
} from './extraction';
// One shared classifier keeps candidate discovery and downstream reparsing in lockstep.
import { isExtractionCategoricalResultValue } from './extraction-value-shapes';
import {
  enumerateGeometryFieldCandidates,
  type GeometryCell,
  type GeometryFieldRole,
  type GeometryRow,
  type GeometryLattice,
} from './geometry';

/** The result-shaped cell kinds this adapter can safely anchor without a semantic model. */
export type GeometryResultAnchorKind = 'numeric' | 'categorical';

/** The boundary identity that a candidate window is never allowed to cross. */
export type GeometryCandidateContext = Pick<
  GeometryRow,
  'pageIndex' | 'tableId' | 'sectionId' | 'specimenKey' | 'collectionDateKey'
>;

/**
 * A source-selector row plus the physical source cells that produced it.
 *
 * `observations` is deliberately shaped like the existing semantic contract: each item is one
 * exact source cell, not an OCR paragraph and not a Measurement. `sourceCells` keeps the geometry
 * identity available to the local adapter that later applies an accepted source selection.
 */
export type GeometryCandidateWindowRow = ExtractionSemanticCandidateRow & {
  /** Opaque identity of the complete physical source row, shared by every anchor variant. */
  readonly physicalRowId: string;
  /** Exact internal preimage used to prove that an opaque ID was not reused for another row. */
  readonly physicalRowKey: string;
  /** Complete validated physical-row cells; unlike `sourceCells`, this is never sent to a mapper. */
  readonly physicalRowCells: readonly GeometryCell[];
  readonly anchorCellId: string;
  readonly anchorKind: GeometryResultAnchorKind;
  readonly context: GeometryCandidateContext;
  readonly sourceCells: readonly GeometryCell[];
  /** Exact geometry-selected source proposal. It is provisional and never a Measurement. */
  readonly provisionalSourceFields: ExtractionSemanticFieldSelection;
  /** Roles with more than one plausible source cell; review must keep this uncertainty visible. */
  readonly ambiguousSourceRoles: readonly GeometryFieldRole[];
};

/**
 * One physical source row and all of its exact result-anchor variants.
 *
 * A group is the semantic admission unit. `variants` are retained so a later validator can prove
 * that exactly one value survived; they are never independent model rows. `observations` is the
 * bounded union of every exact source cell needed to evaluate the group, ordered deterministically
 * and carrying the original parent/span provenance.
 */
export type GeometryCandidateWindowGroup = ExtractionSemanticCandidateRow & {
  readonly physicalRowId: string;
  readonly physicalRowKey: string;
  readonly physicalRowCells: readonly GeometryCell[];
  readonly variants: readonly GeometryCandidateWindowRow[];
  readonly anchorCellIds: readonly string[];
  readonly anchorKinds: readonly GeometryResultAnchorKind[];
  readonly context: GeometryCandidateContext;
  readonly sourceCells: readonly GeometryCell[];
  readonly withinInputBounds: boolean;
};

export type GeometryCandidateWindowGroupingOptions = {
  /** Maximum exact source cells one complete physical-row group may expose to a mapper. */
  readonly maxSourceCells?: number;
};

export type GeometryCandidateWindowOptions = {
  /** At most one physically adjacent row is considered for a missing label. */
  readonly maxAdjacentRows?: 0 | 1;
  /**
   * Maximum vertical gap between adjacent OCR bands. This is intentionally bounded and expressed
   * in normalized page coordinates. The default is one-and-a-half typical OCR cell heights.
   */
  readonly maxAdjacentRowGap?: number;
};

export const GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS = 6 as const;
/** Matches the compact semantic contract's complete-row observation bound. */
export const GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS = 24 as const;
export const GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROWS = 1 as const;
export const GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROW_GAP = 0.055 as const;
const DEFAULT_MAX_ADJACENT_ROW_GAP = GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROW_GAP;

/** Common report metadata/header labels that must never become a source-selector label. */
const METADATA_LABELS = new Set([
  'address',
  'analysis',
  'analyte',
  'barcode',
  'birth date',
  'born',
  'collected',
  'collection date',
  'date',
  'dob',
  'doctor',
  'email',
  'flag',
  'gender',
  'issued',
  'laboratory',
  'lab',
  'material',
  'method',
  'name',
  'no',
  'number',
  'page',
  'patient',
  'patient id',
  'no result',
  'not available',
  'phone',
  'physician',
  'reference',
  'reference interval',
  'reference range',
  'report',
  'result',
  'results',
  'sample',
  'sex',
  'specimen',
  'status',
  'test',
  'time',
  'unit',
  'units',
  'value',
  'data',
  'gimimo data',
  'laboratorija',
  'mėginys',
  'pacientas',
  'rezultatas',
  'tyrimas',
  'vienetas',
  'vnt',
  'adresse',
  'analyse',
  'geburtsdatum',
  'befund',
  'befunde',
  'ergebnis',
  'ergebnisse',
  'referenzbereich',
  'referenzintervall',
  'einheit',
  'einheiten',
  'wert',
  'seite',
  'bericht',
  'probe',
  'probenmaterial',
  'entnahme',
  'ausgestellt',
  'arzt',
  'telefonnummer',
  'e-mail',
  'adresas',
  'analizė',
  'gimimo',
  'paėmimo data',
  'gydytojas',
  'paciento id',
  'puslapis',
  'ataskaita',
  'rezultatai',
  'mėginio medžiaga',
  'pamatinis intervalas',
  'normos intervalas',
  'vertė',
  'telefonas',
]);

/**
 * OCR often emits report prose as one large text cell. These prefixes are deliberately narrow:
 * they reject common explanatory/administrative sentences while preserving ordinary multi-word
 * analyte labels (including labels that contain words such as "total" or "cholesterol").
 */
const PROSE_METADATA_PREFIX = new RegExp(
  String.raw`^(?:this|that|these|those|there|it|no|not|please|see|patient\p{L}*|report\p{L}*|laborator\p{L}*|specimen\p{L}*|sample\p{L}*|reference\p{L}*|result\p{L}*|comment\p{L}*|note|interpret\p{L}*|value|unit|date|page|` +
    String.raw`dies|der|die|das|ein|eine|kein\p{L}*|bitte|siehe|patient\p{L}*|bericht\p{L}*|labor\p{L}*|probe|referenz\p{L}*|ergebnis\p{L}*|bemerk\p{L}*|hinweis\p{L}*|interpretation\p{L}*|methode|wert|einheit|seite|` +
    String.raw`tai|šis|šio|šį|nėra|prašome|žr|pacient\p{L}*|ataskait\p{L}*|laborator\p{L}*|mėgin\p{L}*|pamat\p{L}*|referenc\p{L}*|rezultat\p{L}*|tyrim\p{L}*|pastab\p{L}*|komentar\p{L}*|interpretac\p{L}*|metod\p{L}*|vert\p{L}*|puslap\p{L}*)(?:\s|$)`,
  'iu',
);
const DATE_ONLY = /^(?:\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}[/-]\d{1,2})$/u;
const GROUPED_INTEGER = String.raw`(?:\d{1,3}(?:[\s\u00a0\u202f]\d{3})+|\d{1,3}(?:[.,]\d{3})+)`;
const NUMERIC_ATOM = String.raw`(?:${GROUPED_INTEGER}(?:[.,]\d+)?|\d+(?:[.,]\d+)?|\.\d+)`;
const STRICT_NUMERIC = new RegExp(String.raw`^[<>≤≥]?\s*[+-]?${NUMERIC_ATOM}\s*$`, 'u');
const RANGE_VALUE = new RegExp(
  String.raw`^[<>≤≥]?\s*[+-]?${NUMERIC_ATOM}\s*(?:-|–|—|\bto\b)\s*[<>≤≥]?\s*[+-]?${NUMERIC_ATOM}$`,
  'iu',
);
const UNIT_ONLY =
  /^(?:%|[µμu]?g|mg|ng|pg|fg|mmol|mol|nmol|pmol|g|kg|U|IU|fL)(?:\s*\/\s*(?:dL|L|mL|mol|kg))?$/iu;
const FLAG_ONLY = /^(?:h|l|high|low|normal|abnormal|positive|negative|detected|not detected)$/iu;

/**
 * Builds bounded source-selector windows from a reconstructed OCR lattice.
 *
 * The adapter is deliberately conservative: it only emits a row when an exact scalar/categorical
 * anchor and a plausible non-metadata label are present in the same physical row or in one tightly
 * adjacent row sharing the complete geometry context. It does not parse, normalize, translate, or
 * persist anything, and it never changes the deterministic parser's output.
 */
export function buildGeometryCandidateWindows(
  lattice: GeometryLattice,
  observations: readonly VisionTextObservation[],
  options: GeometryCandidateWindowOptions = {},
): readonly GeometryCandidateWindowRow[] {
  const maxAdjacentRows = options.maxAdjacentRows ?? GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROWS;
  const maxAdjacentRowGap = options.maxAdjacentRowGap ?? DEFAULT_MAX_ADJACENT_ROW_GAP;
  if (
    !Number.isInteger(maxAdjacentRows) ||
    maxAdjacentRows < 0 ||
    maxAdjacentRows > GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROWS ||
    !Number.isFinite(maxAdjacentRowGap) ||
    maxAdjacentRowGap < 0 ||
    maxAdjacentRowGap > GEOMETRY_CANDIDATE_WINDOW_MAX_ADJACENT_ROW_GAP
  )
    return [];

  const parents = new Map(observations.map((observation) => [observation.id, observation]));
  if (parents.size !== observations.length) return [];

  const physicalRows = lattice.rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort(comparePhysicalRows)
    .map((entry, physicalIndex) => ({
      ...entry,
      physicalIndex,
      validated: entry.row.status === 'resolved' ? validateRowCells(entry.row, parents) : null,
    }));
  const validatedRows = physicalRows.flatMap((entry) =>
    entry.validated === null ? [] : [{ ...entry.validated, physicalIndex: entry.physicalIndex }],
  );

  const candidates: GeometryCandidateWindowRow[] = [];
  const emittedAnchors = new Set<string>();
  const candidateRowIds = new Map<string, string>();
  const physicalRowIds = new Map<string, string>();
  for (const row of validatedRows.sort(compareValidatedRows)) {
    const anchors = resultAnchors(row.row);
    for (const anchor of anchors) {
      if (emittedAnchors.has(anchor.cell.id)) continue;
      const sameRowLabels = plausibleLabelCells(row.row);
      let selectedRows: readonly ValidatedRow[] = [row];
      let labels = sameRowLabels;
      if (labels.length === 0 && maxAdjacentRows > 0) {
        const adjacent = immediateAdjacentLabelRow(row, physicalRows, maxAdjacentRowGap);
        if (adjacent !== null) {
          selectedRows = [adjacent, row].sort(compareValidatedRows);
          labels = plausibleLabelCells(adjacent.row);
        }
      }
      if (labels.length === 0) continue;

      const window = selectWindowCells(selectedRows, anchor.cell, labels, row.row);
      if (window === null) continue;
      const candidate = createCandidateWindow(
        selectedRows,
        row,
        anchor,
        window,
        parents,
        candidateRowIds,
        physicalRowIds,
      );
      if (candidate === null) continue;
      emittedAnchors.add(anchor.cell.id);
      candidates.push(candidate);
    }
  }
  return candidates.sort(compareCandidates);
}

/**
 * Groups anchor-specific geometry windows by their physical source row.
 *
 * This is intentionally a pure, near-linear operation. It never chooses a value and never uses
 * recognition confidence or array order to resolve ambiguity. A group that exceeds the complete
 * input bound remains visible with `withinInputBounds: false`; callers must preserve it as one
 * review exception and must not split it into semantic chunks.
 */
export function groupGeometryCandidateWindows(
  windows: readonly GeometryCandidateWindowRow[],
  options: GeometryCandidateWindowGroupingOptions = {},
): readonly GeometryCandidateWindowGroup[] {
  const requestedMaxSourceCells =
    options.maxSourceCells ?? GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS;
  if (!Number.isSafeInteger(requestedMaxSourceCells) || requestedMaxSourceCells < 1) return [];
  const maxSourceCells = Math.min(
    requestedMaxSourceCells,
    GEOMETRY_CANDIDATE_WINDOW_MAX_GROUP_CELLS,
  );

  const grouped = new Map<string, GeometryCandidateWindowRow[]>();
  for (const window of windows) {
    if (
      typeof window.physicalRowId !== 'string' ||
      window.physicalRowId.length === 0 ||
      window.physicalRowId.length > 96
    )
      continue;
    const group = grouped.get(window.physicalRowId) ?? [];
    group.push(window);
    grouped.set(window.physicalRowId, group);
  }

  const result: GeometryCandidateWindowGroup[] = [];
  for (const [physicalRowId, variants] of grouped) {
    const variantsByAnchorId = new Map<string, GeometryCandidateWindowRow>();
    let provenanceConsistent = true;
    for (const variant of variants) {
      const fieldIds = Object.values(variant.provisionalSourceFields).filter(
        (value): value is string => value !== null,
      );
      if (
        variant.provisionalSourceFields.value !== variant.anchorCellId ||
        fieldIds.length < 2 ||
        new Set(fieldIds).size !== fieldIds.length ||
        fieldIds.some((id) => !variant.sourceObservationIds.includes(id)) ||
        new Set(variant.ambiguousSourceRoles).size !== variant.ambiguousSourceRoles.length ||
        variant.ambiguousSourceRoles.some(
          (role) => !new Set<GeometryFieldRole>(['label', 'unit', 'reference', 'flag']).has(role),
        )
      ) {
        provenanceConsistent = false;
        break;
      }
      const prior = variantsByAnchorId.get(variant.anchorCellId);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(variant)) {
        provenanceConsistent = false;
        break;
      }
      variantsByAnchorId.set(variant.anchorCellId, variant);
    }
    if (!provenanceConsistent) continue;
    const sortedVariants = [...variantsByAnchorId.values()].sort(compareCandidates);
    const first = sortedVariants[0];
    if (first === undefined) continue;
    if (
      typeof first.physicalRowKey !== 'string' ||
      first.physicalRowKey.length === 0 ||
      sortedVariants.some(
        (variant) =>
          variant.physicalRowKey !== first.physicalRowKey ||
          JSON.stringify(variant.physicalRowCells) !== JSON.stringify(first.physicalRowCells),
      )
    )
      continue;
    const contextKeyValue = JSON.stringify(first.context);
    const contextConsistent = sortedVariants.every(
      (variant) =>
        variant.physicalRowId === physicalRowId &&
        JSON.stringify(variant.context) === contextKeyValue,
    );
    if (!contextConsistent) continue;
    const expectedPhysicalRowKey = JSON.stringify([
      'physical-row',
      first.physicalRowCells,
      candidateContextKey(first.context),
    ]);
    if (
      first.physicalRowKey !== expectedPhysicalRowKey ||
      opaqueCandidateRowId(expectedPhysicalRowKey, 'pr-') !== physicalRowId
    )
      continue;
    if (
      sortedVariants.some(
        (variant) =>
          variant.rowId !==
          opaqueCandidateRowId(
            JSON.stringify([expectedPhysicalRowKey, variant.anchorCellId, variant.observations]),
          ),
      )
    )
      continue;
    const physicalCellsById = new Map(first.physicalRowCells.map((cell) => [cell.id, cell]));
    if (
      first.physicalRowCells.length === 0 ||
      physicalCellsById.size !== first.physicalRowCells.length ||
      sortedVariants.some((variant) =>
        variant.sourceCells.some(
          (cell) =>
            !physicalCellsById.has(cell.id) ||
            !sameGeometryCell(physicalCellsById.get(cell.id)!, cell),
        ),
      )
    )
      continue;

    const cellsById = new Map<string, GeometryCell>();
    provenanceConsistent = true;
    for (const variant of sortedVariants) {
      for (const cell of variant.sourceCells) {
        const prior = cellsById.get(cell.id);
        if (prior === undefined) cellsById.set(cell.id, cell);
        else if (!sameGeometryCell(prior, cell)) provenanceConsistent = false;
      }
    }
    if (!provenanceConsistent) continue;
    const sourceCells = [...cellsById.values()].sort(compareCells);
    const observationsById = new Map<string, VisionTextObservation>();
    for (const variant of sortedVariants) {
      for (const observation of variant.observations) {
        const prior = observationsById.get(observation.id);
        if (prior === undefined) observationsById.set(observation.id, observation);
        else if (!sameSourceObservation(prior, observation)) provenanceConsistent = false;
      }
    }
    if (!provenanceConsistent) continue;
    const observations = [...observationsById.values()].sort(compareObservations);
    if (
      sourceCells.length === 0 ||
      observations.length !== sourceCells.length ||
      observations.some((observation, index) => observation.id !== sourceCells[index]?.id)
    )
      continue;

    const anchorKindsById = new Map<string, GeometryResultAnchorKind>();
    for (const variant of sortedVariants) {
      const prior = anchorKindsById.get(variant.anchorCellId);
      if (prior !== undefined && prior !== variant.anchorKind) {
        provenanceConsistent = false;
        break;
      }
      anchorKindsById.set(variant.anchorCellId, variant.anchorKind);
    }
    if (!provenanceConsistent) continue;
    const anchorCellIds = [...anchorKindsById.keys()];
    const anchorKinds = anchorCellIds.map((cellId) => anchorKindsById.get(cellId)!);
    result.push({
      rowId: physicalRowId,
      physicalRowId,
      physicalRowKey: first.physicalRowKey,
      physicalRowCells: first.physicalRowCells,
      sourceObservationIds: observations.map((observation) => observation.id),
      observations,
      variants: sortedVariants,
      anchorCellIds,
      anchorKinds,
      context: first.context,
      sourceCells,
      // The mapper must be able to account for the complete physical preimage, including cells
      // that were not selected into any one anchor-specific window. Never treat a small window as
      // safe when its parent source row is itself larger than the input contract.
      withinInputBounds: first.physicalRowCells.length <= maxSourceCells,
    });
  }
  return result.sort(compareGroups);
}

/** Explicit alias for callers that use the row terminology from the issue. */
export const groupGeometryCandidateWindowRows = groupGeometryCandidateWindows;

type ValidatedCell = {
  readonly cell: GeometryCell;
  readonly parent: VisionTextObservation;
};

type ValidatedRow = {
  readonly row: GeometryRow;
  readonly cells: readonly ValidatedCell[];
};

type IndexedValidatedRow = ValidatedRow & {
  readonly physicalIndex: number;
};

type PhysicalRowEntry = {
  readonly row: GeometryRow;
  readonly originalIndex: number;
  readonly physicalIndex: number;
  readonly validated: ValidatedRow | null;
};

function validateRowCells(
  row: GeometryRow,
  parents: ReadonlyMap<string, VisionTextObservation>,
): ValidatedRow | null {
  if (row.id.length === 0 || row.cells.length === 0 || row.sourceObservationIds.length === 0)
    return null;
  if (
    new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length ||
    row.sourceObservationIds.some((id) => id.length === 0)
  )
    return null;
  const sourceIds = new Set(row.sourceObservationIds);
  const seenCellIds = new Set<string>();
  const selected: ValidatedCell[] = [];
  for (const cell of row.cells) {
    if (
      cell.id.length === 0 ||
      cell.id.length > 96 ||
      seenCellIds.has(cell.id) ||
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
      cell.parentId.length === 0 ||
      cell.parentId !== parent.id ||
      cell.sourceStart > parent.text.length ||
      cell.sourceEnd > parent.text.length ||
      cell.pageIndex !== parent.pageIndex ||
      cell.pageIndex !== row.pageIndex ||
      cell.text !== parent.text.slice(cell.sourceStart, cell.sourceEnd) ||
      !validBox(cell.boundingBox)
    )
      return null;
    seenCellIds.add(cell.id);
    selected.push({ cell, parent });
  }
  if (
    selected.length === 0 ||
    new Set(selected.map(({ cell }) => cell.sourceObservationId)).size !== sourceIds.size ||
    ![...sourceIds].every((id) => selected.some(({ cell }) => cell.sourceObservationId === id))
  )
    return null;
  return { row, cells: selected.sort(compareValidatedCells) };
}

type ResultAnchor = {
  readonly cell: GeometryCell;
  readonly kind: GeometryResultAnchorKind;
};

function resultAnchors(row: GeometryRow): readonly ResultAnchor[] {
  const anchors: ResultAnchor[] = [];
  const seen = new Set<string>();
  for (const cell of row.cells) {
    if (seen.has(cell.id) || isMetadataCell(cell.text)) continue;
    const kind = geometryResultAnchorKind(cell.text);
    if (kind === null) continue;
    seen.add(cell.id);
    anchors.push({ cell, kind });
  }
  return anchors.sort(compareAnchors);
}

export function geometryResultAnchorKind(text: string): GeometryResultAnchorKind | null {
  const normalized = normalizeCellText(text);
  if (normalized.length === 0 || DATE_ONLY.test(normalized) || UNIT_ONLY.test(normalized))
    return null;
  if (RANGE_VALUE.test(normalized)) return null;
  if (STRICT_NUMERIC.test(normalized)) return 'numeric';
  if (isExtractionCategoricalResultValue(normalized)) return 'categorical';
  return null;
}

function plausibleLabelCells(row: GeometryRow): readonly GeometryCell[] {
  const candidates = enumerateGeometryFieldCandidates(row).roles.label.candidates;
  const candidateIds = new Set(candidates.map((candidate) => candidate.cellId));
  return row.cells
    .filter((cell) => candidateIds.has(cell.id) && isGeometryCandidateLabelText(cell.text))
    .sort(compareCells);
}

export function isGeometryCandidateLabelText(text: string): boolean {
  const normalized = normalizeCellText(text);
  const wordCount = normalized.split(' ').filter(Boolean).length;
  return (
    normalized.length > 0 &&
    normalized.length <= 96 &&
    wordCount <= 8 &&
    /\p{L}/u.test(normalized) &&
    !/[.!?;:]/u.test(normalized) &&
    !DATE_ONLY.test(normalized) &&
    !UNIT_ONLY.test(normalized) &&
    !RANGE_VALUE.test(normalized) &&
    !FLAG_ONLY.test(normalized) &&
    !PROSE_METADATA_PREFIX.test(normalized) &&
    !isMetadataCell(normalized)
  );
}

function isMetadataCell(text: string): boolean {
  const normalized = normalizeCellText(text);
  if (METADATA_LABELS.has(normalized)) return true;
  return /^(?:page|página|lapas)\s+\d+(?:\s+of\s+\d+)?$/iu.test(normalized);
}

function immediateAdjacentLabelRow(
  row: IndexedValidatedRow,
  physicalRows: readonly PhysicalRowEntry[],
  maxAdjacentRowGap: number,
): ValidatedRow | null {
  const choices: ValidatedRow[] = [];
  for (const candidateIndex of [row.physicalIndex - 1, row.physicalIndex + 1]) {
    const candidate = physicalRows[candidateIndex];
    const validated = candidate?.validated;
    if (
      validated !== null &&
      validated !== undefined &&
      resultAnchors(validated.row).length === 0 &&
      plausibleLabelCells(validated.row).length > 0 &&
      plausibleLabelCells(validated.row).some((label) => labelIsLeftOfAnchor(label, row.row)) &&
      tightlyAdjacent(row, validated, maxAdjacentRowGap)
    )
      choices.push(validated);
  }
  return choices.sort(compareValidatedRows)[0] ?? null;
}

function labelIsLeftOfAnchor(label: GeometryCell, row: GeometryRow): boolean {
  const anchors = resultAnchors(row);
  return anchors.some(
    (anchor) =>
      label.boundingBox.x + label.boundingBox.width / 2 <
      anchor.cell.boundingBox.x + anchor.cell.boundingBox.width / 2,
  );
}

function tightlyAdjacent(left: ValidatedRow, right: ValidatedRow, maxGap: number): boolean {
  if (contextKey(left.row) !== contextKey(right.row)) return false;
  const leftBox = rowBox(left.row);
  const rightBox = rowBox(right.row);
  const top = Math.min(leftBox.y, rightBox.y);
  const bottom = Math.max(leftBox.y + leftBox.height, rightBox.y + rightBox.height);
  const overlap = Math.max(
    0,
    Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height) -
      Math.max(leftBox.y, rightBox.y),
  );
  const gap = Math.max(
    0,
    Math.max(leftBox.y, rightBox.y) -
      Math.min(leftBox.y + leftBox.height, rightBox.y + rightBox.height),
  );
  const typicalHeight = Math.max(0.000001, Math.min(leftBox.height, rightBox.height));
  return gap <= maxGap && (overlap / typicalHeight >= 0.15 || bottom - top <= typicalHeight * 3.2);
}

type SelectedWindow = {
  readonly cells: readonly GeometryCell[];
  readonly provisionalSourceFields: ExtractionSemanticFieldSelection;
  readonly ambiguousSourceRoles: readonly GeometryFieldRole[];
};

function selectWindowCells(
  selectedRows: readonly ValidatedRow[],
  anchor: GeometryCell,
  labels: readonly GeometryCell[],
  anchorRow: GeometryRow,
): SelectedWindow | null {
  const cells = selectedRows.flatMap((row) => row.cells.map(({ cell }) => cell));
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const unique = [...byId.values()];
  const selected = new Map<string, GeometryCell>();
  const add = (cell: GeometryCell | undefined) => {
    if (cell === undefined || !byId.has(cell.id)) return false;
    if (selected.has(cell.id)) return true;
    if (selected.size >= GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS) return false;
    selected.set(cell.id, cell);
    return true;
  };

  add(anchor);
  // Laboratory rows commonly place method/reference prose immediately beside the result while
  // the analyte label starts at the row's leading edge. Prefer labels whose center is left of the
  // anchor's center, then the leftmost such source cell. A center comparison keeps long legitimate
  // labels eligible without letting proximity systematically relabel wide rows with a method
  // fragment. Additional plausible labels remain bounded and visible as review ambiguity.
  const leftLabels = labels.filter(
    (label) =>
      label.boundingBox.x + label.boundingBox.width / 2 <
      anchor.boundingBox.x + anchor.boundingBox.width / 2,
  );
  const preferredLabelIds = new Set(
    (leftLabels.length > 0 ? leftLabels : labels).map(({ id }) => id),
  );
  const rankedLabels = [...labels].sort((left, right) => {
    const preference =
      Number(preferredLabelIds.has(right.id)) - Number(preferredLabelIds.has(left.id));
    if (preference !== 0) return preference;
    return (
      left.boundingBox.x - right.boundingBox.x ||
      right.boundingBox.width - left.boundingBox.width ||
      compareCells(left, right)
    );
  });
  const selectedLabel = rankedLabels[0];
  add(selectedLabel);
  for (const cell of rankedLabels.slice(1))
    if (selected.size < GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS) add(cell);

  const fieldRoles: readonly GeometryFieldRole[] = ['unit', 'reference', 'flag'];
  const fieldCandidates = enumerateGeometryFieldCandidates(anchorRow).roles;
  const selectedOptionalFields: Partial<Record<GeometryFieldRole, GeometryCell>> = {};
  for (const role of fieldRoles) {
    const ranked = fieldCandidates[role].candidates
      .map((candidate) => byId.get(candidate.cellId))
      .filter(
        (cell): cell is GeometryCell =>
          cell !== undefined && cell.id !== anchor.id && !selected.has(cell.id),
      )
      .sort(
        (left, right) =>
          horizontalDistance(left, anchor) - horizontalDistance(right, anchor) ||
          compareCells(left, right),
      );
    const selectedField = ranked[0];
    if (add(selectedField) && selectedField !== undefined)
      selectedOptionalFields[role] = selectedField;
  }
  // If a split label came from the adjacent row, retain its supporting cells only after the
  // anchor's own row has been considered. This prevents a neighboring result from flooding the
  // selector window.
  for (const cell of unique.sort(compareCells)) {
    if (selected.size >= GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS) break;
    if (cell.id === anchor.id || isMetadataCell(cell.text)) continue;
    if (selected.has(cell.id)) continue;
    if (geometryResultAnchorKind(cell.text) !== null) continue;
    add(cell);
  }
  const result = [...selected.values()].sort(compareCells);
  if (
    result.length > GEOMETRY_CANDIDATE_WINDOW_MAX_CELLS ||
    !result.some((cell) => cell.id === anchor.id) ||
    !result.some((cell) => labels.some((label) => label.id === cell.id)) ||
    new Set(result.map((cell) => cell.id)).size !== result.length
  )
    return null;
  if (selectedLabel === undefined) return null;
  const provisionalSourceFields: ExtractionSemanticFieldSelection = {
    label: selectedLabel.id,
    value: anchor.id,
    unit: selectedOptionalFields.unit?.id ?? null,
    referenceInterval: selectedOptionalFields.reference?.id ?? null,
    flag: selectedOptionalFields.flag?.id ?? null,
  };
  const selectedIds = Object.values(provisionalSourceFields).filter(
    (value): value is string => value !== null,
  );
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !result.some((cell) => cell.id === id))
  )
    return null;
  // Ambiguity belongs to the exact bounded window handed to the mapper, not just the original
  // row subset used to rank its provisional fields. Supporting source cells retained above can
  // still look role-shaped to the strict projector (for example explanatory prose can be a broad
  // geometry label candidate while remaining ineligible for model selection). Declare that final
  // ambiguity explicitly so the projector stays fail-closed without discarding the whole row.
  const boundedFieldCandidates = enumerateGeometryFieldCandidates({
    ...anchorRow,
    sourceObservationIds: [...new Set(result.map((cell) => cell.sourceObservationId))],
    parentIds: [...new Set(result.map((cell) => cell.parentId))],
    cells: result,
  }).roles;
  const ambiguousSourceRoles: GeometryFieldRole[] = [];
  if (boundedFieldCandidates.label.resolution === 'ambiguous') ambiguousSourceRoles.push('label');
  for (const role of fieldRoles)
    if (boundedFieldCandidates[role].resolution === 'ambiguous') ambiguousSourceRoles.push(role);
  return { cells: result, provisionalSourceFields, ambiguousSourceRoles };
}

function createCandidateWindow(
  selectedRows: readonly ValidatedRow[],
  row: ValidatedRow,
  anchor: ResultAnchor,
  window: SelectedWindow,
  parents: ReadonlyMap<string, VisionTextObservation>,
  candidateRowIds: Map<string, string>,
  physicalRowIds: Map<string, string>,
): GeometryCandidateWindowRow | null {
  const cells = window.cells;
  const sourceObservations = cells
    .map((cell) => {
      const parent = parents.get(cell.sourceObservationId);
      return parent === undefined ? null : geometryCellObservation(cell, parent);
    })
    .filter((observation): observation is VisionTextObservation => observation !== null);
  if (
    sourceObservations.length !== cells.length ||
    sourceObservations.some((observation, index) => observation.id !== cells[index]?.id)
  )
    return null;
  const physicalRowCells = selectedRows.flatMap((selected) =>
    selected.cells.map(({ cell }) => cell),
  );
  const physicalSourceKey = JSON.stringify(['physical-row', physicalRowCells, contextKey(row.row)]);
  const physicalRowId = opaqueCandidateRowId(physicalSourceKey, 'pr-');
  const physicalCollision = physicalRowIds.get(physicalRowId);
  if (physicalCollision !== undefined && physicalCollision !== physicalSourceKey) return null;
  physicalRowIds.set(physicalRowId, physicalSourceKey);
  // Bind the opaque candidate identity to the complete exact observation projection as well as
  // the physical cells. This makes inherited source-span provenance tamper-evident without
  // exposing any source identity to the model's row-local variant key.
  const sourceKey = JSON.stringify([physicalSourceKey, anchor.cell.id, sourceObservations]);
  const rowId = opaqueCandidateRowId(sourceKey);
  const collision = candidateRowIds.get(rowId);
  if (collision !== undefined && collision !== sourceKey) return null;
  candidateRowIds.set(rowId, sourceKey);
  return {
    rowId,
    physicalRowId,
    physicalRowKey: physicalSourceKey,
    physicalRowCells,
    sourceObservationIds: sourceObservations.map((observation) => observation.id),
    observations: sourceObservations,
    anchorCellId: anchor.cell.id,
    anchorKind: anchor.kind,
    context: {
      pageIndex: row.row.pageIndex,
      tableId: row.row.tableId,
      sectionId: row.row.sectionId,
      specimenKey: row.row.specimenKey,
      collectionDateKey: row.row.collectionDateKey,
    },
    sourceCells: cells,
    provisionalSourceFields: window.provisionalSourceFields,
    ambiguousSourceRoles: window.ambiguousSourceRoles,
  };
}

/**
 * Generates a deterministic opaque bookkeeping key without exposing or truncating a source ID.
 * This is not an integrity hash; the caller separately checks the full preimage for collisions.
 */
function opaqueCandidateRowId(sourceKey: string, prefix = 'gw-'): string {
  return opaqueCandidateRowIdWithPrefix(sourceKey, prefix);
}

function opaqueCandidateRowIdWithPrefix(sourceKey: string, prefix: string): string {
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

function sameGeometryCell(left: GeometryCell, right: GeometryCell): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSourceObservation(left: VisionTextObservation, right: VisionTextObservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareObservations(left: VisionTextObservation, right: VisionTextObservation): number {
  return (
    left.pageIndex - right.pageIndex ||
    left.boundingBox.y - right.boundingBox.y ||
    left.boundingBox.x - right.boundingBox.x ||
    left.id.localeCompare(right.id)
  );
}

function geometryCellObservation(
  cell: GeometryCell,
  parent: VisionTextObservation,
): VisionTextObservation {
  const sourceText = parent.text.slice(cell.sourceStart, cell.sourceEnd);
  const { spans: parentSpans, sourceSpan: parentSourceSpan, ...parentWithoutSpans } = parent;
  const sourceSpan: VisionSourceSpan = {
    id: `${cell.parentId}:${cell.sourceStart}:${cell.sourceEnd}`,
    parentObservationId: parent.id,
    start: cell.sourceStart,
    end: cell.sourceEnd,
    text: sourceText,
    boundingBox: cell.boundingBox,
    parentText: parent.text,
  };
  const sameAsParent =
    cell.sourceObservationId === parent.id &&
    cell.sourceStart === 0 &&
    cell.sourceEnd === parent.text.length;
  return {
    ...parentWithoutSpans,
    id: cell.id,
    text: sourceText,
    boundingBox: cell.boundingBox,
    alternatives: sameAsParent ? parent.alternatives : [],
    ...(sameAsParent && parentSpans === undefined
      ? {}
      : sameAsParent
        ? { spans: parentSpans }
        : {}),
    sourceSpan: sameAsParent && parentSourceSpan !== undefined ? parentSourceSpan : sourceSpan,
  };
}

function contextKey(row: GeometryRow): string {
  return candidateContextKey({
    pageIndex: row.pageIndex,
    tableId: row.tableId,
    sectionId: row.sectionId,
    specimenKey: row.specimenKey,
    collectionDateKey: row.collectionDateKey,
  });
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

function rowBox(row: GeometryRow): NormalizedBoundingBox {
  const first = row.cells[0]?.boundingBox;
  if (first === undefined) return { x: 0, y: 0, width: 0, height: 0 };
  return row.cells.slice(1).reduce(
    (box, cell) => ({
      x: Math.min(box.x, cell.boundingBox.x),
      y: Math.min(box.y, cell.boundingBox.y),
      width:
        Math.max(box.x + box.width, cell.boundingBox.x + cell.boundingBox.width) -
        Math.min(box.x, cell.boundingBox.x),
      height:
        Math.max(box.y + box.height, cell.boundingBox.y + cell.boundingBox.height) -
        Math.min(box.y, cell.boundingBox.y),
    }),
    first,
  );
}

function comparePhysicalRows(
  left: Pick<PhysicalRowEntry, 'row' | 'originalIndex'>,
  right: Pick<PhysicalRowEntry, 'row' | 'originalIndex'>,
): number {
  return (
    left.row.pageIndex - right.row.pageIndex ||
    rowBox(left.row).y - rowBox(right.row).y ||
    rowBox(left.row).x - rowBox(right.row).x ||
    left.row.id.localeCompare(right.row.id) ||
    left.originalIndex - right.originalIndex
  );
}

function compareValidatedRows(left: ValidatedRow, right: ValidatedRow): number {
  return (
    left.row.pageIndex - right.row.pageIndex ||
    rowBox(left.row).y - rowBox(right.row).y ||
    rowBox(left.row).x - rowBox(right.row).x ||
    left.row.id.localeCompare(right.row.id)
  );
}

function compareValidatedCells(left: ValidatedCell, right: ValidatedCell): number {
  return compareCells(left.cell, right.cell);
}

function compareCells(left: GeometryCell, right: GeometryCell): number {
  return (
    left.pageIndex - right.pageIndex ||
    left.boundingBox.y - right.boundingBox.y ||
    left.boundingBox.x - right.boundingBox.x ||
    left.sourceStart - right.sourceStart ||
    left.id.localeCompare(right.id)
  );
}

function compareAnchors(left: ResultAnchor, right: ResultAnchor): number {
  return compareCells(left.cell, right.cell);
}

function compareCandidates(
  left: GeometryCandidateWindowRow,
  right: GeometryCandidateWindowRow,
): number {
  return (
    left.context.pageIndex - right.context.pageIndex ||
    left.sourceCells[0]!.boundingBox.y - right.sourceCells[0]!.boundingBox.y ||
    left.sourceCells[0]!.boundingBox.x - right.sourceCells[0]!.boundingBox.x ||
    left.anchorCellId.localeCompare(right.anchorCellId)
  );
}

function compareGroups(
  left: GeometryCandidateWindowGroup,
  right: GeometryCandidateWindowGroup,
): number {
  return (
    left.context.pageIndex - right.context.pageIndex ||
    left.sourceCells[0]!.boundingBox.y - right.sourceCells[0]!.boundingBox.y ||
    left.sourceCells[0]!.boundingBox.x - right.sourceCells[0]!.boundingBox.x ||
    left.physicalRowId.localeCompare(right.physicalRowId)
  );
}

function horizontalDistance(left: GeometryCell, right: GeometryCell): number {
  const leftCenter = left.boundingBox.x + left.boundingBox.width / 2;
  const rightCenter = right.boundingBox.x + right.boundingBox.width / 2;
  return Math.abs(leftCenter - rightCenter);
}

function normalizeCellText(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/[\s\u00a0\u202f]+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function validBox(box: NormalizedBoundingBox): boolean {
  return (
    [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0
  );
}
