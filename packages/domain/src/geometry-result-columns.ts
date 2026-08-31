import type { GeometryCell, GeometryLattice, GeometryRow } from './geometry';
import type {
  GeometryCandidateContext,
  GeometryCandidateWindowGroup,
  GeometryCandidateWindowRow,
} from './geometry-candidate-windows';
import { geometryResultAnchorKind } from './geometry-candidate-windows';

/**
 * Result-column evidence is deliberately ephemeral. It narrows exact source variants for the
 * current extraction pass, but it never becomes report provenance or a persisted table identity.
 */
export type GeometryResultColumnAdmission = {
  readonly groups: readonly GeometryCandidateWindowGroup[];
  readonly reviewGroups: readonly GeometryCandidateWindowGroup[];
  /** Rows proven to have no anchor in an applied Result column. Source data remains untouched. */
  readonly excludedGroups: readonly GeometryCandidateWindowGroup[];
  /** Result-column rows that had no safe label-bearing candidate group and must stay reviewable. */
  readonly unrepresentedRows: readonly GeometryResultColumnReviewRow[];
};

export type GeometryResultColumnReviewRow = {
  readonly physicalRow: GeometryRow;
  readonly anchorCellIds: readonly string[];
};

export type GeometryResultColumnAdmissionOptions = {
  /** Trusted PDF text can use all reviewed Result headers on one page as a shared column map. */
  readonly scope?: 'local-corridor' | 'page-wide';
  /** Maximum horizontal distance from a loose-layout Result header, in normalized page units. */
  readonly horizontalTolerance?: number;
  /** Maximum vertical gap that one loose-layout header corridor may cross. */
  readonly maxLooseRowGap?: number;
  /** A one-row coincidence is insufficient evidence that a detected heading owns a column. */
  readonly minimumSupportingGroups?: number;
};

export const GEOMETRY_RESULT_COLUMN_HORIZONTAL_TOLERANCE = 0.05 as const;
export const GEOMETRY_RESULT_COLUMN_MAX_LOOSE_ROW_GAP = 0.055 as const;
export const GEOMETRY_RESULT_COLUMN_MIN_SUPPORTING_GROUPS = 2 as const;

const RESULT_HEADER_WORDS = new Set([
  'result',
  'results',
  'rezultatas',
  'rezultatai',
  'ergebnis',
  'ergebnisse',
]);

type HeaderEvidence =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous' }
  | {
      readonly kind: 'column';
      readonly centerX: number;
      readonly columnIndex: number | null;
    };

type IndexedGroup = {
  readonly group: GeometryCandidateWindowGroup;
  readonly row: GeometryRow;
  readonly rowIndex: number;
};

/**
 * Narrows geometry candidate groups only when a local Result header proves one exact value
 * column. The complete original group is returned in `reviewGroups` whenever that proof yields
 * zero or multiple anchors. Missing or contradictory header evidence fails open.
 */
export function admitGeometryCandidateGroupsByResultColumn(
  lattice: GeometryLattice,
  groups: readonly GeometryCandidateWindowGroup[],
  options: GeometryResultColumnAdmissionOptions = {},
): GeometryResultColumnAdmission {
  const horizontalTolerance =
    options.horizontalTolerance ?? GEOMETRY_RESULT_COLUMN_HORIZONTAL_TOLERANCE;
  const maxLooseRowGap = options.maxLooseRowGap ?? GEOMETRY_RESULT_COLUMN_MAX_LOOSE_ROW_GAP;
  const minimumSupportingGroups =
    options.minimumSupportingGroups ?? GEOMETRY_RESULT_COLUMN_MIN_SUPPORTING_GROUPS;
  if (
    !validNormalizedDistance(horizontalTolerance) ||
    !validNormalizedDistance(maxLooseRowGap) ||
    !Number.isSafeInteger(minimumSupportingGroups) ||
    minimumSupportingGroups < 2
  )
    return { groups: [...groups], reviewGroups: [], excludedGroups: [], unrepresentedRows: [] };

  const rowByCellId = new Map<string, GeometryRow>();
  let latticeValid = true;
  for (const row of lattice.rows) {
    for (const cell of row.cells) {
      const prior = rowByCellId.get(cell.id);
      if (prior !== undefined && prior.id !== row.id) latticeValid = false;
      rowByCellId.set(cell.id, row);
    }
  }
  if (!latticeValid)
    return { groups: [...groups], reviewGroups: [], excludedGroups: [], unrepresentedRows: [] };

  if (options.scope === 'page-wide') {
    return admitByPageWideHeaders(lattice, groups, horizontalTolerance, minimumSupportingGroups);
  }

  const admitted: GeometryCandidateWindowGroup[] = [];
  const review: GeometryCandidateWindowGroup[] = [];
  const excluded: GeometryCandidateWindowGroup[] = [];
  const handled = new Set<GeometryCandidateWindowGroup>();
  const groupsByContext = new Map<string, GeometryCandidateWindowGroup[]>();
  for (const group of groups) {
    const key = contextKey(group.context);
    const contextGroups = groupsByContext.get(key) ?? [];
    contextGroups.push(group);
    groupsByContext.set(key, contextGroups);
  }

  for (const contextGroups of groupsByContext.values()) {
    const context = contextGroups[0]?.context;
    if (context === undefined) continue;
    const rows = lattice.rows
      .filter((row) => row.cells.length > 0 && sameContext(row, context))
      .slice()
      .sort(compareRows);
    const rowIndexById = new Map(rows.map((row, index) => [row.id, index]));
    const headers = rows.map((row) => headerEvidence(row, horizontalTolerance));
    const indexedGroups = contextGroups.flatMap((group): readonly IndexedGroup[] => {
      const anchorRows = new Set(
        group.anchorCellIds.flatMap((anchorId) => {
          const row = rowByCellId.get(anchorId);
          return row === undefined ? [] : [row];
        }),
      );
      if (anchorRows.size !== 1) return [];
      const row = [...anchorRows][0]!;
      const rowIndex = rowIndexById.get(row.id);
      return rowIndex === undefined ? [] : [{ group, row, rowIndex }];
    });
    const indexedSet = new Set(indexedGroups.map(({ group }) => group));
    for (const group of contextGroups) {
      if (indexedSet.has(group)) continue;
      handled.add(group);
      admitted.push(group);
    }

    const corridorSupport = new Map<number, number>();
    const precedingHeaders = new Map<GeometryCandidateWindowGroup, number>();
    for (const indexed of indexedGroups) {
      const headerIndex = precedingHeaderIndex(headers, indexed.rowIndex);
      if (
        headerIndex === null ||
        headers[headerIndex]?.kind !== 'column' ||
        corridorIsBroken(rows, headerIndex, indexed.rowIndex, context.tableId, maxLooseRowGap)
      )
        continue;
      precedingHeaders.set(indexed.group, headerIndex);
      if (matchingVariants(indexed.group, headers[headerIndex]!, horizontalTolerance).length > 0)
        corridorSupport.set(headerIndex, (corridorSupport.get(headerIndex) ?? 0) + 1);
    }

    for (const indexed of indexedGroups) {
      handled.add(indexed.group);
      const headerIndex = precedingHeaders.get(indexed.group);
      const header = headerIndex === undefined ? undefined : headers[headerIndex];
      if (
        headerIndex === undefined ||
        header?.kind !== 'column' ||
        (corridorSupport.get(headerIndex) ?? 0) < minimumSupportingGroups
      ) {
        admitted.push(indexed.group);
        continue;
      }
      const matches = matchingVariants(indexed.group, header, horizontalTolerance);
      if (matches.length === 0) {
        excluded.push(indexed.group);
        continue;
      }
      if (matches.length > 1) {
        review.push(indexed.group);
        continue;
      }
      admitted.push(narrowGroupToVariant(indexed.group, matches[0]!));
    }
  }

  for (const group of groups) {
    if (handled.has(group)) continue;
    admitted.push(group);
  }
  return {
    groups: admitted.sort(compareGroups),
    reviewGroups: review.sort(compareGroups),
    excludedGroups: excluded.sort(compareGroups),
    unrepresentedRows: [],
  };
}

function admitByPageWideHeaders(
  lattice: GeometryLattice,
  groups: readonly GeometryCandidateWindowGroup[],
  horizontalTolerance: number,
  minimumSupportingGroups: number,
): GeometryResultColumnAdmission {
  const headerCentersByPage = new Map<number, number[]>();
  for (const row of lattice.rows) {
    if (
      row.status !== 'resolved' ||
      row.cells.some((cell) => geometryResultAnchorKind(cell.text) !== null)
    )
      continue;
    for (const cell of row.cells) {
      if (!containsResultHeaderWord(cell.text)) continue;
      const centers = headerCentersByPage.get(row.pageIndex) ?? [];
      centers.push(cellCenterX(cell));
      headerCentersByPage.set(row.pageIndex, centers);
    }
  }

  const supportedCentersByPage = new Map<number, readonly number[]>();
  for (const [pageIndex, centers] of headerCentersByPage) {
    const clusters: number[][] = [];
    for (const center of centers.slice().sort((left, right) => left - right)) {
      const previous = clusters.at(-1);
      if (previous !== undefined && Math.abs(center - median(previous)) <= horizontalTolerance)
        previous.push(center);
      else clusters.push([center]);
    }
    const supported = clusters
      .map((cluster) => median(cluster))
      .filter(
        (center) =>
          groups.filter(
            (group) =>
              group.context.pageIndex === pageIndex &&
              group.variants.some((variant) =>
                variantMatchesCenter(group, variant, center, horizontalTolerance),
              ),
          ).length >= minimumSupportingGroups,
      );
    // Multiple supported centers can represent repeated or side-by-side tables. Admission below
    // remains row-specific: exactly one matching variant is narrowed, while multiple matches stay
    // in review instead of choosing a table implicitly.
    if (supported.length > 0) supportedCentersByPage.set(pageIndex, supported);
  }

  const admitted: GeometryCandidateWindowGroup[] = [];
  const review: GeometryCandidateWindowGroup[] = [];
  const excluded: GeometryCandidateWindowGroup[] = [];
  for (const group of groups) {
    const centers = supportedCentersByPage.get(group.context.pageIndex);
    if (centers === undefined) {
      admitted.push(group);
      continue;
    }
    const matches = group.variants.filter((variant) =>
      centers.some((center) => variantMatchesCenter(group, variant, center, horizontalTolerance)),
    );
    if (matches.length === 0) excluded.push(group);
    else if (matches.length > 1) review.push(group);
    else admitted.push(narrowGroupToVariant(group, matches[0]!));
  }
  const rowIdByCellId = new Map(
    lattice.rows.flatMap((row) => row.cells.map((cell) => [cell.id, row.id] as const)),
  );
  const representedRowIds = new Set(
    groups.flatMap((group) =>
      group.anchorCellIds.flatMap((anchorId) => {
        const rowId = rowIdByCellId.get(anchorId);
        return rowId === undefined ? [] : [rowId];
      }),
    ),
  );
  const unrepresentedRows = lattice.rows.flatMap(
    (row): readonly GeometryResultColumnReviewRow[] => {
      if (row.status !== 'resolved' || representedRowIds.has(row.id)) return [];
      const centers = supportedCentersByPage.get(row.pageIndex);
      if (centers === undefined) return [];
      const anchorCellIds = row.cells
        .filter(
          (cell) =>
            geometryResultAnchorKind(cell.text) !== null &&
            centers.some((center) => Math.abs(cellCenterX(cell) - center) <= horizontalTolerance),
        )
        .map((cell) => cell.id);
      return anchorCellIds.length === 0 ? [] : [{ physicalRow: row, anchorCellIds }];
    },
  );
  return {
    groups: admitted.sort(compareGroups),
    reviewGroups: review.sort(compareGroups),
    excludedGroups: excluded.sort(compareGroups),
    unrepresentedRows: unrepresentedRows.sort((left, right) =>
      compareRows(left.physicalRow, right.physicalRow),
    ),
  };
}

function variantMatchesCenter(
  group: GeometryCandidateWindowGroup,
  variant: GeometryCandidateWindowRow,
  center: number,
  horizontalTolerance: number,
): boolean {
  const anchor = group.sourceCells.find((cell) => cell.id === variant.anchorCellId);
  return anchor !== undefined && Math.abs(cellCenterX(anchor) - center) <= horizontalTolerance;
}

function headerEvidence(row: GeometryRow, tolerance: number): HeaderEvidence {
  if (
    row.status !== 'resolved' ||
    row.cells.some((cell) => geometryResultAnchorKind(cell.text) !== null)
  )
    return { kind: 'absent' };
  const cells = row.cells.filter((cell) => containsResultHeaderWord(cell.text)).sort(compareCells);
  if (cells.length === 0) return { kind: 'absent' };

  const tableColumns = [...new Set(cells.map((cell) => cell.columnIndex).filter(isNumber))];
  if (row.tableId !== null && tableColumns.length === 1) {
    return {
      kind: 'column',
      columnIndex: tableColumns[0]!,
      centerX: median(cells.map(cellCenterX)),
    };
  }
  if (row.tableId !== null && tableColumns.length > 1) return { kind: 'ambiguous' };

  const clusters: GeometryCell[][] = [];
  for (const cell of cells) {
    const previous = clusters.at(-1);
    if (
      previous !== undefined &&
      Math.abs(cellCenterX(cell) - median(previous.map(cellCenterX))) <= tolerance
    )
      previous.push(cell);
    else clusters.push([cell]);
  }
  if (clusters.length !== 1) return { kind: 'ambiguous' };
  return {
    kind: 'column',
    columnIndex: null,
    centerX: median(clusters[0]!.map(cellCenterX)),
  };
}

function containsResultHeaderWord(text: string): boolean {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .some((word) => RESULT_HEADER_WORDS.has(word));
}

function matchingVariants(
  group: GeometryCandidateWindowGroup,
  header: Extract<HeaderEvidence, { kind: 'column' }>,
  horizontalTolerance: number,
): readonly GeometryCandidateWindowRow[] {
  const cellsById = new Map(group.sourceCells.map((cell) => [cell.id, cell]));
  return group.variants.filter((variant) => {
    const anchor = cellsById.get(variant.anchorCellId);
    if (anchor === undefined) return false;
    if (header.columnIndex !== null && anchor.columnIndex !== null)
      return anchor.columnIndex === header.columnIndex;
    return Math.abs(cellCenterX(anchor) - header.centerX) <= horizontalTolerance;
  });
}

function narrowGroupToVariant(
  group: GeometryCandidateWindowGroup,
  variant: GeometryCandidateWindowRow,
): GeometryCandidateWindowGroup {
  const anchorIndex = group.anchorCellIds.indexOf(variant.anchorCellId);
  return {
    ...group,
    variants: [variant],
    anchorCellIds: [variant.anchorCellId],
    anchorKinds: [group.anchorKinds[anchorIndex] ?? variant.anchorKind],
  };
}

function precedingHeaderIndex(headers: readonly HeaderEvidence[], rowIndex: number): number | null {
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    if (headers[index]?.kind !== 'absent') return index;
  }
  return null;
}

function corridorIsBroken(
  rows: readonly GeometryRow[],
  headerIndex: number,
  rowIndex: number,
  tableId: string | null,
  maxLooseRowGap: number,
): boolean {
  if (tableId !== null) return false;
  for (let index = headerIndex + 1; index <= rowIndex; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous === undefined || current === undefined) return true;
    if (rowTop(current) - rowBottom(previous) > maxLooseRowGap) return true;
  }
  return false;
}

function sameContext(row: GeometryRow, context: GeometryCandidateContext): boolean {
  return (
    row.pageIndex === context.pageIndex &&
    row.tableId === context.tableId &&
    row.sectionId === context.sectionId &&
    row.specimenKey === context.specimenKey &&
    row.collectionDateKey === context.collectionDateKey
  );
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

function validNormalizedDistance(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNumber(value: number | null): value is number {
  return Number.isSafeInteger(value) && value !== null && value >= 0;
}

function cellCenterX(cell: GeometryCell): number {
  return cell.boundingBox.x + cell.boundingBox.width / 2;
}

function rowTop(row: GeometryRow): number {
  return Math.min(...row.cells.map((cell) => cell.boundingBox.y));
}

function rowBottom(row: GeometryRow): number {
  return Math.max(...row.cells.map((cell) => cell.boundingBox.y + cell.boundingBox.height));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function compareRows(left: GeometryRow, right: GeometryRow): number {
  return rowTop(left) - rowTop(right) || left.id.localeCompare(right.id);
}

function compareCells(left: GeometryCell, right: GeometryCell): number {
  return (
    left.boundingBox.x - right.boundingBox.x ||
    left.boundingBox.y - right.boundingBox.y ||
    left.id.localeCompare(right.id)
  );
}

function compareGroups(
  left: GeometryCandidateWindowGroup,
  right: GeometryCandidateWindowGroup,
): number {
  return (
    left.context.pageIndex - right.context.pageIndex ||
    rowTopFromCells(left.physicalRowCells) - rowTopFromCells(right.physicalRowCells) ||
    left.physicalRowId.localeCompare(right.physicalRowId)
  );
}

function rowTopFromCells(cells: readonly GeometryCell[]): number {
  return cells.length === 0
    ? Number.MAX_SAFE_INTEGER
    : Math.min(...cells.map((cell) => cell.boundingBox.y));
}
