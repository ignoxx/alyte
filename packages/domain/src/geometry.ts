import { isExtractionCategoricalResultValue } from './extraction-value-shapes';

/**
 * Conservative reconstruction of the physical OCR lattice.
 *
 * This module deliberately knows nothing about biomarkers or clinical meaning. It only groups
 * source observations, preserves their geometry, and enumerates exact source-cell candidates for
 * a later semantic mapper. A cell's text is always a UTF-16 slice of its parent observation.
 */

export type GeometryBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type GeometrySourceSpan = {
  /** Native span identity, retained for diagnostics but not used as a cell identity. */
  readonly id?: string;
  /** Optional parent assertion from the native adapter. */
  readonly parentObservationId?: string;
  /** UTF-16 start offset in the parent observation text (inclusive). */
  readonly start: number;
  /** UTF-16 end offset in the parent observation text (exclusive). */
  readonly end: number;
  /** Vision's token box, when the native recognizer returned one. */
  readonly boundingBox?: GeometryBoundingBox;
  /** Optional assertion from a producer; the parent substring remains authoritative. */
  readonly text?: string;
};

/**
 * Ephemeral grouping authority supplied by a trusted source adapter. This is intentionally not
 * part of persisted extraction data: ordinary Vision observations must retain the conservative
 * parent-band reconstruction below.
 */
export type GeometrySpanPolicy = 'trusted-independent';

export type GeometryBoundaryContext = {
  /** A stable table identity. `null` is a deliberate boundary, not a wildcard. */
  readonly tableId?: string | null;
  readonly sectionId?: string | null;
  /** Opaque specimen context key; this module does not interpret specimen names. */
  readonly specimenKey?: string | null;
  /** Opaque collection-date context key; this module does not parse dates. */
  readonly collectionDateKey?: string | null;
};

export type GeometryTableStructure = {
  readonly kind: 'table-cell' | 'text';
  readonly tableId: string | null;
  readonly rowIndex: number | null;
  readonly columnIndex: number | null;
};

/** The smallest source shape accepted by the lattice. Extra Vision fields are intentionally fine. */
export type GeometrySourceObservation = {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: GeometryBoundingBox;
  readonly pageIndex: number;
  readonly orientation?: number;
  readonly structure?: GeometryTableStructure;
  readonly context?: GeometryBoundaryContext;
  /** Optional explicit parent for producers that split one OCR parent into observations. */
  readonly parentId?: string | null;
  /** Exact token spans in this observation's text, when available. */
  readonly spans?: readonly GeometrySourceSpan[];
  /** Trusted PDFKit spans are independently banded before physical-row reconstruction. */
  readonly spanPolicy?: GeometrySpanPolicy;
  /** Convenience fields accepted from adapters that have not nested boundary context. */
  readonly tableId?: string | null;
  readonly sectionId?: string | null;
  readonly specimenKey?: string | null;
  readonly collectionDateKey?: string | null;
};

export type GeometryUnresolvedReason =
  'invalid-token-span' | 'contradictory-y-bands' | 'too-many-y-bands' | 'invalid-table-identity';

export type GeometryCell = {
  /** Observation ID for an unsplit source cell; `parentId:start:end` for a token-derived cell. */
  readonly id: string;
  readonly parentId: string;
  readonly sourceObservationId: string;
  /** Exact parent UTF-16 substring; never normalized, translated, or model-authored. */
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly boundingBox: GeometryBoundingBox;
  readonly pageIndex: number;
  readonly columnIndex: number | null;
};

export type GeometryRow = {
  readonly id: string;
  readonly status: 'resolved' | 'unresolved';
  readonly unresolvedReason?: GeometryUnresolvedReason;
  readonly pageIndex: number;
  readonly tableId: string | null;
  readonly sectionId: string | null;
  readonly specimenKey: string | null;
  readonly collectionDateKey: string | null;
  readonly seededByTableStructure: boolean;
  readonly sourceObservationIds: readonly string[];
  readonly parentIds: readonly string[];
  readonly yBandCount: number;
  readonly cells: readonly GeometryCell[];
};

export type GeometryLattice = {
  readonly rows: readonly GeometryRow[];
  readonly unresolvedParents: readonly {
    readonly parentId: string;
    readonly sourceObservationIds: readonly string[];
    readonly reason: GeometryUnresolvedReason;
  }[];
};

export type GeometryFieldRole = 'label' | 'value' | 'unit' | 'reference' | 'flag';

export type GeometryFieldCandidate = {
  readonly cellId: string;
  readonly sourceObservationId: string;
  /** Exact cell text, copied from the lattice. */
  readonly text: string;
};

export type GeometryFieldCandidateSet = {
  readonly role: GeometryFieldRole;
  readonly candidates: readonly GeometryFieldCandidate[];
  readonly resolution: 'resolved' | 'ambiguous' | 'missing';
  readonly selectedCellId: string | null;
};

export type GeometryFieldCandidates = {
  readonly rowId: string;
  readonly sourceCellIds: readonly string[];
  readonly roles: Readonly<Record<GeometryFieldRole, GeometryFieldCandidateSet>>;
  /** True when the row cannot be safely addressed without model review. */
  readonly requiresReview: boolean;
};

type NormalizedContext = {
  readonly pageIndex: number;
  readonly tableId: string | null;
  readonly sectionId: string | null;
  readonly specimenKey: string | null;
  readonly collectionDateKey: string | null;
};

type ParentBand = {
  readonly parentId: string;
  readonly sourceObservationId: string;
  readonly observation: GeometrySourceObservation;
  readonly context: NormalizedContext;
  readonly cells: readonly GeometryCell[];
  readonly centerY: number;
  readonly boundingBox: GeometryBoundingBox;
  readonly seeded: boolean;
  readonly rowIndex: number | null;
  readonly columnIndex: number | null;
  readonly yBandIndex: number;
};

type UnresolvedParent = {
  readonly parentId: string;
  readonly sourceObservationIds: readonly string[];
  readonly context: NormalizedContext;
  readonly reason: GeometryUnresolvedReason;
};

type LooseRowGroup = {
  readonly parts: ParentBand[];
  readonly context: NormalizedContext;
};

const FIELD_ROLES: readonly GeometryFieldRole[] = ['label', 'value', 'unit', 'reference', 'flag'];

/** Reconstructs source rows/cells without making any semantic or medical claim. */
export function reconstructGeometryLattice(
  observations: readonly GeometrySourceObservation[],
): GeometryLattice {
  const bands: ParentBand[] = [];
  const unresolvedParents: UnresolvedParent[] = [];

  for (const observation of observations) {
    if (observation.text.length === 0 || observation.id.length === 0) continue;
    const context = normalizeContext(observation);
    const expanded = expandObservation(observation, context);
    if ('reason' in expanded) {
      unresolvedParents.push(expanded);
      continue;
    }
    bands.push(...expanded);
  }

  const seededRows = new Map<string, ParentBand[]>();
  const looseBands: ParentBand[] = [];
  for (const band of bands) {
    if (band.seeded && band.rowIndex !== null && band.columnIndex !== null) {
      const key = `${contextKey(band.context)}|row:${band.observation.structure?.tableId}:${band.rowIndex}`;
      const row = seededRows.get(key) ?? [];
      row.push(band);
      seededRows.set(key, row);
    } else {
      looseBands.push(band);
    }
  }

  const rows: GeometryRow[] = [];
  for (const group of seededRows.values()) {
    rows.push(buildRow(group, true));
  }

  const adaptiveLooseHeight = medianHeight(looseBands);
  const looseCellsByContext = new Map<string, GeometryCell[]>();
  for (const band of looseBands) {
    const key = contextKey(band.context);
    const cells = looseCellsByContext.get(key) ?? [];
    cells.push(...band.cells);
    looseCellsByContext.set(key, cells);
  }
  const looseAnchors = new Map<string, readonly number[]>();
  for (const [key, cells] of looseCellsByContext)
    looseAnchors.set(key, inferColumnAnchors(cells, adaptiveLooseHeight));

  const looseGroups: LooseRowGroup[] = [];
  const sortedLoose = [...looseBands].sort(compareBands);
  for (const band of sortedLoose) {
    const compatible = looseGroups.filter(
      (group) =>
        sameContext(group.context, band.context) &&
        samePhysicalBand(group.parts, band, adaptiveLooseHeight),
    );
    // The nearest compatible prior row wins. A bridging cell can merge partial groups only when
    // continuity proves they are one physical row; otherwise a new row preserves ambiguity.
    const target = nearestGroup(compatible, band);
    if (target === null) looseGroups.push({ parts: [band], context: band.context });
    else {
      // A cell can bridge two partial x-continuity groups (for example when OCR emitted the
      // label and value before the unit). Merge only groups already proven to share this exact
      // page/table/section/specimen/date context and the target's stable vertical band. A tall
      // bridge must not make adjacent physical rows appear compatible with one another.
      const mergeable = compatible.filter(
        (group) => group === target || sameLooseRowBand(group, target, adaptiveLooseHeight),
      );
      for (const group of mergeable) {
        if (group === target) continue;
        target.parts.push(...group.parts);
        const index = looseGroups.indexOf(group);
        if (index >= 0) looseGroups.splice(index, 1);
      }
      target.parts.push(band);
    }
  }
  for (const group of looseGroups)
    rows.push(buildRow(group.parts, false, looseAnchors.get(contextKey(group.context))));

  for (const unresolved of unresolvedParents) {
    rows.push({
      id: unresolvedRowId(unresolved.parentId, unresolved.reason),
      status: 'unresolved',
      unresolvedReason: unresolved.reason,
      pageIndex: unresolved.context.pageIndex,
      tableId: unresolved.context.tableId,
      sectionId: unresolved.context.sectionId,
      specimenKey: unresolved.context.specimenKey,
      collectionDateKey: unresolved.context.collectionDateKey,
      seededByTableStructure: false,
      sourceObservationIds: [...unresolved.sourceObservationIds],
      parentIds: [unresolved.parentId],
      yBandCount: 0,
      cells: [],
    });
  }

  rows.sort(compareRows);
  return {
    rows,
    unresolvedParents: unresolvedParents.map(({ parentId, sourceObservationIds, reason }) => ({
      parentId,
      sourceObservationIds: [...sourceObservationIds],
      reason,
    })),
  };
}

/** Short alias for adapters that call the operation "reconstruct". */
export const reconstructObservationLattice = reconstructGeometryLattice;

function expandObservation(
  observation: GeometrySourceObservation,
  context: NormalizedContext,
): readonly ParentBand[] | UnresolvedParent {
  const parentId = observation.parentId ?? observation.id;
  const structure = observation.structure;
  if (structure?.kind === 'table-cell' && !isValidTableStructure(observation)) {
    return {
      parentId,
      sourceObservationIds: [observation.id],
      context,
      reason: 'invalid-table-identity',
    };
  }
  const seeded =
    isValidTableStructure(observation) &&
    (observation.context?.tableId === undefined ||
      observation.context.tableId === structure?.tableId) &&
    (observation.tableId === undefined || observation.tableId === structure?.tableId);
  if (observation.spans === undefined) {
    return [
      makeBand(
        observation,
        context,
        parentId,
        [
          makeWholeObservationCell(
            observation,
            parentId,
            seeded ? (structure?.columnIndex ?? null) : null,
          ),
        ],
        seeded,
        seeded ? (structure?.rowIndex ?? null) : null,
        seeded ? (structure?.columnIndex ?? null) : null,
        0,
      ),
    ];
  }

  const spans = validateSourceSpans(observation);
  if (spans === null) {
    return {
      parentId,
      sourceObservationIds: [observation.id],
      context,
      reason: 'invalid-token-span',
    };
  }
  if (observation.spanPolicy === 'trusted-independent') {
    return spans.map((span) => {
      const cell = makeSpanCell(
        observation,
        parentId,
        span,
        seeded ? (structure?.columnIndex ?? null) : null,
      );
      return makeBand(
        observation,
        context,
        parentId,
        [cell],
        seeded,
        seeded ? (structure?.rowIndex ?? null) : null,
        seeded ? (structure?.columnIndex ?? null) : null,
        0,
        cell.boundingBox,
      );
    });
  }
  const bandGroups = groupSourceSpansIntoBands(observation, spans);
  if (bandGroups === null) {
    return {
      parentId,
      sourceObservationIds: [observation.id],
      context,
      reason:
        spans.length > 0 && countYBands(observation, spans) > 2
          ? 'too-many-y-bands'
          : 'contradictory-y-bands',
    };
  }
  return bandGroups.map((group, yBandIndex) => {
    const cells = group.map((span) =>
      makeSpanCell(observation, parentId, span, seeded ? (structure?.columnIndex ?? null) : null),
    );
    const box = unionBoxes(cells.map((cell) => cell.boundingBox));
    return makeBand(
      observation,
      context,
      parentId,
      cells,
      seeded,
      seeded ? (structure?.rowIndex ?? null) : null,
      seeded ? (structure?.columnIndex ?? null) : null,
      yBandIndex,
      box,
    );
  });
}

function makeBand(
  observation: GeometrySourceObservation,
  context: NormalizedContext,
  parentId: string,
  cells: readonly GeometryCell[],
  seeded: boolean,
  rowIndex: number | null,
  columnIndex: number | null,
  yBandIndex: number,
  boundingBox = observation.boundingBox,
): ParentBand {
  return {
    parentId,
    sourceObservationId: observation.id,
    observation,
    context,
    cells,
    centerY: boundingBox.y + boundingBox.height / 2,
    boundingBox,
    seeded,
    rowIndex,
    columnIndex,
    yBandIndex,
  };
}

function makeWholeObservationCell(
  observation: GeometrySourceObservation,
  parentId: string,
  columnIndex: number | null,
): GeometryCell {
  return {
    id: observation.id,
    parentId,
    sourceObservationId: observation.id,
    text: observation.text,
    sourceStart: 0,
    sourceEnd: observation.text.length,
    boundingBox: observation.boundingBox,
    pageIndex: observation.pageIndex,
    columnIndex,
  };
}

function makeSpanCell(
  observation: GeometrySourceObservation,
  parentId: string,
  span: GeometrySourceSpan,
  columnIndex: number | null,
): GeometryCell {
  const text = observation.text.slice(span.start, span.end);
  // `validateSourceSpans` proves this relation; keeping the assertion adjacent to construction
  // makes future changes unable to accidentally replace source text with a normalized token.
  if (text !== observation.text.slice(span.start, span.end))
    throw new Error('Geometry cell text must equal its parent UTF-16 substring');
  return {
    id: `${parentId}:${span.start}:${span.end}`,
    parentId,
    sourceObservationId: observation.id,
    text,
    sourceStart: span.start,
    sourceEnd: span.end,
    boundingBox:
      span.boundingBox ?? proportionalBox(observation.boundingBox, span, observation.text.length),
    pageIndex: observation.pageIndex,
    columnIndex,
  };
}

function validateSourceSpans(
  observation: GeometrySourceObservation,
): readonly GeometrySourceSpan[] | null {
  const spans = [...(observation.spans ?? [])].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const parentId = observation.parentId ?? observation.id;
  if (spans.length === 0) return null;
  let priorEnd = -1;
  const ids = new Set<string>();
  for (const span of spans) {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end > observation.text.length ||
      span.start >= span.end ||
      span.start < priorEnd
    )
      return null;
    if (span.parentObservationId !== undefined && span.parentObservationId !== parentId)
      return null;
    const id = `${parentId}:${span.start}:${span.end}`;
    if (ids.has(id)) return null;
    ids.add(id);
    if (span.text !== undefined && span.text !== observation.text.slice(span.start, span.end))
      return null;
    if (span.boundingBox !== undefined && !validBox(span.boundingBox)) return null;
    priorEnd = span.end;
  }
  return spans;
}

function groupSourceSpansIntoBands(
  observation: GeometrySourceObservation,
  spans: readonly GeometrySourceSpan[],
): readonly (readonly GeometrySourceSpan[])[] | null {
  if (spans.length === 0) return [[]];
  const adaptiveHeight = median(
    spans.map((span) => span.boundingBox?.height ?? observation.boundingBox.height),
  );
  const groups: { spans: GeometrySourceSpan[]; box: GeometryBoundingBox }[] = [];
  for (const span of spans) {
    const box =
      span.boundingBox ?? proportionalBox(observation.boundingBox, span, observation.text.length);
    const matches = groups.filter((group) => bandMatches(group.box, box, adaptiveHeight));
    if (matches.length > 1) return null;
    const match = matches[0];
    if (match === undefined) groups.push({ spans: [span], box });
    else {
      match.spans.push(span);
      match.box = unionBoxes([match.box, box]);
    }
  }
  if (groups.length > 2) return null;
  groups.sort((left, right) => left.box.y - right.box.y || left.box.x - right.box.x);
  // A pair that is neither one band nor clearly separated is contradictory rather than a row
  // that this small deterministic routine should guess at.
  if (groups.length === 2) {
    const first = groups[0]!.box;
    const second = groups[1]!.box;
    const gap =
      Math.max(first.y, second.y) - Math.min(first.y + first.height, second.y + second.height);
    if (gap < adaptiveHeight * 0.2) return null;
  }
  return groups.map((group) => group.spans.sort((left, right) => left.start - right.start));
}

function countYBands(
  observation: GeometrySourceObservation,
  spans: readonly GeometrySourceSpan[],
): number {
  const groups: GeometryBoundingBox[] = [];
  const height = median(
    spans.map((span) => span.boundingBox?.height ?? observation.boundingBox.height),
  );
  for (const span of spans) {
    const box = span.boundingBox ?? observation.boundingBox;
    const index = groups.findIndex((group) => bandMatches(group, box, height));
    if (index === -1) groups.push(box);
    else groups[index] = unionBoxes([groups[index]!, box]);
  }
  return groups.length;
}

function bandMatches(
  left: GeometryBoundingBox,
  right: GeometryBoundingBox,
  adaptiveHeight: number,
): boolean {
  const overlap =
    verticalOverlap(left, right) / Math.max(0.000001, Math.min(left.height, right.height));
  const baselineDistance = Math.abs(left.y + left.height / 2 - (right.y + right.height / 2));
  return overlap >= 0.2 || baselineDistance <= adaptiveHeight * 0.7;
}

function isValidTableStructure(observation: GeometrySourceObservation): boolean {
  const structure = observation.structure;
  return (
    structure?.kind === 'table-cell' &&
    typeof structure.tableId === 'string' &&
    structure.tableId.length > 0 &&
    typeof structure.rowIndex === 'number' &&
    Number.isInteger(structure.rowIndex) &&
    structure.rowIndex >= 0 &&
    typeof structure.columnIndex === 'number' &&
    Number.isInteger(structure.columnIndex) &&
    structure.columnIndex >= 0
  );
}

function normalizeContext(observation: GeometrySourceObservation): NormalizedContext {
  const structure = observation.structure;
  const tableId = firstDefined(
    observation.context?.tableId,
    observation.tableId,
    structure?.tableId,
    null,
  );
  return {
    pageIndex: observation.pageIndex,
    tableId,
    sectionId: firstDefined(observation.context?.sectionId, observation.sectionId, null),
    specimenKey: firstDefined(observation.context?.specimenKey, observation.specimenKey, null),
    collectionDateKey: firstDefined(
      observation.context?.collectionDateKey,
      observation.collectionDateKey,
      null,
    ),
  };
}

function firstDefined(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) if (value !== undefined) return value;
  return null;
}

function contextKey(context: NormalizedContext): string {
  return JSON.stringify([
    context.pageIndex,
    context.tableId,
    context.sectionId,
    context.specimenKey,
    context.collectionDateKey,
  ]);
}

function sameContext(left: NormalizedContext, right: NormalizedContext): boolean {
  return contextKey(left) === contextKey(right);
}

function buildRow(
  parts: readonly ParentBand[],
  seeded: boolean,
  columnAnchors?: readonly number[],
): GeometryRow {
  const sortedParts = [...parts].sort(compareBands);
  const first = sortedParts[0]!;
  const cells = assignLooseColumns(
    sortedParts.flatMap((part) => part.cells),
    seeded,
    medianHeight(sortedParts),
    columnAnchors,
  );
  const sourceObservationIds = uniqueInOrder(cells.map((cell) => cell.sourceObservationId));
  const parentIds = uniqueInOrder(cells.map((cell) => cell.parentId));
  // `yBandIndex` describes a cell's position inside its OCR parent. Once parts are reconstructed
  // into a physical row, that local index is no longer a physical-band count: a valid row made
  // entirely from the parent's second band still has one final y-band. Count the final cells so
  // downstream safety gates inspect the geometry they will actually consume.
  const yBandCount = countFinalPhysicalYBands(cells);
  return {
    id: seeded
      ? `row:${contextKey(first.context)}:${first.rowIndex}`
      : `row:${contextKey(first.context)}:${parentIds[0] ?? 'unknown'}:${first.yBandIndex}:${first.boundingBox.y}`,
    status: 'resolved',
    pageIndex: first.context.pageIndex,
    tableId: first.context.tableId,
    sectionId: first.context.sectionId,
    specimenKey: first.context.specimenKey,
    collectionDateKey: first.context.collectionDateKey,
    seededByTableStructure: seeded,
    sourceObservationIds,
    parentIds,
    yBandCount,
    cells,
  };
}

/**
 * Counts vertical bands in the final row cells, keeping the result conservative around tall or
 * contradictory boxes. Tall cells are excluded from the representatives when ordinary-height
 * cells exist; the independent extraction safety gate remains responsible for validating whether
 * a tall cell can safely belong to the row at all.
 */
function countFinalPhysicalYBands(cells: readonly GeometryCell[]): number {
  if (cells.length === 0) return 0;
  const typicalHeight = median(cells.map((cell) => cell.boundingBox.height));
  if (!(typicalHeight > 0) || !Number.isFinite(typicalHeight)) return cells.length;

  const representatives = cells.filter((cell) => cell.boundingBox.height <= typicalHeight * 1.8);
  const boxes = (representatives.length > 0 ? representatives : cells)
    .map((cell) => cell.boundingBox)
    .sort(
      (left, right) =>
        left.y - right.y ||
        left.x - right.x ||
        left.height - right.height ||
        left.width - right.width,
    );
  const bands: GeometryBoundingBox[] = [];
  for (const box of boxes) {
    const matches = bands.filter((band) => bandMatches(band, box, typicalHeight));
    // More than one matching band is contradictory geometry. Keep this count conservative so an
    // independent admission gate cannot mistake an ambiguous aggregate for one physical row.
    if (matches.length > 1) return Math.max(2, bands.length);
    const match = matches[0];
    if (match === undefined) bands.push(box);
    else {
      const index = bands.indexOf(match);
      bands[index] = unionBoxes([match, box]);
    }
  }
  return Math.max(1, bands.length);
}

function assignLooseColumns(
  cells: readonly GeometryCell[],
  seeded: boolean,
  adaptiveHeight: number,
  columnAnchors?: readonly number[],
): readonly GeometryCell[] {
  if (seeded) return [...cells].sort(compareCells);
  const sorted = [...cells].sort(
    (left, right) => left.boundingBox.x - right.boundingBox.x || left.id.localeCompare(right.id),
  );
  const anchors =
    columnAnchors === undefined ? inferColumnAnchors(sorted, adaptiveHeight) : [...columnAnchors];
  return sorted
    .map((cell) => ({
      ...cell,
      columnIndex: nearestAnchor(cell.boundingBox.x, anchors),
    }))
    .sort(compareCells);
}

function inferColumnAnchors(
  cells: readonly GeometryCell[],
  adaptiveHeight: number,
): readonly number[] {
  const sorted = [...cells].sort(
    (left, right) => left.boundingBox.x - right.boundingBox.x || left.id.localeCompare(right.id),
  );
  const gapLimit = xContinuityGap(adaptiveHeight);
  const anchors: number[] = [];
  for (const cell of sorted) {
    const prior = anchors.at(-1);
    if (prior === undefined || cell.boundingBox.x - prior > gapLimit)
      anchors.push(cell.boundingBox.x);
    else anchors[anchors.length - 1] = (prior + cell.boundingBox.x) / 2;
  }
  return anchors;
}

function nearestAnchor(x: number, anchors: readonly number[]): number | null {
  if (anchors.length === 0) return null;
  let bestIndex = 0;
  let bestDistance = Math.abs(x - anchors[0]!);
  for (let index = 1; index < anchors.length; index += 1) {
    const distance = Math.abs(x - anchors[index]!);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

function samePhysicalBand(
  parts: readonly ParentBand[],
  candidate: ParentBand,
  adaptiveHeight: number,
): boolean {
  const stable = stableBand(parts);
  const vertical = loosePhysicalBandMatches(
    stable.boundingBox,
    candidate.boundingBox,
    adaptiveHeight,
  );
  const trustedIndependent =
    candidate.observation.spanPolicy === 'trusted-independent' &&
    parts.every((part) => part.observation.spanPolicy === 'trusted-independent');
  const sharesTrustedVisualLine =
    candidate.sourceObservationId === stable.sourceObservationId ||
    (candidate.observation.spans === undefined && stable.observation.spans === undefined);
  const strictlyAligned =
    trustedIndependent &&
    sharesTrustedVisualLine &&
    strictlyAlignedPhysicalBand(stable.boundingBox, candidate.boundingBox);
  // PDFKit can expose every visible table cell as a separate source line. Those trusted lines
  // still share one exact baseline, but cannot satisfy `sharesTrustedVisualLine` because each
  // cell has a different parent observation. Allow only the strongly-overlapping case here;
  // nearby source lines with a small baseline offset remain separate unless they share a parent.
  const trustedCellsShareBaseline =
    trustedIndependent &&
    strictlyOverlappingPhysicalBand(stable.boundingBox, candidate.boundingBox);
  if (!vertical && !strictlyAligned) return false;
  if (strictlyAligned || trustedCellsShareBaseline) return true;
  return parts.some((part) => {
    const left = part.boundingBox;
    const right = candidate.boundingBox;
    const gap = horizontalGap(left, right);
    return gap <= xContinuityGap(adaptiveHeight) || horizontalOverlap(left, right) > 0;
  });
}

function strictlyOverlappingPhysicalBand(
  left: GeometryBoundingBox,
  right: GeometryBoundingBox,
): boolean {
  const minimumHeight = Math.max(0.000001, Math.min(left.height, right.height));
  const overlap = verticalOverlap(left, right) / minimumHeight;
  return overlap >= 0.55;
}

/**
 * Trusted cells from one PDFKit source line may be separated by a full table-column gap and may
 * report different glyph boxes for the same visual baseline. The caller restricts this fallback
 * to one span-bearing source observation (or the synthetic/no-span compatibility path), so the
 * bounded baseline offset cannot join independently proven adjacent PDF lines.
 */
function strictlyAlignedPhysicalBand(
  left: GeometryBoundingBox,
  right: GeometryBoundingBox,
): boolean {
  const minimumHeight = Math.max(0.000001, Math.min(left.height, right.height));
  const maximumHeight = Math.max(left.height, right.height);
  const heightRatio = maximumHeight / minimumHeight;
  if (heightRatio > 1.8) return false;
  const overlap = verticalOverlap(left, right) / minimumHeight;
  const centerDistance = Math.abs(left.y + left.height / 2 - (right.y + right.height / 2));
  return overlap >= 0.55 || centerDistance <= maximumHeight * 1.5;
}

/**
 * Loose OCR rows need a stricter tall-box rule than token-band splitting. A tall box can overlap
 * two rows, but it is assigned only to the first short band it reaches; ordinary overlap remains
 * appropriate for same-parent token grouping, where the source producer already supplied a
 * bounded y-band.
 */
function loosePhysicalBandMatches(
  left: GeometryBoundingBox,
  right: GeometryBoundingBox,
  adaptiveHeight: number,
): boolean {
  const tallThreshold = adaptiveHeight * 1.8;
  if (left.height > tallThreshold || right.height > tallThreshold) {
    const tall = left.height > right.height ? left : right;
    const short = tall === left ? right : left;
    const shortCenter = short.y + short.height / 2;
    return shortCenter >= tall.y && shortCenter - tall.y <= adaptiveHeight * 1.25;
  }
  return bandMatches(left, right, adaptiveHeight);
}

/**
 * Compares groups without allowing a tall bridge in either group to widen its y-band.
 *
 * A loose row can contain several horizontally adjacent OCR parts, so vertical compatibility
 * must be based on one representative part while horizontal continuity is checked separately.
 * The shortest part is the least likely to overlap a neighbouring physical row and is stable
 * under input ordering because ties fall back to the existing deterministic band ordering.
 */
function sameLooseRowBand(
  left: LooseRowGroup,
  right: LooseRowGroup,
  adaptiveHeight: number,
): boolean {
  return bandMatches(
    stableBand(left.parts).boundingBox,
    stableBand(right.parts).boundingBox,
    adaptiveHeight,
  );
}

function stableBand(parts: readonly ParentBand[]): ParentBand {
  return [...parts].sort(
    (left, right) =>
      left.boundingBox.height - right.boundingBox.height || compareBands(left, right),
  )[0]!;
}

function nearestGroup(
  groups: readonly LooseRowGroup[],
  candidate: ParentBand,
): LooseRowGroup | null {
  let best: LooseRowGroup | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const groupCenter = median(group.parts.map((part) => part.centerY));
    const nextDistance = Math.abs(groupCenter - candidate.centerY);
    if (nextDistance < distance) {
      best = group;
      distance = nextDistance;
    }
  }
  return best;
}

function compareBands(left: ParentBand, right: ParentBand): number {
  return (
    left.context.pageIndex - right.context.pageIndex ||
    left.boundingBox.y - right.boundingBox.y ||
    left.boundingBox.x - right.boundingBox.x ||
    left.parentId.localeCompare(right.parentId) ||
    left.yBandIndex - right.yBandIndex
  );
}

function compareCells(left: GeometryCell, right: GeometryCell): number {
  return (
    (left.columnIndex ?? Number.MAX_SAFE_INTEGER) -
      (right.columnIndex ?? Number.MAX_SAFE_INTEGER) ||
    left.boundingBox.x - right.boundingBox.x ||
    left.sourceStart - right.sourceStart ||
    left.id.localeCompare(right.id)
  );
}

function compareRows(left: GeometryRow, right: GeometryRow): number {
  const leftY = left.cells[0]?.boundingBox.y ?? Number.POSITIVE_INFINITY;
  const rightY = right.cells[0]?.boundingBox.y ?? Number.POSITIVE_INFINITY;
  const leftX = left.cells[0]?.boundingBox.x ?? Number.POSITIVE_INFINITY;
  const rightX = right.cells[0]?.boundingBox.x ?? Number.POSITIVE_INFINITY;
  return (
    left.pageIndex - right.pageIndex ||
    leftY - rightY ||
    leftX - rightX ||
    left.tableId?.localeCompare(right.tableId ?? '') ||
    left.sectionId?.localeCompare(right.sectionId ?? '') ||
    left.collectionDateKey?.localeCompare(right.collectionDateKey ?? '') ||
    left.id.localeCompare(right.id)
  );
}

function unresolvedRowId(parentId: string, reason: GeometryUnresolvedReason): string {
  return `unresolved:${parentId}:${reason}`;
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function validBox(box: GeometryBoundingBox): boolean {
  return (
    [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0
  );
}

function proportionalBox(
  parent: GeometryBoundingBox,
  span: GeometrySourceSpan,
  textLength: number,
): GeometryBoundingBox {
  const startRatio = textLength === 0 ? 0 : span.start / textLength;
  const endRatio = textLength === 0 ? 1 : span.end / textLength;
  return {
    x: parent.x + parent.width * startRatio,
    y: parent.y,
    width: Math.max(0.000001, parent.width * (endRatio - startRatio)),
    height: parent.height,
  };
}

function unionBoxes(boxes: readonly GeometryBoundingBox[]): GeometryBoundingBox {
  const first = boxes[0] ?? { x: 0, y: 0, width: 0.000001, height: 0.000001 };
  const right = Math.max(...boxes.map((box) => box.x + box.width), first.x + first.width);
  const bottom = Math.max(...boxes.map((box) => box.y + box.height), first.y + first.height);
  const x = Math.min(...boxes.map((box) => box.x), first.x);
  const y = Math.min(...boxes.map((box) => box.y), first.y);
  return { x, y, width: right - x, height: bottom - y };
}

function verticalOverlap(left: GeometryBoundingBox, right: GeometryBoundingBox): number {
  return Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
}

function horizontalOverlap(left: GeometryBoundingBox, right: GeometryBoundingBox): number {
  return Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
}

function horizontalGap(left: GeometryBoundingBox, right: GeometryBoundingBox): number {
  return Math.max(
    0,
    Math.max(left.x, right.x) - Math.min(left.x + left.width, right.x + right.width),
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function medianHeight(parts: readonly ParentBand[]): number {
  return median(parts.map((part) => part.boundingBox.height));
}

function xContinuityGap(adaptiveHeight: number): number {
  return Math.max(0.2, Math.min(0.45, adaptiveHeight * 8));
}

function isNumericCell(text: string): boolean {
  return /^[<>≤≥]?\s*[+-]?(?:(?:\d[\d\s\u00a0\u202f.,]*)|(?:\.\d+))\s*(?:[a-zµμ%]+(?:\s*\/\s*[a-zµμ%]+)?)?$/iu.test(
    text.trim(),
  );
}

function isUnitCell(text: string): boolean {
  return /^(?:%|(?:[µμu]?g|mg|ng|pg|fg|mmol|mol|nmol|pmol|g|kg|U|IU|fL)(?:\s*\/\s*(?:dL|L|mL|mol|kg))?)$/iu.test(
    text.trim(),
  );
}

function isReferenceCell(text: string): boolean {
  return (
    /^(?:[<>≤≥]\s*)?[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+)\s*(?:-|–|—|to)\s*[<>≤≥]?\s*[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+)$/iu.test(
      text.trim(),
    ) || /^[<>≤≥]\s*[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+)$/u.test(text.trim())
  );
}

function isRangeCell(text: string): boolean {
  return /(?:-|–|—|\bto\b)/iu.test(text.trim()) && isReferenceCell(text);
}

function isCategoricalValueCell(text: string): boolean {
  return isExtractionCategoricalResultValue(text);
}

function isFlagCell(text: string): boolean {
  return /^(?:h|l|n|high|low|normal|abnormal)$/iu.test(text.trim());
}

function candidatesForRole(
  role: GeometryFieldRole,
  cells: readonly GeometryCell[],
): readonly GeometryFieldCandidate[] {
  const candidates = cells.filter((cell) => {
    const text = cell.text.trim();
    if (text.length === 0) return false;
    if (role === 'value')
      return (isNumericCell(text) && !isRangeCell(text)) || isCategoricalValueCell(text);
    if (role === 'unit') return isUnitCell(text);
    if (role === 'reference') return isReferenceCell(text) && isRangeCell(text);
    if (role === 'flag') return isFlagCell(text);
    return (
      /\p{L}/u.test(text) &&
      !isNumericCell(text) &&
      !isUnitCell(text) &&
      !isReferenceCell(text) &&
      !isFlagCell(text) &&
      !isCategoricalValueCell(text)
    );
  });
  return candidates.map((cell) => ({
    cellId: cell.id,
    sourceObservationId: cell.sourceObservationId,
    text: cell.text,
  }));
}

/** Enumerates exact source-cell roles for one reconstructed row. */
export function enumerateGeometryFieldCandidates(row: GeometryRow): GeometryFieldCandidates {
  const roles = Object.fromEntries(
    FIELD_ROLES.map((role) => {
      const candidates = row.status === 'resolved' ? candidatesForRole(role, row.cells) : [];
      return [
        role,
        {
          role,
          candidates,
          resolution:
            candidates.length === 0
              ? 'missing'
              : candidates.length === 1
                ? 'resolved'
                : 'ambiguous',
          selectedCellId: candidates.length === 1 ? candidates[0]!.cellId : null,
        },
      ];
    }),
  ) as Record<GeometryFieldRole, GeometryFieldCandidateSet>;

  // One physical source cell cannot simultaneously be a uniquely resolved label and value. Keep
  // both explicit for the semantic mapper rather than parsing or inventing substrings here.
  const uniqueByCell = new Map<string, GeometryFieldRole[]>();
  for (const role of FIELD_ROLES) {
    const selected = roles[role].selectedCellId;
    if (selected !== null)
      uniqueByCell.set(selected, [...(uniqueByCell.get(selected) ?? []), role]);
  }
  for (const roleList of uniqueByCell.values()) {
    if (roleList.length < 2) continue;
    for (const role of roleList) {
      const current = roles[role];
      roles[role] = { ...current, resolution: 'ambiguous', selectedCellId: null };
    }
  }

  const requiresReview =
    row.status === 'unresolved' ||
    FIELD_ROLES.some((role) => roles[role].resolution === 'ambiguous') ||
    roles.label.resolution === 'missing' ||
    roles.value.resolution === 'missing';
  return {
    rowId: row.id,
    sourceCellIds: row.cells.map((cell) => cell.id),
    roles,
    requiresReview,
  };
}

/** Enumerates candidates for every row in deterministic physical-row order. */
export function enumerateGeometryFieldCandidatesForLattice(
  lattice: GeometryLattice,
): readonly GeometryFieldCandidates[] {
  return lattice.rows.map(enumerateGeometryFieldCandidates);
}

/** Short alias for semantic-mapper adapters. */
export const enumerateFieldCandidates = enumerateGeometryFieldCandidates;
