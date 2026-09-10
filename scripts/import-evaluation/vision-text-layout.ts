import type { VisionObservation, VisionPage } from './qwen35-grounding';

/**
 * A readable, fixed-width representation of one native Vision page.
 *
 * This is a presentation adapter for an evaluation prompt. It does not identify laboratory
 * results, apply aliases, choose candidates, or alter native observations. The native page is
 * retained by the caller for provenance and later grounding; this text is only model input.
 */
export type VisionTextLayoutResult = {
  readonly pageIndex: number;
  readonly text: string;
  readonly diagnostics: VisionTextLayoutDiagnostics;
};

export type VisionTextLayoutDiagnostics = {
  /** Number of observations supplied to the renderer, including empty observations. */
  readonly observationCount: number;
  /** Number of observations represented by a rendered cell or fallback line. */
  readonly renderedObservationCount: number;
  readonly emptyObservationCount: number;
  readonly structuredTableCount: number;
  readonly fallbackLineCount: number;
  /** Explicit duplicate table-cell placements that were kept in the output. */
  readonly structuredCellCollisionCount: number;
  /** Structured cells with a row but without a usable column index. */
  readonly unpositionedStructuredObservationCount: number;
  /** Empty or malformed geometry falls back to native input order. */
  readonly unpositionedObservationCount: number;
  readonly collisions: readonly VisionTextLayoutCollision[];
};

export type VisionTextLayoutCollision = {
  readonly kind: 'structured-cell';
  readonly tableId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  /** Number of observations sharing the explicit table cell. */
  readonly observationCount: number;
};

type IndexedObservation = {
  readonly observation: VisionObservation;
  readonly inputIndex: number;
};

type RenderedBlock = {
  readonly firstInputIndex: number;
  readonly y: number | null;
  readonly lines: readonly string[];
};

type TableCell = IndexedObservation & {
  readonly columnIndex: number | null;
};

type TableRow = {
  readonly rowIndex: number;
  readonly cells: readonly TableCell[];
};

type TableGroup = {
  readonly tableId: string;
  readonly rows: readonly TableRow[];
};

const LINE_Y_TOLERANCE = 0.012;
const CELL_SEPARATOR = '   ';
const UNKNOWN_COLUMN_SORT = Number.POSITIVE_INFINITY;

function finiteNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function centerX(observation: VisionObservation): number | null {
  const box = observation.boundingBox;
  if (box === undefined) return null;
  const x = finiteNumber(box.x);
  const width = finiteNumber(box.width);
  return x === null || width === null ? null : x + width / 2;
}

function centerY(observation: VisionObservation): number | null {
  const box = observation.boundingBox;
  if (box === undefined) return null;
  const y = finiteNumber(box.y);
  const height = finiteNumber(box.height);
  return y === null || height === null ? null : y + height / 2;
}

/** Collapse only layout whitespace; source strings remain available on the native observations. */
function displayText(observation: VisionObservation): string {
  return observation.text
    .replace(/\r?\n/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function isStructuredTableCell(observation: VisionObservation): boolean {
  const structure = observation.structure;
  return (
    structure?.kind === 'table-cell' &&
    structure.tableId !== undefined &&
    Number.isFinite(structure.rowIndex)
  );
}

function tableCell(observation: VisionObservation, inputIndex: number): TableCell {
  const structure = observation.structure;
  return {
    observation,
    inputIndex,
    columnIndex:
      structure?.columnIndex !== undefined && Number.isFinite(structure.columnIndex)
        ? structure.columnIndex
        : null,
  };
}

function groupTables(observations: readonly IndexedObservation[]): {
  readonly tables: readonly TableGroup[];
  readonly fallback: readonly IndexedObservation[];
  readonly collisions: readonly VisionTextLayoutCollision[];
} {
  const tableMap = new Map<string, Map<number, TableCell[]>>();
  const fallback: IndexedObservation[] = [];

  for (const indexed of observations) {
    if (!isStructuredTableCell(indexed.observation)) {
      fallback.push(indexed);
      continue;
    }
    const structure = indexed.observation.structure;
    // isStructuredTableCell establishes these fields, but keep the runtime guard local because
    // native JSON is untrusted at this evaluation boundary.
    if (
      structure?.tableId === undefined ||
      structure.rowIndex === undefined ||
      !Number.isFinite(structure.rowIndex)
    ) {
      fallback.push(indexed);
      continue;
    }
    const rows = tableMap.get(structure.tableId) ?? new Map<number, TableCell[]>();
    const cells = rows.get(structure.rowIndex) ?? [];
    cells.push(tableCell(indexed.observation, indexed.inputIndex));
    rows.set(structure.rowIndex, cells);
    tableMap.set(structure.tableId, rows);
  }

  const collisions: VisionTextLayoutCollision[] = [];
  const tables: TableGroup[] = [];
  for (const [tableId, rowMap] of tableMap) {
    const rows: TableRow[] = [];
    for (const [rowIndex, cells] of rowMap) {
      const knownColumns = new Map<number, TableCell[]>();
      for (const cell of cells) {
        if (cell.columnIndex === null) continue;
        const columnCells = knownColumns.get(cell.columnIndex) ?? [];
        columnCells.push(cell);
        knownColumns.set(cell.columnIndex, columnCells);
      }
      for (const [columnIndex, columnCells] of knownColumns) {
        if (columnCells.length > 1) {
          collisions.push({
            kind: 'structured-cell',
            tableId,
            rowIndex,
            columnIndex,
            observationCount: columnCells.length,
          });
        }
      }
      rows.push({
        rowIndex,
        cells: cells.toSorted(
          (left, right) =>
            (left.columnIndex ?? UNKNOWN_COLUMN_SORT) -
              (right.columnIndex ?? UNKNOWN_COLUMN_SORT) ||
            (centerX(left.observation) ?? UNKNOWN_COLUMN_SORT) -
              (centerX(right.observation) ?? UNKNOWN_COLUMN_SORT) ||
            left.inputIndex - right.inputIndex,
        ),
      });
    }
    tables.push({
      tableId,
      rows: rows.toSorted((left, right) => left.rowIndex - right.rowIndex),
    });
  }

  return {
    tables: tables.toSorted((left, right) => {
      const leftIndex = Math.min(
        ...left.rows.flatMap((row) => row.cells.map((cell) => cell.inputIndex)),
      );
      const rightIndex = Math.min(
        ...right.rows.flatMap((row) => row.cells.map((cell) => cell.inputIndex)),
      );
      return leftIndex - rightIndex || left.tableId.localeCompare(right.tableId);
    }),
    fallback,
    collisions,
  };
}

function tableColumnWidths(table: TableGroup): ReadonlyMap<number, number> {
  const maxLengths = new Map<number, number>();
  for (const row of table.rows) {
    const byColumn = new Map<number, TableCell[]>();
    for (const cell of row.cells) {
      if (cell.columnIndex === null) continue;
      const cells = byColumn.get(cell.columnIndex) ?? [];
      cells.push(cell);
      byColumn.set(cell.columnIndex, cells);
    }
    for (const [columnIndex, cells] of byColumn) {
      const length = cells.map((cell) => displayText(cell.observation)).join(' | ').length;
      maxLengths.set(columnIndex, Math.max(maxLengths.get(columnIndex) ?? 0, length));
    }
  }
  return new Map(
    [...maxLengths].map(([columnIndex, length]) => [columnIndex, Math.max(length + 3, 3)]),
  );
}

function renderTable(table: TableGroup): RenderedBlock {
  const widths = tableColumnWidths(table);
  const knownColumnIndexes = [...widths.keys()].toSorted((left, right) => left - right);
  const firstInputIndex = Math.min(
    ...table.rows.flatMap((row) => row.cells.map((cell) => cell.inputIndex)),
  );
  const lines = table.rows.map((row) => {
    const knownCells = new Map<number, TableCell[]>();
    const unknownCells: TableCell[] = [];
    for (const cell of row.cells) {
      if (cell.columnIndex === null) unknownCells.push(cell);
      else {
        const cells = knownCells.get(cell.columnIndex) ?? [];
        cells.push(cell);
        knownCells.set(cell.columnIndex, cells);
      }
    }

    let line = '';
    for (const columnIndex of knownColumnIndexes) {
      const target = knownColumnIndexes
        .slice(0, knownColumnIndexes.indexOf(columnIndex))
        .reduce((sum, index) => sum + (widths.get(index) ?? 3), 0);
      if (line.length < target) line = line.padEnd(target, ' ');
      const value = (knownCells.get(columnIndex) ?? [])
        .map((cell) => displayText(cell.observation))
        .join(' | ');
      const width = widths.get(columnIndex) ?? Math.max(value.length + 3, 3);
      line += value.padEnd(width, ' ');
    }
    if (unknownCells.length > 0) {
      if (line.length > 0) line += CELL_SEPARATOR;
      line += unknownCells.map((cell) => displayText(cell.observation)).join(CELL_SEPARATOR);
    }
    return line.trimEnd();
  });
  const rowY = table.rows
    .flatMap((row) => row.cells.map((cell) => centerY(cell.observation)))
    .filter((value): value is number => value !== null);
  return {
    firstInputIndex,
    y: rowY.length > 0 ? Math.min(...rowY) : null,
    lines,
  };
}

function renderFallback(observations: readonly IndexedObservation[]): {
  readonly blocks: readonly RenderedBlock[];
  readonly lineCount: number;
} {
  const positioned = observations
    .map((indexed) => ({
      ...indexed,
      x: centerX(indexed.observation),
      y: centerY(indexed.observation),
    }))
    .toSorted(
      (left, right) =>
        (left.y ?? Number.POSITIVE_INFINITY) - (right.y ?? Number.POSITIVE_INFINITY) ||
        (left.x ?? Number.POSITIVE_INFINITY) - (right.x ?? Number.POSITIVE_INFINITY) ||
        left.inputIndex - right.inputIndex,
    );
  const lines: Array<{ observations: typeof positioned; y: number | null }> = [];
  for (const indexed of positioned) {
    const previous = lines.at(-1);
    if (
      previous !== undefined &&
      indexed.y !== null &&
      previous.y !== null &&
      Math.abs(indexed.y - previous.y) <= LINE_Y_TOLERANCE
    ) {
      previous.observations.push(indexed);
      previous.y = (previous.y + indexed.y) / 2;
    } else if (previous !== undefined && indexed.y === null && previous.y === null) {
      previous.observations.push(indexed);
    } else {
      lines.push({ observations: [indexed], y: indexed.y });
    }
  }
  return {
    blocks: lines.map((line) => ({
      firstInputIndex: Math.min(...line.observations.map((observation) => observation.inputIndex)),
      y: line.y,
      lines: [
        line.observations
          .map((observation) => displayText(observation.observation))
          .join(CELL_SEPARATOR),
      ],
    })),
    lineCount: lines.length,
  };
}

/**
 * Render every native Vision observation once as readable page text.
 *
 * Explicit table row/column metadata determines structured ordering. Other observations are
 * grouped by physical y and sorted by x. Duplicate structured cells remain joined in the same
 * cell and are reported as collisions rather than silently discarded. No source text is used as
 * a candidate filter, so headers, prose, footnotes, and guidance remain in the model input.
 */
export function renderVisionPageToPlainText(page: VisionPage): VisionTextLayoutResult {
  const indexed = page.observations.map((observation, inputIndex) => ({
    observation,
    inputIndex,
  }));
  const { tables, fallback, collisions } = groupTables(indexed);
  const tableBlocks = tables.map(renderTable);
  const fallbackResult = renderFallback(fallback);
  const blocks = [...tableBlocks, ...fallbackResult.blocks].toSorted(
    (left, right) =>
      (left.y ?? Number.POSITIVE_INFINITY) - (right.y ?? Number.POSITIVE_INFINITY) ||
      left.firstInputIndex - right.firstInputIndex,
  );
  const emptyObservationCount = page.observations.filter(
    (observation) => displayText(observation) === '',
  ).length;
  const unpositionedObservationCount = page.observations.filter(
    (observation) => centerX(observation) === null || centerY(observation) === null,
  ).length;
  const unpositionedStructuredObservationCount = page.observations.filter(
    (observation) =>
      isStructuredTableCell(observation) && observation.structure?.columnIndex === undefined,
  ).length;
  return {
    pageIndex: page.pageIndex,
    text: blocks.flatMap((block) => block.lines).join('\n'),
    diagnostics: {
      observationCount: page.observations.length,
      renderedObservationCount: page.observations.length,
      emptyObservationCount,
      structuredTableCount: tables.length,
      fallbackLineCount: fallbackResult.lineCount,
      structuredCellCollisionCount: collisions.reduce(
        (sum, collision) => sum + collision.observationCount - 1,
        0,
      ),
      unpositionedStructuredObservationCount,
      unpositionedObservationCount,
      collisions,
    },
  };
}
