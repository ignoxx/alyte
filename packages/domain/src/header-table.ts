/** Normalized source geometry (0..1 relative to the rendered page). */
export type HeaderTableLocation = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type HeaderTableBox = HeaderTableLocation;

/**
 * A source-grounded measurement candidate. This is deliberately independent of the catalogue:
 * the original laboratory label and every parsed source field survive even when the biomarker is
 * not mapped or the value cannot form a trend.
 */
export type HeaderTableMeasurement = {
  readonly id: string;
  readonly sourceLabel: string;
  readonly valueString: string | null;
  readonly valueType: 'numeric' | 'bounded' | 'categorical' | 'text' | 'unknown';
  readonly parsedValue: number | string | null;
  readonly comparator: '<' | '>' | '<=' | '>=' | '=' | null;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
  readonly collectionDate: string | null;
  readonly collectionGroup: string | null;
  readonly specimen: HeaderTableSpecimen | null;
  readonly page: number | null;
  readonly location: HeaderTableLocation | null;
  readonly ambiguousFields: readonly string[];
  readonly canonicalBiomarkerId: null;
  readonly trendEligible: null;
  /** Exact source observations that supplied each preserved field. */
  readonly labelSourceIds: readonly string[];
  readonly valueSourceIds: readonly string[];
  readonly unitSourceIds: readonly string[];
  readonly referenceIntervalSourceIds: readonly string[];
  readonly flagSourceIds: readonly string[];
  readonly collectionDateSourceIds: readonly string[];
  readonly specimenSourceIds: readonly string[];
  readonly sourceIds: readonly string[];
};

export type HeaderTableSpecimen =
  'blood' | 'blood-edta' | 'serum' | 'plasma' | 'urine' | 'stool' | 'saliva' | 'unknown';

export type HeaderTableSpan = {
  readonly id?: string;
  readonly parentObservationId?: string;
  readonly start?: number;
  readonly end?: number;
  readonly text: string;
  readonly boundingBox?: HeaderTableBox;
};

export type HeaderTableObservation = {
  readonly id: string;
  readonly text: string;
  readonly boundingBox: HeaderTableBox;
  readonly pageIndex: number;
  readonly structure?: {
    readonly kind?: 'text' | 'table-cell';
    readonly tableId?: string | null;
    readonly rowIndex?: number | null;
    readonly columnIndex?: number | null;
  };
  readonly spans?: readonly HeaderTableSpan[];
};

export type HeaderTablePage = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly observations: readonly HeaderTableObservation[];
};

export type HeaderTableExtraction = {
  readonly measurements: readonly HeaderTableMeasurement[];
  readonly counts: Readonly<Record<string, number>>;
};

export const HEADER_TABLE_PIPELINE_VERSION = 'native-parent-cell-owned-columns.v5' as const;

type Cell = {
  readonly id: string;
  readonly sourceIds: readonly string[];
  readonly parentId: string;
  readonly parentText: string;
  readonly parentBox: HeaderTableBox;
  readonly sourceOrder: number;
  readonly text: string;
  readonly box: HeaderTableBox;
  readonly pageIndex: number;
  readonly tableId: string | null;
  readonly rowIndex: number | null;
  readonly columnIndex: number | null;
};

type Row = {
  readonly id: string;
  readonly cells: readonly Cell[];
  readonly centerY: number;
  readonly tableId: string | null;
  readonly structured: boolean;
};

type Role = 'label' | 'value' | 'unit' | 'reference' | 'previous';

export type HeaderTableDateLocale = 'en-US' | 'lt-LT' | 'de-DE' | 'de-CH';

export type HeaderTableExtractionOptions = {
  readonly dateLocale?: HeaderTableDateLocale;
  /** Source IDs for a cross-page specimen legend, supplied by the page aggregator. */
  readonly specimenLegendSourceIds?: readonly string[];
};

type Header = {
  readonly rowIndex: number;
  readonly rowId: string;
  readonly tableId: string | null;
  readonly centers: Readonly<Partial<Record<Role, number>>>;
  readonly boundaries: Readonly<Partial<Record<Role, readonly [number, number]>>>;
  readonly roleColumns: Readonly<Partial<Record<Role, number>>>;
};

type XRange = readonly [number, number];

const HEADER_PHRASES: Readonly<Record<Role, readonly string[]>> = {
  label: ['test', 'tyrimas', 'analyse', 'analysis'],
  value: [
    'current result and flag',
    'current result',
    'tyrimo rezultatas',
    'ergebnis und flag',
    'ergebnis',
  ],
  unit: ['units', 'unit', 'matavimo vienetas', 'einheit'],
  reference: ['reference interval', 'normu ribos', 'referenzbereich'],
  previous: [
    'previous result and date',
    'previous result',
    'ankstesnis rezultatas ir data',
    'ankstesnis rezultatas',
    'vorheriges ergebnis und datum',
    'vorheriges ergebnis',
  ],
};

const COLLECTION_LABELS = [
  'date collected',
  'date drawn',
  'collection date',
  'mėginio paėmimo data',
  'mėginio paėmimo',
  'entnahme',
] as const;

const COLLECTION_EXCLUSIONS = [
  'date received',
  'date reported',
  'date created',
  'order date',
  'auftragsdatum',
  'eingang',
  'ausgang',
] as const;

const GUIDANCE_HEADER_MARKERS = [
  'target result',
  'target value',
  'desired result',
  'goal result',
  'recommended result',
  'zielwert',
  'sollwert',
  'tikslinis rezultatas',
] as const;

const DATE_PATTERN = /(?:(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}))/u;
const NUMBER_PATTERN = /^(?:<=|>=|<|>|≤|≥|=)?\s*[+-]?(?:(?:\d+(?:[.,]\d+)?)|(?:[.,]\d+))$/u;
const COMPARATOR_PATTERN = /^(<=|>=|<|>|≤|≥|=)/u;
const NUMBER_PREFIX_PATTERN = /^(<=|>=|<|>|≤|≥|=)?\s*[+-]?(?:(?:\d+(?:[.,]\d+)?)|(?:[.,]\d+))/u;
const STANDALONE_FLAG_PATTERN = /^(?:H|L|HH|LL|N|A)$/iu;

function folded(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/(?<=[\p{L}])(?=\p{N})/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function compact(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function centerX(box: HeaderTableBox): number {
  return box.x + box.width / 2;
}

function centerY(box: HeaderTableBox): number {
  return box.y + box.height / 2;
}

function unionBox(cells: readonly Cell[]): HeaderTableBox {
  const first = cells[0]?.box ?? { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...cells.map((cell) => cell.box.x));
  const top = Math.min(...cells.map((cell) => cell.box.y));
  const right = Math.max(...cells.map((cell) => cell.box.x + cell.box.width));
  const bottom = Math.max(...cells.map((cell) => cell.box.y + cell.box.height));
  return {
    x: Number.isFinite(left) ? left : first.x,
    y: Number.isFinite(top) ? top : first.y,
    width: Number.isFinite(right - left) ? right - left : first.width,
    height: Number.isFinite(bottom - top) ? bottom - top : first.height,
  };
}

function sourceCells(page: HeaderTablePage): Cell[] {
  const cells: Cell[] = [];
  for (const [observationIndex, observation] of page.observations.entries()) {
    const structure = observation.structure;
    const tableId = structure?.tableId ?? null;
    const rowIndex = structure?.rowIndex ?? null;
    const columnIndex = structure?.columnIndex ?? null;
    const spans = observation.spans ?? [];
    const isStructuredCell =
      structure?.kind === 'table-cell' ||
      (tableId !== null && rowIndex !== null && columnIndex !== null);
    const observationSourceIds = [
      observation.id,
      ...spans.map((span, spanIndex) => span.id ?? `${observation.id}:span:${spanIndex}`),
    ];
    if (spans.length === 0 || isStructuredCell) {
      if (compact(observation.text).length === 0) continue;
      cells.push({
        id: observation.id,
        sourceIds: observationSourceIds,
        parentId: observation.id,
        parentText: observation.text,
        parentBox: observation.boundingBox,
        sourceOrder: observationIndex * 1000000,
        text: observation.text,
        box: observation.boundingBox,
        pageIndex: observation.pageIndex,
        tableId,
        rowIndex,
        columnIndex,
      });
      continue;
    }
    for (const [spanIndex, span] of spans.entries()) {
      if (compact(span.text).length === 0) continue;
      cells.push({
        id: span.id ?? `${observation.id}:span:${spanIndex}`,
        sourceIds: [span.id ?? `${observation.id}:span:${spanIndex}`],
        parentId: span.parentObservationId ?? observation.id,
        parentText: observation.text,
        parentBox: observation.boundingBox,
        // The native span array is the source order. Keep that order as the tie-breaker when
        // glyph boxes jitter within one parent observation.
        sourceOrder: observationIndex * 1000000 + spanIndex,
        text: span.text,
        box: span.boundingBox ?? observation.boundingBox,
        pageIndex: observation.pageIndex,
        tableId,
        rowIndex,
        columnIndex,
      });
    }
  }
  return cells;
}

function buildRows(page: HeaderTablePage): Row[] {
  const cells = sourceCells(page).sort(
    (left, right) => centerY(left.box) - centerY(right.box) || left.sourceOrder - right.sourceOrder,
  );
  const grouped = new Map<string, Cell[]>();
  const looseParentGroups = new Map<string, Cell[]>();
  const typicalHeight =
    cells.length === 0
      ? 0.02
      : (cells.map((cell) => cell.box.height).sort((a, b) => a - b)[Math.floor(cells.length / 2)] ??
        0.02);
  const yTolerance = Math.max(0.004, typicalHeight * 0.85);
  for (const cell of cells) {
    if (cell.tableId !== null && cell.rowIndex !== null) {
      const key = `${cell.tableId}:${cell.rowIndex}`;
      const row = grouped.get(key) ?? [];
      row.push(cell);
      grouped.set(key, row);
      continue;
    }
    const parent = looseParentGroups.get(cell.parentId) ?? [];
    parent.push(cell);
    looseParentGroups.set(cell.parentId, parent);
  }

  // Keep every native parent observation together while assigning it to a physical row. A
  // reader can split one line into several word spans, and sorting those spans solely by centerY
  // can interleave superscripts or diacritics with the next line. Parent grouping preserves the
  // reader's source order; the geometry check only decides which parent observations share a row.
  const looseRows: Cell[][] = [];
  const looseGroups = [...looseParentGroups.values()].sort(
    (left, right) =>
      Math.min(...left.map((cell) => cell.box.y)) - Math.min(...right.map((cell) => cell.box.y)) ||
      Math.min(...left.map((cell) => cell.sourceOrder)) -
        Math.min(...right.map((cell) => cell.sourceOrder)),
  );
  for (const parent of looseGroups) {
    const top = Math.min(...parent.map((cell) => cell.box.y));
    const bottom = Math.max(...parent.map((cell) => cell.box.y + cell.box.height));
    const parentCenter = (top + bottom) / 2;
    const parentHeight = Math.max(0.001, bottom - top);
    const candidateRows = looseRows
      .map((row, index) => {
        const rowTop = Math.min(...row.map((cell) => cell.box.y));
        const rowBottom = Math.max(...row.map((cell) => cell.box.y + cell.box.height));
        const overlap = Math.max(0, Math.min(bottom, rowBottom) - Math.max(top, rowTop));
        const rowHeight = Math.max(0.001, rowBottom - rowTop);
        const centerDistance = Math.abs((rowTop + rowBottom) / 2 - parentCenter);
        return {
          index,
          overlap,
          overlapRatio: overlap / Math.min(parentHeight, rowHeight),
          centerDistance,
        };
      })
      .filter(
        (candidate) =>
          candidate.overlapRatio >= 0.25 ||
          candidate.centerDistance <= Math.max(yTolerance, parentHeight * 0.85),
      )
      .sort(
        (left, right) =>
          right.overlapRatio - left.overlapRatio || left.centerDistance - right.centerDistance,
      );
    const target = candidateRows[0];
    if (target === undefined) looseRows.push(parent.slice());
    else looseRows[target.index]!.push(...parent);
  }
  const rows = [
    ...[...grouped.entries()].map(([key, row]) => ({ key, cells: row })),
    ...looseRows.map((row, index) => ({ key: `loose:${index}`, cells: row })),
  ];
  return rows
    .map(({ key, cells: rowCells }) => {
      const structured = rowCells.some(
        (cell) => cell.columnIndex !== null && cell.tableId !== null,
      );
      const sorted = rowCells.slice().sort((left, right) => {
        if (structured && left.columnIndex !== null && right.columnIndex !== null) {
          return left.columnIndex - right.columnIndex || left.sourceOrder - right.sourceOrder;
        }
        if (left.parentId === right.parentId) return left.sourceOrder - right.sourceOrder;
        return centerX(left.box) - centerX(right.box) || left.sourceOrder - right.sourceOrder;
      });
      return {
        id: `${page.pageIndex}:${key}`,
        cells: sorted,
        centerY: sorted.reduce((sum, cell) => sum + centerY(cell.box), 0) / sorted.length,
        tableId: sorted.find((cell) => cell.tableId !== null)?.tableId ?? null,
        structured,
      };
    })
    .sort((left, right) => left.centerY - right.centerY || left.id.localeCompare(right.id));
}

function phraseHits(cells: readonly Cell[], phrase: string): number[] {
  const wanted = folded(phrase).split(' ').filter(Boolean);
  if (wanted.length === 0) return [];
  const tokens = cells.flatMap((cell, cellIndex) =>
    folded(cell.text)
      .split(' ')
      .filter(Boolean)
      .map((word, wordIndex) => ({ word, cellIndex, wordIndex })),
  );

  const overlap = (
    firstStart: number,
    firstEnd: number,
    secondStart: number,
    secondEnd: number,
  ): number => Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
  const canFollow = (previous: (typeof tokens)[number], next: (typeof tokens)[number]): boolean => {
    if (previous.cellIndex === next.cellIndex) return next.wordIndex > previous.wordIndex;
    const previousBox = cells[previous.cellIndex]!.box;
    const nextBox = cells[next.cellIndex]!.box;
    const xOverlap = overlap(
      previousBox.x,
      previousBox.x + previousBox.width,
      nextBox.x,
      nextBox.x + nextBox.width,
    );
    const yOverlap = overlap(
      previousBox.y,
      previousBox.y + previousBox.height,
      nextBox.y,
      nextBox.y + nextBox.height,
    );
    const narrowestWidth = Math.min(previousBox.width, nextBox.width);
    const narrowestHeight = Math.min(previousBox.height, nextBox.height);
    const verticalStack =
      xOverlap >= narrowestWidth * 0.45 &&
      centerY(nextBox) >= centerY(previousBox) - 0.002 &&
      centerY(nextBox) - centerY(previousBox) <= Math.max(previousBox.height, nextBox.height) * 2.5;
    const horizontalLine =
      yOverlap >= narrowestHeight * 0.25 &&
      centerX(nextBox) >= centerX(previousBox) - Math.max(0.01, narrowestWidth * 0.5);
    return verticalStack || horizontalLine;
  };

  // Native readers can expose words in x order even when one header is stacked
  // vertically in the same column. Walk phrase words by their geometry so those
  // words retain one role and one source range.
  for (const start of tokens) {
    if (start.word !== wanted[0]) continue;
    const path = [start];
    let previous = start;
    let matched = true;
    for (const wantedWord of wanted.slice(1)) {
      const next = tokens.find((token) => token.word === wantedWord && canFollow(previous, token));
      if (next === undefined) {
        matched = false;
        break;
      }
      path.push(next);
      previous = next;
    }
    if (matched && path.length === wanted.length)
      return [...new Set(path.map((token) => token.cellIndex))];
  }
  return [];
}

function isGuidanceHeader(row: Row): boolean {
  const text = folded(row.cells.map((cell) => cell.text).join(' '));
  return GUIDANCE_HEADER_MARKERS.some((marker) => text.includes(folded(marker)));
}

function headerForRow(row: Row): Header | null {
  if (isGuidanceHeader(row)) return null;
  const centers: Partial<Record<Role, number>> = {};
  const roleColumns: Partial<Record<Role, number>> = {};
  const hitsByRole = new Map<Role, readonly number[]>();
  const previousHits = new Set(
    HEADER_PHRASES.previous.flatMap((phrase) => phraseHits(row.cells, phrase)),
  );
  for (const role of Object.keys(HEADER_PHRASES) as Role[]) {
    const hits = HEADER_PHRASES[role].flatMap((phrase) =>
      phrase === 'ergebnis'
        ? row.cells.flatMap((cell, index) =>
            folded(cell.text) === phrase && !previousHits.has(index) ? [index] : [],
          )
        : phraseHits(row.cells, phrase),
    );
    const unique = [...new Set(hits)];
    hitsByRole.set(role, unique);
    if (unique.length > 0) {
      centers[role] =
        unique.reduce((sum, index) => sum + centerX(row.cells[index]!.box), 0) / unique.length;
      const columns = [
        ...new Set(
          unique
            .map((index) => row.cells[index]!.columnIndex)
            .filter((column): column is number => column !== null),
        ),
      ];
      if (columns.length === 1) roleColumns[role] = columns[0]!;
    }
  }
  if (centers.label === undefined || centers.value === undefined) return null;
  const ranges = new Map<Role, XRange>();
  for (const [role, hits] of hitsByRole) {
    if (hits.length === 0) continue;
    const left = Math.min(...hits.map((index) => row.cells[index]!.box.x));
    const right = Math.max(
      ...hits.map((index) => row.cells[index]!.box.x + row.cells[index]!.box.width),
    );
    ranges.set(role, [left, right]);
  }
  const ordered = [...ranges.entries()].sort((left, right) => left[1][0] - right[1][0]);
  const boundaries: Partial<Record<Role, readonly [number, number]>> = {};
  const between = (left: readonly [Role, XRange], right: readonly [Role, XRange]): number => {
    const gap = Math.max(0, right[1][0] - left[1][1]);
    const margin = Math.max(0.004, Math.min(0.015, gap * 0.08));
    if (left[0] === 'label') return Math.max(left[1][1], right[1][0] - margin);
    if (right[0] === 'label') return Math.min(right[1][0], left[1][1] + margin);
    return (left[1][1] + right[1][0]) / 2;
  };
  for (const [index, [role, range]] of ordered.entries()) {
    // Keep unknown side columns outside the owned range. The margin is derived from
    // the header glyph width, so displaced columns remain supported without opening
    // the first/last owned column to administrative fields.
    const edgeMargin = Math.max(0.008, Math.min(0.03, (range[1] - range[0]) * 0.25));
    const left =
      index === 0
        ? Math.max(0, range[0] - edgeMargin)
        : between(ordered[index - 1]!, [role, range]);
    const right =
      index === ordered.length - 1
        ? Math.min(1, range[1] + edgeMargin)
        : between([role, range], ordered[index + 1]!);
    boundaries[role] = [left, right];
  }
  return { rowIndex: 0, rowId: row.id, tableId: row.tableId, centers, boundaries, roleColumns };
}

function inBoundary(cell: Cell, boundary: readonly [number, number] | undefined): boolean {
  if (boundary === undefined) return false;
  const x = centerX(cell.box);
  return x >= boundary[0] && x < boundary[1];
}

function inLabelColumn(cell: Cell, header: Header): boolean {
  const boundary = header.boundaries.label;
  if (!inBoundary(cell, boundary) || boundary === undefined) return false;
  const leftMargin = Math.max(0.004, Math.min(0.012, (boundary[1] - boundary[0]) * 0.03));
  return cell.box.x >= boundary[0] + leftMargin;
}

function roleCells(row: Row, header: Header, role: Role): readonly Cell[] {
  const column = header.roleColumns[role];
  if (column !== undefined && row.structured && row.tableId === header.tableId) {
    return row.cells.filter(
      (cell) => cell.tableId === header.tableId && cell.columnIndex === column,
    );
  }
  const boundary = header.boundaries[role];
  return row.cells.filter((cell) => inBoundary(cell, boundary));
}

function parentOwnedCells(row: Row, header: Header, role: Role): readonly Cell[] {
  const selected = roleCells(row, header, role);
  if (selected.length === 0 || row.structured) return selected;
  const byParent = new Map<string, Cell[]>();
  for (const cell of row.cells) {
    const group = byParent.get(cell.parentId) ?? [];
    group.push(cell);
    byParent.set(cell.parentId, group);
  }
  const boundary = header.boundaries[role];
  const result: Cell[] = [];
  const emitted = new Set<string>();
  for (const cell of selected) {
    if (emitted.has(cell.parentId)) continue;
    const group = byParent.get(cell.parentId) ?? [cell];
    const parentFits =
      boundary !== undefined &&
      inBoundary({ ...cell, box: cell.parentBox }, boundary) &&
      cell.parentBox.x >= boundary[0] &&
      cell.parentBox.x + cell.parentBox.width <= boundary[1];
    if (parentFits && group.every((item) => inBoundary(item, boundary))) {
      result.push({
        ...cell,
        id: cell.parentId,
        sourceIds: [...new Set(group.flatMap((item) => [item.parentId, ...item.sourceIds]))],
        text: cell.parentText,
        box: cell.parentBox,
        sourceOrder: Math.min(...group.map((item) => item.sourceOrder)),
      });
      emitted.add(cell.parentId);
      continue;
    }
    result.push(...selected.filter((item) => item.parentId === cell.parentId));
    emitted.add(cell.parentId);
  }
  return result.sort((left, right) => left.sourceOrder - right.sourceOrder);
}

function resultAdjacentFlags(row: Row, header: Header): readonly Cell[] {
  const valueCenter = header.centers.value;
  const labelCenter = header.centers.label;
  if (valueCenter === undefined || labelCenter === undefined) return [];
  const midpoint = labelCenter + (valueCenter - labelCenter) * 0.4;
  const upper = valueCenter + Math.max(0.06, Math.abs(valueCenter - labelCenter) * 0.35);
  const legacy = row.cells
    .filter((cell) => isStandaloneFlag(cell.text))
    .filter((cell) => {
      const x = centerX(cell.box);
      return x >= Math.min(midpoint, upper) && x <= Math.max(midpoint, upper);
    });
  const span = Math.abs(valueCenter - labelCenter);
  const nearValue = row.cells.filter((cell) => {
    if (!isStandaloneFlag(cell.text)) return false;
    const x = centerX(cell.box);
    return (
      Math.abs(x - labelCenter) >= span * 0.45 &&
      Math.abs(x - valueCenter) <= Math.max(0.1, span * 0.4)
    );
  });
  return [...new Map([...legacy, ...nearValue].map((cell) => [cell.id, cell])).values()];
}

function rowText(row: Row): string {
  return compact(row.cells.map((cell) => cell.text).join(' '));
}

function isHeaderText(value: string): boolean {
  const text = folded(value);
  return (Object.values(HEADER_PHRASES) as readonly (readonly string[])[]).some((phrases) =>
    phrases.some((phrase) => text === folded(phrase)),
  );
}

function isCollectionText(value: string): boolean {
  const text = folded(value);
  return (
    COLLECTION_LABELS.some((label) => text.includes(folded(label))) &&
    !COLLECTION_EXCLUSIONS.some((label) => text.includes(folded(label)))
  );
}

type PageSpecimenContext = {
  readonly defaultSpecimen: HeaderTableSpecimen | null;
  readonly sourceIds: readonly string[];
  readonly codeObservations: readonly HeaderTableObservation[];
  readonly legendSourceIds: readonly string[];
};

// This is deliberately a complete source sentence rather than a keyword rule. A bare mention
// of "blood" or "serum" can be a biomarker label, a reference note, or educational prose. The
// sentence below is the laboratory's explicit page-level default for its results.
const GERMAN_BLOOD_DEFAULT_SENTENCE =
  'sofern nicht anders angegeben wurden die analysen aus blut durchgefuhrt';
const SPECIMEN_CODE_PATTERN = /^(?:K|S|Š|V)$/u;

function observationSourceIds(observation: HeaderTableObservation): readonly string[] {
  return [
    observation.id,
    ...(observation.spans ?? []).flatMap((span, index) => [
      span.id ?? `${observation.id}:span:${index}`,
    ]),
  ];
}

function specimenLegendSourceIds(pages: readonly HeaderTablePage[]): readonly string[] {
  return [
    ...new Set(
      pages
        .flatMap((page) => page.observations)
        .filter((observation) => {
          const text = folded(observation.text);
          return (
            text.includes('paaiskinimai') &&
            text.includes('trumpiniai') &&
            text.includes('kraujas') &&
            text.includes('serumas') &&
            text.includes('slapimas')
          );
        })
        .flatMap(observationSourceIds),
    ),
  ];
}

function pageSpecimenContext(
  page: HeaderTablePage,
  legendSourceIds: readonly string[] = [],
): PageSpecimenContext {
  const defaultBloodObservations = page.observations.filter((observation) =>
    folded(observation.text).includes(GERMAN_BLOOD_DEFAULT_SENTENCE),
  );
  return {
    defaultSpecimen: defaultBloodObservations.length === 0 ? null : 'blood',
    sourceIds: [...new Set(defaultBloodObservations.flatMap(observationSourceIds))],
    codeObservations: page.observations.filter((observation) =>
      SPECIMEN_CODE_PATTERN.test(compact(observation.text)),
    ),
    legendSourceIds,
  };
}

function specimenFromCode(code: string): HeaderTableSpecimen | null {
  if (code === 'S') return 'serum';
  if (code === 'V') return 'blood-edta';
  if (code === 'Š') return 'urine';
  if (code === 'K') return 'blood';
  return null;
}

function specimenForLabel(
  labelCells: readonly Cell[],
  context: PageSpecimenContext,
): { readonly value: HeaderTableSpecimen; readonly sourceIds: readonly string[] } | null {
  if (labelCells.length === 0) return null;
  const labelLeft = Math.min(...labelCells.map((cell) => cell.box.x));
  const labelBottom = Math.max(...labelCells.map((cell) => cell.box.y + cell.box.height));
  const candidates = context.codeObservations
    .filter((observation) => observation.boundingBox.x + observation.boundingBox.width < labelLeft)
    .map((observation) => ({
      observation,
      gap: observation.boundingBox.y - labelBottom,
    }))
    .filter((candidate) => candidate.gap >= -0.012 && candidate.gap <= 0.018)
    .sort((left, right) => left.gap - right.gap);
  const candidate = candidates[0];
  if (
    candidate === undefined ||
    candidates.some(
      (item) => item.gap === candidate.gap && item.observation.id !== candidate.observation.id,
    )
  ) {
    return null;
  }
  const value = specimenFromCode(compact(candidate.observation.text));
  if (value === null) return null;
  return {
    value,
    sourceIds: [
      ...new Set([...observationSourceIds(candidate.observation), ...context.legendSourceIds]),
    ],
  };
}

function specimenFromExplicitLabel(label: string): HeaderTableSpecimen | null {
  const text = folded(label);
  // A trailing specimen term is source evidence in common lab labels such as
  // "Kreatinin im Serum" and "Folsäure Serum". Keep the rule narrow so words such as
  // "Urin" inside a biomarker name cannot silently become specimen metadata.
  if (text.endsWith(' serum')) return 'serum';
  if (text.endsWith(' plasma')) return 'plasma';
  if (text.endsWith(' urine') || text.endsWith(' urin')) return 'urine';
  return null;
}

function isStandaloneFlag(value: string): boolean {
  return STANDALONE_FLAG_PATTERN.test(compact(value));
}

function parseDate(text: string, dateLocale?: HeaderTableDateLocale): string | null {
  const match = text.match(DATE_PATTERN);
  if (match === null) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  let year: number;
  let month: number;
  let day: number;
  if (first >= 1000) [year, month, day] = [first, second, third];
  else if (third >= 1000 && text.includes('/')) {
    if (dateLocale === 'en-US') [year, month, day] = [third, first, second];
    else if (dateLocale === 'lt-LT' || dateLocale === 'de-DE' || dateLocale === 'de-CH')
      [year, month, day] = [third, second, first];
    else return null;
  } else if (third >= 1000) [year, month, day] = [third, second, first];
  else return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function pageCollectionDate(
  rows: readonly Row[],
  dateLocale?: HeaderTableDateLocale,
): { readonly value: string | null; readonly sourceIds: readonly string[] } {
  const dates = new Map<string, string[]>();
  for (const row of rows) {
    const candidates = row.cells.map((cell) => compact(cell.text));
    candidates.push(rowText(row));
    for (const [candidateIndex, text] of candidates.entries()) {
      if (!isCollectionText(text)) continue;
      const date = parseDate(text, dateLocale);
      if (date === null) continue;
      const sourceIds =
        candidateIndex < row.cells.length
          ? sourceFieldIds([row.cells[candidateIndex]!])
          : sourceFieldIds(row.cells);
      dates.set(date, [...new Set([...(dates.get(date) ?? []), ...sourceIds])]);
    }
  }
  if (dates.size !== 1) return { value: null, sourceIds: [] };
  const [value, sourceIds] = [...dates.entries()][0]!;
  return { value, sourceIds };
}

function parseScalar(
  text: string,
  referenceInterval: string | null,
): {
  readonly valueType: HeaderTableMeasurement['valueType'];
  readonly parsedValue: number | string;
  readonly comparator: HeaderTableMeasurement['comparator'];
} | null {
  const trimmed = compact(text);
  const numeric = trimmed.replace(/\s+/gu, '');
  if (NUMBER_PATTERN.test(numeric)) {
    const comparatorToken = numeric.match(COMPARATOR_PATTERN)?.[1] ?? null;
    const numberText = comparatorToken === null ? numeric : numeric.slice(comparatorToken.length);
    const parsed = Number(numberText.replace(',', '.'));
    if (Number.isFinite(parsed)) {
      const comparator =
        comparatorToken === '≤'
          ? '<='
          : comparatorToken === '≥'
            ? '>='
            : (comparatorToken as HeaderTableMeasurement['comparator']);
      return {
        valueType: comparatorToken === null ? 'numeric' : 'bounded',
        parsedValue: parsed,
        comparator,
      };
    }
  }
  if (trimmed.length === 0) return null;
  const categoricalEvidence =
    referenceInterval !== null &&
    folded(referenceInterval) === folded(trimmed) &&
    !/[.!?;]/u.test(trimmed);
  return {
    valueType: categoricalEvidence ? 'categorical' : 'text',
    parsedValue: trimmed,
    comparator: null,
  };
}

function verticallyContinued(left: Cell, right: Cell): boolean {
  const leftRight = left.box.x + left.box.width;
  const rightRight = right.box.x + right.box.width;
  const xOverlap = Math.max(0, Math.min(leftRight, rightRight) - Math.max(left.box.x, right.box.x));
  const minWidth = Math.min(left.box.width, right.box.width);
  return (
    right.box.y > left.box.y + Math.min(left.box.height, right.box.height) * 0.2 &&
    xOverlap >= minWidth * 0.25
  );
}

function joinsUnitOrReferenceFragment(left: Cell, right: Cell): boolean {
  if (!verticallyContinued(left, right)) return false;
  const previous = compact(left.text);
  const next = compact(right.text);
  if (previous.length === 0 || next.length === 0) return false;
  return (
    /[\\/^%]/u.test(previous) ||
    /[\\/^%]/u.test(next) ||
    (/[0-9]$/u.test(previous) && /^[0-9]/u.test(next))
  );
}

function fieldText(cells: readonly Cell[], joinLayoutFragments = false): string | null {
  const ordered = cells.slice().sort((left, right) => left.sourceOrder - right.sourceOrder);
  let text = '';
  for (const [index, cell] of ordered.entries()) {
    const part = compact(cell.text);
    if (part.length === 0) continue;
    const previous = ordered[index - 1];
    const separator =
      text.length === 0
        ? ''
        : joinLayoutFragments &&
            previous !== undefined &&
            joinsUnitOrReferenceFragment(previous, cell)
          ? ''
          : ' ';
    text += `${separator}${part}`;
  }
  text = compact(text);
  return text.length === 0 ? null : text;
}

function splitValueAndFlag(
  cells: readonly Cell[],
  referenceInterval: string | null,
): {
  readonly value: string;
  readonly flag: string | null;
} | null {
  const value = fieldText(cells);
  if (value === null) return null;
  const parsed = parseScalar(value, referenceInterval);
  if (parsed?.valueType === 'numeric' || parsed?.valueType === 'bounded') {
    return { value, flag: null };
  }
  const parts = compact(value).split(/\s+/u);
  const prefix = parts[0] ?? '';
  if (parts.length > 1 && isStandaloneFlag(prefix)) {
    const remainder = compact(parts.slice(1).join(' '));
    const parsedRemainder = parseScalar(remainder, referenceInterval);
    if (parsedRemainder?.valueType === 'numeric' || parsedRemainder?.valueType === 'bounded') {
      return { value: remainder, flag: prefix };
    }
  }
  if (parts.length > 1 && NUMBER_PATTERN.test(prefix)) {
    return { value: prefix, flag: compact(parts.slice(1).join(' ')) };
  }
  if (referenceInterval !== null && folded(parts[0] ?? '') === folded(referenceInterval)) {
    const flag = compact(parts.slice(1).join(' '));
    return { value: parts[0]!, flag: flag.length === 0 ? null : flag };
  }
  const match = value.match(NUMBER_PREFIX_PATTERN);
  if (match !== null && match[0].length < value.length) {
    const numeric = compact(match[0]);
    const flag = compact(value.slice(match[0].length));
    if (flag.length > 0 && NUMBER_PATTERN.test(numeric)) return { value: numeric, flag };
  }
  return { value, flag: null };
}

function sourceFieldIds(cells: readonly Cell[]): string[] {
  return cells.flatMap((cell) => [cell.parentId, ...cell.sourceIds]);
}

function looseScopeBreaks(rows: readonly Row[]): ReadonlySet<number> {
  const gaps = rows
    .slice(1)
    .map((row, index) => row.centerY - rows[index]!.centerY)
    .filter((gap) => gap > 0)
    .sort((left, right) => left - right);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? 0.02;
  // A table can extend over most of a page. Use the page's own row rhythm to find a
  // genuine table break instead of assuming a fixed header-to-row distance.
  const breakThreshold = typicalGap * 6;
  const breaks = new Set<number>();
  for (let index = 1; index < rows.length; index += 1) {
    const prior = rows[index - 1]!;
    const current = rows[index]!;
    if (
      prior.tableId === null &&
      current.tableId === null &&
      current.centerY - prior.centerY > breakThreshold
    )
      breaks.add(index);
  }
  return breaks;
}

function labelContinuationCells(
  rows: readonly Row[],
  rowIndex: number,
  header: Header,
): readonly Cell[] {
  const current = rows[rowIndex];
  if (current === undefined) return [];
  const currentLabel = current.cells.filter((cell) => inLabelColumn(cell, header));
  if (currentLabel.length === 0) return [];
  const currentText = compact(currentLabel.map((cell) => cell.text).join(' '));
  const openingDelimiters = (currentText.match(/[([{]/gu) ?? []).length;
  const closingDelimiters = (currentText.match(/[)\]}]/gu) ?? []).length;
  const hasContinuationCue =
    openingDelimiters > closingDelimiters || /[,;:/\\(\-]$/u.test(currentText);
  if (!hasContinuationCue) return [];
  const currentLeft = Math.min(...currentLabel.map((cell) => cell.box.x));
  const currentHeight = Math.max(...currentLabel.map((cell) => cell.box.height));
  const maxGap = Math.max(0.004, currentHeight * 1.6);
  for (let offset = 1; offset <= 3; offset += 1) {
    const next = rows[rowIndex + offset];
    if (
      next === undefined ||
      next.centerY <= current.centerY ||
      next.centerY - current.centerY > maxGap
    )
      break;
    const nextLabel = next.cells.filter((cell) => inLabelColumn(cell, header));
    const nextHasAnotherOwnedField = next.cells.some(
      (cell) =>
        inBoundary(cell, header.boundaries.value) ||
        inBoundary(cell, header.boundaries.unit) ||
        inBoundary(cell, header.boundaries.reference) ||
        inBoundary(cell, header.boundaries.previous),
    );
    if (nextHasAnotherOwnedField) return [];
    if (nextLabel.length === 0) continue;
    const nextLeft = Math.min(...nextLabel.map((cell) => cell.box.x));
    if (Math.abs(currentLeft - nextLeft) > 0.025) return [];
    if (nextLabel.some((cell) => isHeaderText(cell.text) || isCollectionText(cell.text))) return [];
    return nextLabel;
  }
  return [];
}

function candidateMeasurement(
  page: HeaderTablePage,
  row: Row,
  header: Header,
  dateEvidence: { readonly value: string | null; readonly sourceIds: readonly string[] },
  specimenContext: PageSpecimenContext,
  index: number,
): HeaderTableMeasurement | null {
  const adjacentFlags = resultAdjacentFlags(row, header);
  const adjacentFlagIds = new Set(
    adjacentFlags.flatMap((cell) => [cell.id, cell.parentId, ...cell.sourceIds]),
  );
  const labelCells = parentOwnedCells(row, header, 'label')
    .filter(
      (cell) => ![cell.id, cell.parentId, ...cell.sourceIds].some((id) => adjacentFlagIds.has(id)),
    )
    .sort((left, right) => left.sourceOrder - right.sourceOrder);
  const currentValueCells = parentOwnedCells(row, header, 'value');
  const valueCells = [
    ...currentValueCells,
    ...adjacentFlags.filter(
      (cell) => !currentValueCells.some((currentCell) => currentCell.id === cell.id),
    ),
  ].sort((left, right) => left.sourceOrder - right.sourceOrder);
  const unitCells = parentOwnedCells(row, header, 'unit');
  const referenceCells = parentOwnedCells(row, header, 'reference');
  const label = fieldText(labelCells);
  if (label === null || label.length === 0 || labelCells.some((cell) => isHeaderText(cell.text)))
    return null;
  if (valueCells.length === 0) return null;
  const unit = fieldText(unitCells, true);
  const referenceInterval = fieldText(referenceCells, true);
  const valueParts = splitValueAndFlag(valueCells, referenceInterval);
  if (
    valueParts === null ||
    parseDate(label) !== null ||
    parseDate(valueParts.value) !== null ||
    isCollectionText(label)
  )
    return null;
  const parsed = parseScalar(valueParts.value, referenceInterval);
  if (parsed === null) return null;
  if (
    parsed.valueType === 'text' &&
    [unit, referenceInterval].some((field) => field !== null && /[.!?;,]/u.test(field))
  )
    return null;
  const valueSources = sourceFieldIds(valueCells);
  const labelSources = sourceFieldIds(labelCells);
  const unitSources = sourceFieldIds(unitCells);
  const referenceSources = sourceFieldIds(referenceCells);
  const flagSources = valueParts.flag === null ? [] : valueSources;
  const allSources = sourceFieldIds(row.cells);
  const location = unionBox(row.cells);
  const specimenFromLabel = specimenFromExplicitLabel(label);
  const specimenFromCode = specimenForLabel(labelCells, specimenContext);
  const specimenEvidence =
    specimenFromLabel === null
      ? (specimenFromCode ??
        (specimenContext.defaultSpecimen === null
          ? null
          : {
              value: specimenContext.defaultSpecimen,
              sourceIds: specimenContext.sourceIds,
            }))
      : { value: specimenFromLabel, sourceIds: [] };
  const specimen = specimenEvidence?.value ?? null;
  const specimenSourceIds =
    specimenFromLabel === null ? (specimenEvidence?.sourceIds ?? []) : labelSources;
  const ambiguousFields: string[] = [];
  if (dateEvidence.value === null) ambiguousFields.push('collectionDate');
  if (specimen === null) ambiguousFields.push('specimen');
  return {
    id: `header-table-p${page.pageIndex + 1}-r${index + 1}`,
    sourceLabel: label,
    valueString: valueParts.value,
    valueType: parsed.valueType,
    parsedValue: parsed.parsedValue,
    comparator: parsed.comparator,
    unit,
    referenceInterval,
    flag: valueParts.flag,
    collectionDate: dateEvidence.value,
    collectionGroup: `${page.pageIndex + 1}:${header.rowId}`,
    specimen,
    page: page.pageIndex + 1,
    location,
    ambiguousFields,
    labelSourceIds: [...new Set(labelSources)],
    valueSourceIds: [...new Set(valueSources)],
    unitSourceIds: [...new Set(unitSources)],
    referenceIntervalSourceIds: [...new Set(referenceSources)],
    flagSourceIds: [...new Set(flagSources)],
    collectionDateSourceIds: [...new Set(dateEvidence.sourceIds)],
    specimenSourceIds: [...new Set(specimenSourceIds)],
    sourceIds: [
      ...new Set([
        ...allSources,
        ...valueSources,
        ...labelSources,
        ...unitSources,
        ...referenceSources,
        ...dateEvidence.sourceIds,
        ...specimenSourceIds,
      ]),
    ],
    canonicalBiomarkerId: null,
    trendEligible: null,
  };
}

export function extractHeaderTablePage(
  page: HeaderTablePage,
  options: HeaderTableExtractionOptions = {},
): HeaderTableExtraction {
  const rows = buildRows(page);
  const headerRows = rows
    .map((row, rowIndex) => ({ row, rowIndex, header: headerForRow(row) }))
    .filter(
      (item): item is { readonly row: Row; readonly rowIndex: number; readonly header: Header } =>
        item.header !== null,
    )
    .map(({ row, rowIndex, header }) => ({
      row,
      rowIndex,
      header: { ...header, rowIndex },
    }));
  const collectionDate = pageCollectionDate(rows, options.dateLocale);
  const specimenContext = pageSpecimenContext(page, options.specimenLegendSourceIds ?? []);
  const scopeBreaks = looseScopeBreaks(rows);
  const measurements: HeaderTableMeasurement[] = [];
  let candidates = 0;
  let rowsWithPreviousColumn = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const owner = headerRows
      .filter(
        ({ row: headerRow, rowIndex: headerIndex }) =>
          headerIndex < rowIndex &&
          ![...scopeBreaks].some(
            (breakIndex) => breakIndex > headerIndex && breakIndex <= rowIndex,
          ) &&
          (headerRow.tableId === null ? row.tableId === null : row.tableId === headerRow.tableId),
      )
      .at(-1);
    if (owner === undefined) continue;
    if (row.cells.some((cell) => inBoundary(cell, owner.header.boundaries.previous)))
      rowsWithPreviousColumn += 1;
    candidates += 1;
    const continuation = labelContinuationCells(rows, rowIndex, owner.header);
    const measurementRow =
      continuation.length === 0
        ? row
        : {
            ...row,
            cells: [...row.cells, ...continuation].sort(
              (left, right) => left.sourceOrder - right.sourceOrder,
            ),
          };
    const measurement = candidateMeasurement(
      page,
      measurementRow,
      owner.header,
      collectionDate,
      specimenContext,
      measurements.length,
    );
    if (measurement !== null) measurements.push(measurement);
  }
  return {
    measurements,
    counts: {
      pages: 1,
      rows: rows.length,
      headerRows: headerRows.length,
      candidates,
      measurements: measurements.length,
      rowsWithPreviousColumn,
    },
  };
}

export function extractHeaderTablePages(
  pages: readonly HeaderTablePage[],
  options: HeaderTableExtractionOptions = {},
): HeaderTableExtraction {
  const legendSourceIds = options.specimenLegendSourceIds ?? specimenLegendSourceIds(pages);
  const all = pages.map((page) =>
    extractHeaderTablePage(page, { ...options, specimenLegendSourceIds: legendSourceIds }),
  );
  const counts = all.reduce<Record<string, number>>((result, extraction) => {
    for (const [key, value] of Object.entries(extraction.counts))
      result[key] = (result[key] ?? 0) + value;
    return result;
  }, {});
  return { measurements: all.flatMap((item) => item.measurements), counts };
}
