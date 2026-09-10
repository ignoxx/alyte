import type { EvaluationComparator, EvaluationMeasurement } from './contract';

export type VisionBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type VisionStructure = {
  readonly kind?: string;
  readonly tableId?: string;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
};

export type VisionSpan = {
  readonly id?: string;
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly boundingBox?: VisionBoundingBox;
};

export type VisionObservation = {
  readonly id: string;
  readonly text: string;
  readonly pageIndex?: number;
  readonly structure?: VisionStructure;
  readonly boundingBox?: VisionBoundingBox;
  readonly spans?: readonly VisionSpan[];
  /** Character offsets in the native page text, when the adapter provides them. */
  readonly sourceStart?: number;
  readonly sourceEnd?: number;
};

export type VisionPage = {
  readonly pageIndex: number;
  readonly observations: readonly VisionObservation[];
};

export type GroundingRejectReason =
  | 'label-not-found'
  | 'value-not-found'
  | 'not-same-row-or-span'
  | 'ambiguous-source-span'
  | 'duplicate-occurrence';

export type GroundingOptions = {
  /** Maximum normalized vertical gap for a two-line source span. */
  readonly maxSpanGap?: number;
  /** Maximum vertical gap for observations considered one line. */
  readonly lineGap?: number;
};

export type GroundingDiagnostics = {
  readonly proposalCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly rejectedByReason: Readonly<Record<GroundingRejectReason, number>>;
  readonly acceptedByPage: Readonly<Record<string, number>>;
  readonly rejectedByPage: Readonly<Record<string, number>>;
  readonly sourceFieldCounts: {
    readonly unit: number;
    readonly referenceInterval: number;
    readonly flag: number;
    readonly collectionDateUnresolved: number;
    readonly specimenUnresolved: number;
    readonly mappingUnresolved: number;
  };
};

export type GroundingResult = {
  readonly measurements: readonly EvaluationMeasurement[];
  readonly diagnostics: GroundingDiagnostics;
};

type InternalCandidate = {
  readonly key: string;
  readonly labelObservationId: string;
  readonly labelText: string;
  readonly labelTextRange?: { readonly end: number; readonly start: number };
  readonly rank: 0 | 1 | 2;
  readonly distance: number;
  readonly observations: readonly VisionObservation[];
  readonly valueBoundingBox?: VisionBoundingBox;
  readonly valueObservationId: string;
  readonly valueText: string;
  readonly valueTextRange?: { readonly end: number; readonly start: number };
};

type SourceAtom = {
  readonly observation: VisionObservation;
  readonly text: string;
  readonly boundingBox?: VisionBoundingBox;
  readonly isSpan: boolean;
};

type InternalPage = {
  readonly observations: readonly VisionObservation[];
  readonly lines: readonly (readonly VisionObservation[])[];
  readonly lineById: ReadonlyMap<string, readonly VisionObservation[]>;
  readonly resultColumnX: number | null;
  readonly resultHeaderGroups: readonly ResultHeaderGroup[];
};

type ResultColumnAnchor = {
  readonly x: number;
  readonly layout: readonly number[];
};

type HeaderScan = {
  readonly anchor: ResultColumnAnchor | null;
  readonly hasPreviousResultHeader: boolean;
};

type HeaderRole = 'result' | 'previous' | 'reference' | 'unit' | 'flag';

type HeaderMarker = {
  readonly boundingBox?: VisionBoundingBox;
  readonly columnIndex: number | null;
  readonly role: HeaderRole;
  readonly tableId: string | null;
  readonly x: number;
  readonly y: number;
};

type ResultHeaderGroup = {
  readonly id: string;
  readonly tableId: string | null;
  readonly result: HeaderMarker;
  readonly resultColumnInterval: { readonly left: number; readonly right: number } | null;
  readonly competingColumnIndexes: readonly number[];
  readonly competingColumnIntervals: readonly {
    readonly interval: { readonly left: number; readonly right: number };
    readonly role: Exclude<HeaderRole, 'result'>;
  }[];
  readonly references: readonly HeaderMarker[];
};

type ResultColumnOwnership = 'owned' | 'competing' | 'unknown';

const DEFAULT_MAX_SPAN_GAP = 0.018;
const DEFAULT_LINE_GAP = 0.009;

type NumericToken = {
  readonly comparator: EvaluationComparator;
  readonly raw: string;
  readonly end: number;
  readonly start: number;
  readonly value: number;
};

type SourceValueMatch = {
  readonly boundingBox?: VisionBoundingBox;
  readonly end?: number;
  readonly start?: number;
  readonly text: string;
};

const NUMERIC_TOKEN = /(?:<=|>=|≤|≥|<|>|=)?\s*[+-]?(?:\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?|[.,]\d+)/gu;
const PURE_NUMERIC = /^(?:<=|>=|≤|≥|<|>|=)?\s*[+-]?(?:\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?|[.,]\d+)$/u;
const RANGE_ONLY =
  /^\s*(?:<=|>=|≤|≥|<|>|=)?\s*[+-]?(?:\d+(?:[.,]\d+)*|[.,]\d+)\s*[-–—]\s*[+-]?(?:\d+(?:[.,]\d+)*|[.,]\d+)\s*$/u;
const EMPTY_RESULT_PLACEHOLDER = /^(?:[-–—]|\.{2,}|…+)$/u;

const CATEGORICAL_VALUES = new Set([
  'absent',
  'abnormal',
  'amber',
  'black',
  'blue',
  'brown',
  'clear',
  'cloudy',
  'colorless',
  'colourless',
  'detected',
  'dark yellow',
  'few',
  'gray',
  'green',
  'grey',
  'hazy',
  'light yellow',
  'large',
  'many',
  'medium',
  'milky',
  'moderate',
  'negative',
  'not detected',
  'normal',
  'non-reactive',
  'nonreactive',
  'none detected',
  'none seen',
  'not seen',
  'numerous',
  'occasional',
  'opaque',
  'orange',
  'pale yellow',
  'positive',
  'present',
  'purple',
  'rare',
  'reactive',
  'red',
  'scant',
  'slight',
  'slightly cloudy',
  'slightly turbid',
  'small',
  'straw',
  'trace',
  'transparent',
  'turbid',
  'unauffällig',
  'very cloudy',
  'white',
  'yellow',
  'bernsteinfarben',
  'bespalvis',
  'drumstas',
  'gelb',
  'geltonas',
  'hellgelb',
  'klar',
  'skaidrus',
  'trüb',
  'nicht nachweisbar',
  'negativ',
  'positiv',
  'nerasta',
]);

const STATUS_VALUES = new Set([
  'cancelled',
  'canceled',
  'insufficient',
  'invalid',
  'not applicable',
  'not available',
  'not done',
  'not evaluated',
  'not performed',
  'not reported',
  'pending',
  'unknown',
  'unavailable',
  'unable to perform',
  'ausstehend',
  'nicht durchgeführt',
  'nicht bewertet',
  'nicht verfügbar',
  'ungültig',
  'neatlikta',
]);

function normalize(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function normalizeSourceText(value: string): string {
  return value.normalize('NFKC').replace(/\u00a0/gu, ' ');
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

/** Match a complete normalized token or phrase inside a native observation. */
function containsExact(source: string, query: string): boolean {
  const sourceText = normalize(source);
  const queryText = normalize(query);
  if (queryText.length === 0) return false;
  let index = -1;
  while ((index = sourceText.indexOf(queryText, index + 1)) >= 0) {
    if (
      !isWordCharacter(sourceText[index - 1]) &&
      !isWordCharacter(sourceText[index + queryText.length])
    ) {
      return true;
    }
  }
  return false;
}

function normalizedComparator(value: string): EvaluationComparator {
  if (value === '≤') return '<=';
  if (value === '≥') return '>=';
  if (value === '<' || value === '>' || value === '=' || value === '<=' || value === '>=') {
    return value;
  }
  return null;
}

function parseNumericLiteral(value: string): number | null {
  let scalar = value.replace(/[\s\u00a0]/gu, '');
  if (scalar.length === 0) return null;
  scalar = scalar.replace(/^[<>≤≥=]+/u, '');
  scalar = scalar.replace(/^([+-])(?=\d)/u, '$1');
  const sign = scalar.startsWith('-') ? -1 : 1;
  scalar = scalar.replace(/^[+-]/u, '');
  if (!/^(?:\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?|[.,]\d+)$/u.test(scalar)) return null;

  const exponentIndex = scalar.search(/[eE]/u);
  const mantissa = exponentIndex < 0 ? scalar : scalar.slice(0, exponentIndex);
  const exponent = exponentIndex < 0 ? '' : scalar.slice(exponentIndex);
  const separators = [...mantissa.matchAll(/[.,]/gu)].map((match) => match.index ?? 0);
  let normalizedMantissa: string;
  if (separators.length === 0) {
    normalizedMantissa = mantissa;
  } else if (separators.length === 1) {
    normalizedMantissa = mantissa.replace(',', '.');
  } else {
    const lastSeparator = Math.max(...separators);
    const fractionDigits = mantissa.length - lastSeparator - 1;
    const groups = mantissa.split(/[.,]/u);
    const separatorIsThousands =
      fractionDigits === 3 &&
      groups.length > 2 &&
      groups.slice(1).every((group) => group.length === 3);
    if (separatorIsThousands) {
      normalizedMantissa = mantissa.replace(/[.,]/gu, '');
    } else {
      normalizedMantissa =
        mantissa.slice(0, lastSeparator).replace(/[.,]/gu, '') +
        '.' +
        mantissa.slice(lastSeparator + 1);
    }
  }
  const parsed = Number(`${sign < 0 ? '-' : ''}${normalizedMantissa}${exponent}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearestNonWhitespace(
  source: string,
  index: number,
  direction: -1 | 1,
): { readonly character: string | undefined; readonly index: number } {
  let cursor = index + direction;
  while (cursor >= 0 && cursor < source.length && /\s/u.test(source[cursor] ?? '')) {
    cursor += direction;
  }
  return { character: source[cursor], index: cursor };
}

function hasRangeOrDateContext(source: string, start: number, end: number): boolean {
  const previous = nearestNonWhitespace(source, start, -1);
  const next = nearestNonWhitespace(source, end - 1, 1);
  const separators = new Set(['-', '–', '—']);
  if (separators.has(source[start] ?? '') && /\d/u.test(previous.character ?? '')) return true;
  if (separators.has(previous.character ?? '') || separators.has(next.character ?? '')) {
    return true;
  }
  const slashBefore = previous.character === '/';
  const slashAfter = next.character === '/';
  if (slashBefore || slashAfter) {
    const beforeSlash = slashBefore
      ? nearestNonWhitespace(source, previous.index, -1).character
      : undefined;
    const afterSlash = slashAfter
      ? nearestNonWhitespace(source, next.index, 1).character
      : undefined;
    if (
      (slashBefore && /\d/u.test(beforeSlash ?? '')) ||
      (slashAfter && /\d/u.test(afterSlash ?? ''))
    ) {
      return true;
    }
  }
  const beforeText = source.slice(0, start);
  const afterText = source.slice(end);
  return (
    /(?:^|\s)(?:to|bis)\s*$/iu.test(beforeText) || /^(?:\s*)(?:to|bis)(?:\s|$)/iu.test(afterText)
  );
}

function numericTokens(value: string): readonly NumericToken[] {
  const source = normalizeSourceText(value);
  const tokens: NumericToken[] = [];
  for (const match of source.matchAll(NUMERIC_TOKEN)) {
    const matchIndex = match.index ?? 0;
    const raw = match[0];
    // NUMERIC_TOKEN permits whitespace before a number so that a comparator
    // can be separated from it. Strip only that leading whitespace before
    // applying token boundaries; otherwise `Marker 12` is rejected because
    // the match starts on the space after the label.
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const index = matchIndex + leadingWhitespace;
    const token = raw.trimStart();
    const before = source[index - 1];
    const after = source[index + token.length];
    if (isWordCharacter(before) || isWordCharacter(after)) continue;
    if (hasRangeOrDateContext(source, index, index + token.length)) continue;
    const comparatorMatch = token.match(/^(<=|>=|≤|≥|<|>|=)/u);
    const scalar = token.slice(comparatorMatch?.[0].length ?? 0);
    const parsed = parseNumericLiteral(scalar);
    if (parsed === null) continue;
    tokens.push({
      comparator: normalizedComparator(comparatorMatch?.[1] ?? ''),
      raw: token.trim(),
      start: index,
      end: index + token.length,
      value: parsed,
    });
  }
  return tokens;
}

function exactTextMatch(source: string, query: string): string | null {
  return exactTextRange(source, query)?.text ?? null;
}

function exactTextRange(
  source: string,
  query: string,
): { readonly end: number; readonly start: number; readonly text: string } | null {
  const sourceText = normalizeSourceText(source);
  const queryText = normalizeSourceText(query).trim();
  if (queryText.length === 0) return null;
  const sourceLower = sourceText.toLocaleLowerCase('en-US');
  const queryLower = queryText.toLocaleLowerCase('en-US');
  let index = -1;
  while ((index = sourceLower.indexOf(queryLower, index + 1)) >= 0) {
    if (
      !isWordCharacter(sourceLower[index - 1]) &&
      !isWordCharacter(sourceLower[index + queryLower.length])
    ) {
      return {
        text: sourceText.slice(index, index + queryText.length).trim(),
        start: index,
        end: index + queryText.length,
      };
    }
  }
  return normalize(source) === normalize(query)
    ? { text: sourceText.trim(), start: 0, end: sourceText.length }
    : null;
}

function nativeSpanBox(
  spans: readonly VisionSpan[] | undefined,
  text: string,
): VisionBoundingBox | undefined {
  return spans?.find((span) => normalize(span.text) === normalize(text))?.boundingBox;
}

function isCategoricalResultValue(value: string): boolean {
  const normalized = normalize(value).replace(/[.!]+$/gu, '');
  if (STATUS_VALUES.has(normalized)) return false;
  return CATEGORICAL_VALUES.has(normalized) || /^[1-4]\+$/u.test(normalized);
}

function sourceValueMatch(
  source: string,
  query: string,
  sourceSpans?: readonly VisionSpan[],
): SourceValueMatch | null {
  const normalizedQuery = normalizeSourceText(query).trim();
  if (EMPTY_RESULT_PLACEHOLDER.test(normalizedQuery)) return null;
  if (!PURE_NUMERIC.test(normalizedQuery) || RANGE_ONLY.test(normalizedQuery)) {
    const match = exactTextRange(source, query);
    const boundingBox = match === null ? undefined : nativeSpanBox(sourceSpans, match.text);
    return match === null
      ? null
      : {
          text: match.text,
          start: match.start,
          end: match.end,
          ...(boundingBox === undefined ? {} : { boundingBox }),
        };
  }
  const queryToken = numericTokens(normalizedQuery)[0];
  if (queryToken === undefined) return null;
  const matches = numericTokens(source).filter(
    (sourceToken) =>
      sourceToken.comparator === queryToken.comparator && sourceToken.value === queryToken.value,
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  if (match === undefined) return null;
  const boundingBox = nativeSpanBox(sourceSpans, match.raw);
  return {
    text: match.raw,
    start: match.start,
    end: match.end,
    ...(boundingBox === undefined ? {} : { boundingBox }),
  };
}

function normalizeUnitForSelection(value: string): string {
  return value
    .replace(/\u00a0/gu, ' ')
    .replace(/μ/gu, 'µ')
    .replace(/\s*\/\s*/gu, '/')
    .replace(/\s+/gu, ' ')
    .trim();
}

function boxesAreDisjoint(
  left: VisionBoundingBox | undefined,
  right: VisionBoundingBox | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function hasDisjointSourceSpans(
  observation: VisionObservation,
  label: string,
  value: string,
): boolean {
  const spans = observation.spans;
  if (spans === undefined || spans.length < 2) return false;
  const labelSpans = spans.flatMap((span, index) =>
    exactTextRange(span.text, label) === null ? [] : [{ index, span }],
  );
  const valueSpans = spans.flatMap((span, index) =>
    sourceValueMatch(span.text, value) === null ? [] : [{ index, span }],
  );
  return labelSpans.some((labelSpan) =>
    valueSpans.some((valueSpan) => {
      if (labelSpan.index === valueSpan.index) return false;
      const labelRange = exactTextRange(labelSpan.span.text, label);
      const valueRange = sourceValueMatch(valueSpan.span.text, value);
      if (labelRange !== null && valueRange?.start !== undefined && valueRange.end !== undefined) {
        if (labelRange.end <= valueRange.start || valueRange.end <= labelRange.start) {
          return true;
        }
      }
      return boxesAreDisjoint(labelSpan.span.boundingBox, valueSpan.span.boundingBox);
    }),
  );
}

function valueMatches(source: string, query: string): boolean {
  return sourceValueMatch(source, query) !== null;
}

function centerY(observation: VisionObservation): number {
  const box = observation.boundingBox;
  return box === undefined ? 0 : box.y + box.height / 2;
}

function tableKey(observation: VisionObservation, pageIndex: number): string | null {
  const structure = observation.structure;
  if (
    structure?.kind !== 'table-cell' ||
    structure.tableId === undefined ||
    structure.rowIndex === undefined
  ) {
    return null;
  }
  return `${pageIndex}|table|${structure.tableId}|${structure.rowIndex}`;
}

function lineGroups(
  observations: readonly VisionObservation[],
  lineGap: number,
): readonly (readonly VisionObservation[])[] {
  const nonTable = observations
    .filter((observation) => tableKey(observation, observation.pageIndex ?? 0) === null)
    .toSorted((left, right) => centerY(left) - centerY(right));
  const lines: VisionObservation[][] = [];
  const centers: number[] = [];
  for (const observation of nonTable) {
    const lineIndex = lines.length - 1;
    if (lineIndex >= 0 && Math.abs(centerY(observation) - centers[lineIndex]) <= lineGap) {
      lines[lineIndex].push(observation);
      centers[lineIndex] =
        (centers[lineIndex] * (lines[lineIndex].length - 1) + centerY(observation)) /
        lines[lineIndex].length;
    } else {
      lines.push([observation]);
      centers.push(centerY(observation));
    }
  }
  return lines;
}

function preparePages(
  pages: readonly VisionPage[],
  lineGap: number,
): ReadonlyMap<number, InternalPage> {
  const result = new Map<number, InternalPage>();
  const scans = pages.map((page) => ({
    pageIndex: page.pageIndex,
    layout: layoutFingerprint(page.observations),
    scan: scanResultHeader(page.observations),
    resultHeaderGroups: scanResultHeaderGroups(page.observations),
  }));
  const anchors = scans.flatMap((entry) =>
    entry.scan.anchor === null ? [] : [{ ...entry.scan.anchor, pageIndex: entry.pageIndex }],
  );
  for (const page of pages) {
    const lines = lineGroups(page.observations, lineGap);
    const lineById = new Map<string, readonly VisionObservation[]>();
    for (const line of lines) {
      for (const observation of line) lineById.set(observation.id, line);
    }
    const current = scans.find((entry) => entry.pageIndex === page.pageIndex)!;
    let resultColumnX = current.scan.anchor?.x ?? null;
    if (resultColumnX === null && !current.scan.hasPreviousResultHeader) {
      const matchingAnchors = anchors.filter(
        (anchor) =>
          anchor.pageIndex !== page.pageIndex &&
          layoutSimilarity(current.layout, anchor.layout) >= MIN_LAYOUT_SIMILARITY,
      );
      const uniqueX = [...new Set(matchingAnchors.map((anchor) => anchor.x.toFixed(4)))].map(
        Number,
      );
      resultColumnX = uniqueX.length === 1 ? uniqueX[0]! : null;
    }
    result.set(page.pageIndex, {
      observations: page.observations,
      lines,
      lineById,
      resultColumnX,
      resultHeaderGroups: current.resultHeaderGroups,
    });
  }
  return result;
}

const LAYOUT_BIN_SIZE = 0.04;
const MIN_LAYOUT_BINS = 8;
const MIN_LAYOUT_SIMILARITY = 0.9;
const RESULT_HEADER = /(?:result|rezultat|ergebnis)/iu;
const RESULT_HEADER_CONTEXT =
  /(?:unit|einheit|vienetas|norm|riba|reference|referenz|flag|status|current|present|latest|tyrimo|dabart|aktuell)/iu;
const PREVIOUS_RESULT_CONTEXT =
  /(?:previous|prior|former|historical|earlier|last|old|ankstesn|praeit|vorherig|früher|zuvor)/iu;
const CURRENT_RESULT_CONTEXT =
  /(?:current|present|latest|new|actual|today|now|tyrimo|dabart|aktuell|heutig|jetzt)/iu;
const RECOGNIZED_INLINE_FLAG = /^(?:h|l|high|low|a|abnormal|positive|negative|[+−-]|[↑↓↗↘])$/iu;
const HEADER_ROLE_PATTERNS: Readonly<Record<Exclude<HeaderRole, 'result' | 'previous'>, RegExp>> = {
  reference: /(?:reference|referenz|norm|range|interval|intervall|riba|referens)/iu,
  unit: /(?:unit|einheit|vienet(?:as|ai)?|enot(?:a|os)|jednost)/iu,
  flag: /(?:flag|status|mark(?:er|ing)?)/iu,
};
const HEADER_ROLE_MAX_Y_GAP = 0.02;

function centerX(box: VisionBoundingBox | undefined): number | null {
  return box === undefined ? null : box.x + box.width / 2;
}

function observationSpans(observation: VisionObservation): readonly VisionSpan[] {
  return observation.spans?.length === 0 || observation.spans === undefined
    ? [{ text: observation.text, boundingBox: observation.boundingBox }]
    : observation.spans;
}

function layoutFingerprint(observations: readonly VisionObservation[]): readonly number[] {
  const bins = new Set<number>();
  for (const observation of observations) {
    const x = centerX(observation.boundingBox);
    if (x !== null) bins.add(Math.round(x / LAYOUT_BIN_SIZE));
  }
  return [...bins].toSorted((left, right) => left - right);
}

function layoutSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length < MIN_LAYOUT_BINS || right.length < MIN_LAYOUT_BINS) return 0;
  const rightSet = new Set(right);
  const intersection = left.filter((bin) => rightSet.has(bin)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function spanHeaderContext(observation: VisionObservation, span: VisionSpan): string {
  const source = normalizeSourceText(observation.text);
  const spanText = normalizeSourceText(span.text);
  const sourceHasPrevious = PREVIOUS_RESULT_CONTEXT.test(source);
  const sourceHasCurrent = CURRENT_RESULT_CONTEXT.test(source);
  const spanHasPrevious = PREVIOUS_RESULT_CONTEXT.test(spanText);
  const spanHasCurrent = CURRENT_RESULT_CONTEXT.test(spanText);
  if (spanHasPrevious || spanHasCurrent) return spanText;
  if (sourceHasPrevious && sourceHasCurrent) return '';
  if (span.start !== undefined && span.start >= 0 && span.start < source.length) {
    const end = span.end ?? span.start + span.text.length;
    return source.slice(Math.max(0, span.start - 32), Math.min(source.length, end + 32));
  }
  const index = source.toLocaleLowerCase('en-US').indexOf(spanText.toLocaleLowerCase('en-US'));
  return index < 0 ? source : source.slice(Math.max(0, index - 32), index + spanText.length + 32);
}

function scanResultHeader(observations: readonly VisionObservation[]): HeaderScan {
  const candidates: { readonly x: number; readonly y: number }[] = [];
  let hasPreviousResultHeader = false;
  for (const observation of observations) {
    const tableHeader =
      observation.structure?.kind === 'table-cell' && observation.structure.rowIndex === 0;
    for (const span of observationSpans(observation)) {
      if (!RESULT_HEADER.test(span.text)) continue;
      const context = spanHeaderContext(observation, span);
      const previous = PREVIOUS_RESULT_CONTEXT.test(context);
      const current = CURRENT_RESULT_CONTEXT.test(context);
      if (previous && !current) {
        hasPreviousResultHeader = true;
        continue;
      }
      if (previous && current && (observation.spans?.length ?? 0) <= 1) continue;
      const headerContext =
        tableHeader || RESULT_HEADER_CONTEXT.test(context) || CURRENT_RESULT_CONTEXT.test(context);
      if (!headerContext) continue;
      const x = centerX(span.boundingBox ?? observation.boundingBox);
      const y = span.boundingBox?.y ?? observation.boundingBox?.y;
      if (x !== null && y !== undefined) candidates.push({ x, y });
    }
  }
  const first = candidates.toSorted((left, right) => left.y - right.y)[0];
  return {
    anchor: first === undefined ? null : { x: first.x, layout: layoutFingerprint(observations) },
    hasPreviousResultHeader,
  };
}

function scanHeaderRoleMarkers(
  observations: readonly VisionObservation[],
): readonly HeaderMarker[] {
  const markers: HeaderMarker[] = [];
  for (const observation of observations) {
    const tableHeader =
      observation.structure?.kind === 'table-cell' && observation.structure.rowIndex === 0;
    const tableId = observation.structure?.tableId ?? null;
    for (const span of observationSpans(observation)) {
      const box = span.boundingBox ?? observation.boundingBox;
      const x = centerX(box);
      const y = box?.y;
      if (x === null || y === undefined) continue;
      const context = spanHeaderContext(observation, span);
      const previous = PREVIOUS_RESULT_CONTEXT.test(context);
      const current =
        CURRENT_RESULT_CONTEXT.test(context) || CURRENT_RESULT_CONTEXT.test(span.text);
      const resultHeader =
        RESULT_HEADER.test(span.text) &&
        !(previous && current && (observation.spans?.length ?? 0) <= 1) &&
        (!previous || current) &&
        (tableHeader || current || RESULT_HEADER_CONTEXT.test(context));
      const roles: HeaderRole[] = resultHeader
        ? ['result']
        : RESULT_HEADER.test(span.text) && previous && !current
          ? ['previous']
          : [];
      for (const [role, pattern] of Object.entries(HEADER_ROLE_PATTERNS) as [
        Exclude<HeaderRole, 'result' | 'previous'>,
        RegExp,
      ][]) {
        if (pattern.test(span.text)) roles.push(role);
      }
      for (const role of roles) {
        markers.push({
          ...(box === undefined ? {} : { boundingBox: box }),
          columnIndex: observation.structure?.columnIndex ?? null,
          role,
          tableId,
          x,
          y,
        });
      }
    }
  }
  return markers;
}

function resultColumnInterval(
  result: HeaderMarker,
  peers: readonly HeaderMarker[],
): { readonly left: number; readonly right: number } | null {
  const peerXs = peers
    .filter((peer) => peer.role !== 'result' && Math.abs(peer.x - result.x) > 0.01)
    .map((peer) => peer.x);
  const left = peerXs
    .filter((x) => x < result.x)
    .reduce<number | null>((best, x) => (best === null || x > best ? x : best), null);
  const right = peerXs
    .filter((x) => x > result.x)
    .reduce<number | null>((best, x) => (best === null || x < best ? x : best), null);
  const headerLeft = result.boundingBox?.x ?? result.x;
  const headerRight =
    result.boundingBox === undefined ? result.x : result.boundingBox.x + result.boundingBox.width;
  const intervalLeft = left === null ? headerLeft : (left + result.x) / 2;
  const intervalRight = right === null ? headerRight : (right + result.x) / 2;
  return intervalLeft < intervalRight ? { left: intervalLeft, right: intervalRight } : null;
}

function roleColumnInterval(
  marker: HeaderMarker,
  result: HeaderMarker,
  peers: readonly HeaderMarker[],
): { readonly left: number; readonly right: number } | null {
  const otherXs = [result, ...peers]
    .filter((other) => Math.abs(other.x - marker.x) > 0.01)
    .map((other) => other.x);
  const left = otherXs
    .filter((x) => x < marker.x)
    .reduce<number | null>((best, x) => (best === null || x > best ? x : best), null);
  const right = otherXs
    .filter((x) => x > marker.x)
    .reduce<number | null>((best, x) => (best === null || x < best ? x : best), null);
  const markerLeft = marker.boundingBox?.x ?? marker.x;
  const markerRight =
    marker.boundingBox === undefined ? marker.x : marker.boundingBox.x + marker.boundingBox.width;
  const intervalLeft = left === null ? markerLeft : (left + marker.x) / 2;
  const intervalRight = right === null ? markerRight : (right + marker.x) / 2;
  return intervalLeft < intervalRight ? { left: intervalLeft, right: intervalRight } : null;
}

function scanResultHeaderGroups(
  observations: readonly VisionObservation[],
): readonly ResultHeaderGroup[] {
  const markers = scanHeaderRoleMarkers(observations);
  const results = markers.filter((marker) => marker.role === 'result');
  const groups: ResultHeaderGroup[] = [];
  for (const result of results) {
    const peers = markers.filter(
      (marker) =>
        marker.role !== 'result' &&
        (result.tableId !== null
          ? marker.tableId === result.tableId
          : marker.tableId === null && Math.abs(marker.y - result.y) <= HEADER_ROLE_MAX_Y_GAP),
    );
    groups.push({
      id: `${result.tableId ?? 'page'}|result|${result.x.toFixed(4)}|${result.y.toFixed(4)}`,
      tableId: result.tableId,
      result,
      resultColumnInterval: resultColumnInterval(result, peers),
      competingColumnIndexes: [
        ...new Set(
          peers
            .filter((peer) => Math.abs(peer.x - result.x) > 0.01)
            .map((peer) => peer.columnIndex)
            .filter((columnIndex): columnIndex is number => columnIndex !== null),
        ),
      ],
      competingColumnIntervals: peers.flatMap((peer) => {
        if (Math.abs(peer.x - result.x) <= 0.01) return [];
        const interval = roleColumnInterval(peer, result, peers);
        return interval === null ? [] : [{ role: peer.role, interval }];
      }),
      references: peers.filter((marker) => marker.role === 'reference'),
    });
  }
  // A duplicated result header in one table is ambiguous; selection below
  // rejects it instead of silently choosing one column.
  return groups;
}

function unionLocation(observations: readonly VisionObservation[]): VisionBoundingBox | null {
  const boxes = observations
    .map((observation) => observation.boundingBox)
    .filter((box): box is VisionBoundingBox => box !== undefined);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function uniqueById(observations: readonly VisionObservation[]): VisionObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    if (seen.has(observation.id)) return false;
    seen.add(observation.id);
    return true;
  });
}

function buildCandidates(
  page: InternalPage,
  pageIndex: number,
  proposal: EvaluationMeasurement,
  maxSpanGap: number,
): readonly InternalCandidate[] {
  if (proposal.valueString === null) return [];
  const labels = page.observations.flatMap((observation) => {
    const match = exactTextRange(observation.text, proposal.sourceLabel);
    return match === null
      ? []
      : [{ observation, text: match.text, textRange: { start: match.start, end: match.end } }];
  });
  const values = page.observations.flatMap((observation) => {
    const match = sourceValueMatch(observation.text, proposal.valueString!, observation.spans);
    return match === null ? [] : [{ match, observation }];
  });
  const candidates: InternalCandidate[] = [];
  const seen = new Set<string>();
  for (const labelEntry of labels) {
    const label = labelEntry.observation;
    for (const valueEntry of values) {
      const value = valueEntry.observation;
      const labelTable = tableKey(label, pageIndex);
      const valueTable = tableKey(value, pageIndex);
      if (
        label.id === value.id &&
        labelEntry.textRange.start < (valueEntry.match.end ?? 0) &&
        (valueEntry.match.start ?? Number.MAX_SAFE_INTEGER) < labelEntry.textRange.end &&
        !hasDisjointSourceSpans(label, proposal.sourceLabel, proposal.valueString)
      ) {
        // A value token contained in the native label text is commonly a
        // footnote or another label fragment, not an independently owned
        // result value.
        continue;
      }
      let rank: 0 | 1 | 2 | null = null;
      let observations: readonly VisionObservation[] = [];
      let key = '';
      const distance = Math.abs(centerY(label) - centerY(value));
      if (labelTable !== null && labelTable === valueTable) {
        rank = 0;
        observations = page.observations.filter(
          (observation) => tableKey(observation, pageIndex) === labelTable,
        );
        key = labelTable;
      } else {
        const labelLine = page.lineById.get(label.id);
        const valueLine = page.lineById.get(value.id);
        if (labelLine !== undefined && labelLine === valueLine) {
          rank = 1;
          observations = labelLine;
          key = `${pageIndex}|line|${labelLine.map((item) => item.id).join(',')}|value|${value.id}`;
        } else if (distance <= maxSpanGap && contiguousSourceSpan(label, value)) {
          rank = 2;
          observations = uniqueById([...(labelLine ?? [label]), ...(valueLine ?? [value])]);
          key = `${pageIndex}|span|${label.id}|${value.id}`;
        }
      }
      if (rank === null || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        key,
        labelObservationId: label.id,
        labelText: labelEntry.text,
        labelTextRange: labelEntry.textRange,
        rank,
        distance,
        observations,
        ...(valueEntry.match.boundingBox === undefined
          ? {}
          : { valueBoundingBox: valueEntry.match.boundingBox }),
        valueObservationId: value.id,
        valueText: valueEntry.match.text,
        ...(valueEntry.match.start === undefined || valueEntry.match.end === undefined
          ? {}
          : {
              valueTextRange: {
                start: valueEntry.match.start,
                end: valueEntry.match.end,
              },
            }),
      });
    }
  }
  return candidates;
}

function contiguousSourceSpan(left: VisionObservation, right: VisionObservation): boolean {
  if (
    !Number.isFinite(left.sourceStart) ||
    !Number.isFinite(left.sourceEnd) ||
    !Number.isFinite(right.sourceStart) ||
    !Number.isFinite(right.sourceEnd) ||
    left.sourceEnd === undefined ||
    left.sourceStart === undefined ||
    right.sourceEnd === undefined ||
    right.sourceStart === undefined ||
    left.sourceEnd < left.sourceStart ||
    right.sourceEnd < right.sourceStart
  ) {
    return false;
  }
  const gap = Math.max(
    0,
    Math.max(left.sourceStart, right.sourceStart) - Math.min(left.sourceEnd, right.sourceEnd),
  );
  return gap <= 2;
}

function sourceField(
  observations: readonly VisionObservation[],
  modelValue: string | null,
): string | null {
  if (modelValue === null) return null;
  // Exact native observations only: do not copy a model field from a larger row
  // or synthesize a field by parsing neighboring text.
  return (
    observations.find((observation) => normalize(observation.text) === normalize(modelValue))
      ?.text ?? null
  );
}

function sourceUnitField(
  observations: readonly VisionObservation[],
  modelValue: string | null,
): string | null {
  if (modelValue === null) return null;
  // Unit is a source field. Permit only Unicode micro-glyph and separator formatting equivalence;
  // preserve the native text and leave case-sensitive differences unresolved.
  const modelSelection = normalizeUnitForSelection(modelValue);
  return (
    observations.find(
      (observation) => normalizeUnitForSelection(observation.text) === modelSelection,
    )?.text ?? null
  );
}

function sourceAtoms(observations: readonly VisionObservation[]): readonly SourceAtom[] {
  return observations.flatMap<SourceAtom>((observation): SourceAtom[] => {
    if (observation.spans !== undefined && observation.spans.length > 0) {
      return observation.spans.map((span) => ({
        observation,
        text: span.text,
        boundingBox: span.boundingBox ?? observation.boundingBox,
        isSpan: true,
      }));
    }
    return [
      {
        observation,
        text: observation.text,
        boundingBox: observation.boundingBox,
        isSpan: false,
      },
    ];
  });
}

function hasUsableFlagGeometry(atom: SourceAtom): boolean {
  if (atom.isSpan) return atom.boundingBox !== undefined;
  if (atom.observation.structure?.kind === 'table-cell') return true;
  return atom.boundingBox !== undefined && atom.boundingBox.width <= 0.25;
}

function hasNativeSourceOffsets(atom: SourceAtom): boolean {
  return (
    Number.isFinite(atom.observation.sourceStart) &&
    Number.isFinite(atom.observation.sourceEnd) &&
    atom.observation.sourceStart !== undefined &&
    atom.observation.sourceEnd !== undefined &&
    atom.observation.sourceEnd >= atom.observation.sourceStart
  );
}

function sourceFlaggedResultMarker(
  candidate: InternalCandidate,
  modelValue: string | null,
): string | null {
  if (modelValue === null) return null;
  const matches = sourceAtoms(candidate.observations).filter(
    (atom) =>
      atom.observation.id === candidate.valueObservationId &&
      hasNativeSourceOffsets(atom) &&
      hasUsableFlagGeometry(atom) &&
      normalize(atom.text) !== normalize(candidate.valueText) &&
      normalize(atom.text) === normalize(modelValue) &&
      RECOGNIZED_INLINE_FLAG.test(normalize(atom.text)),
  );
  const unique = new Set(matches.map((match) => `${match.observation.id}:${match.text}`));
  return unique.size === 1 && matches.length === 1 ? matches[0]!.text.trim() : null;
}

function sourceTableFlag(
  page: InternalPage,
  pageIndex: number,
  candidate: InternalCandidate,
  modelValue: string | null,
): string | null {
  if (modelValue === null) return null;
  const tableIds = new Set(
    candidate.observations
      .map((observation) => observation.structure?.tableId)
      .filter((tableId): tableId is string => typeof tableId === 'string'),
  );
  if (tableIds.size !== 1) return null;
  const tableId = [...tableIds][0]!;
  const headerXs = page.observations.flatMap((observation) => {
    const structure = observation.structure;
    if (
      structure?.kind !== 'table-cell' ||
      structure.tableId !== tableId ||
      structure.rowIndex !== 0
    )
      return [];
    return sourceAtoms([observation])
      .filter((atom) => exactTextMatch(atom.text, 'Flag') !== null)
      .flatMap((atom) => {
        const x = centerX(atom.boundingBox);
        return x === null ? [] : [x];
      });
  });
  const distinctHeaderXs = headerXs.filter(
    (x, index) => headerXs.findIndex((other) => Math.abs(other - x) <= 0.01) === index,
  );
  if (distinctHeaderXs.length !== 1) return null;
  const rowMatches = sourceAtoms(candidate.observations).filter((atom) => {
    const structure = atom.observation.structure;
    const x = centerX(atom.boundingBox);
    return (
      structure?.kind === 'table-cell' &&
      structure.tableId === tableId &&
      x !== null &&
      Math.abs(x - distinctHeaderXs[0]!) <= 0.055 &&
      hasNativeSourceOffsets(atom) &&
      hasUsableFlagGeometry(atom) &&
      normalize(atom.text) === normalize(modelValue)
    );
  });
  const unique = new Set(rowMatches.map((match) => `${match.observation.id}:${match.text}`));
  return unique.size === 1 && rowMatches.length === 1 ? rowMatches[0]!.text.trim() : null;
}

function deriveValueFields(
  proposal: EvaluationMeasurement,
): Pick<EvaluationMeasurement, 'valueType' | 'parsedValue' | 'comparator'> {
  const raw = proposal.valueString?.normalize('NFKC').trim() ?? '';
  const comparatorMatch = raw.match(/^(<=|>=|≤|≥|<|>|=)\s*/u);
  const comparator = normalizedComparator(comparatorMatch?.[1] ?? '');
  const numberValue =
    PURE_NUMERIC.test(raw) && !RANGE_ONLY.test(raw) ? (numericTokens(raw)[0]?.value ?? null) : null;
  if (numberValue !== null) {
    return {
      valueType: comparator === null ? 'numeric' : 'bounded',
      parsedValue: numberValue,
      comparator,
    };
  }
  const categorical = isCategoricalResultValue(raw);
  if (proposal.valueType === 'categorical' || categorical) {
    return {
      valueType: 'categorical',
      parsedValue: proposal.valueString,
      comparator,
    };
  }
  if (proposal.valueType === 'text') {
    return { valueType: 'text', parsedValue: proposal.valueString, comparator };
  }
  if (proposal.valueString !== null && raw.length > 0) {
    return { valueType: 'text', parsedValue: proposal.valueString, comparator };
  }
  return { valueType: 'unknown', parsedValue: null, comparator };
}

function rejectCounts(): Record<GroundingRejectReason, number> {
  return {
    'label-not-found': 0,
    'value-not-found': 0,
    'not-same-row-or-span': 0,
    'ambiguous-source-span': 0,
    'duplicate-occurrence': 0,
  };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function candidateValueX(page: InternalPage, candidate: InternalCandidate): number | null {
  const valueObservation = page.observations.find(
    (observation) => observation.id === candidate.valueObservationId,
  );
  return centerX(candidate.valueBoundingBox ?? valueObservation?.boundingBox);
}

function selectResultHeaderGroup(
  page: InternalPage,
  candidate: InternalCandidate,
): ResultHeaderGroup | 'ambiguous' | null {
  const tableIds = new Set(
    candidate.observations
      .map((observation) => observation.structure?.tableId)
      .filter((tableId): tableId is string => typeof tableId === 'string'),
  );
  if (tableIds.size > 0) {
    const matches = page.resultHeaderGroups.filter(
      (group) => group.tableId !== null && tableIds.has(group.tableId),
    );
    return matches.length === 1 ? matches[0]! : matches.length > 1 ? 'ambiguous' : null;
  }

  const candidateY = Math.min(...candidate.observations.map((observation) => centerY(observation)));
  const preceding = page.resultHeaderGroups.filter(
    (group) => group.tableId === null && group.result.y <= candidateY,
  );
  if (preceding.length === 0) return null;
  const nearestY = Math.max(...preceding.map((group) => group.result.y));
  const nearest = preceding.filter((group) => Math.abs(group.result.y - nearestY) <= 0.003);
  if (nearest.length === 1) return nearest[0]!;
  const valueX = candidateValueX(page, candidate);
  const containing = nearest.filter((group) => {
    const interval = group.resultColumnInterval;
    return (
      valueX !== null && interval !== null && valueX >= interval.left && valueX <= interval.right
    );
  });
  return containing.length === 1 ? containing[0]! : 'ambiguous';
}

function candidateResultColumnOwnership(
  page: InternalPage,
  candidate: InternalCandidate,
): ResultColumnOwnership {
  const valueObservation = page.observations.find(
    (observation) => observation.id === candidate.valueObservationId,
  );
  if (valueObservation === undefined) return 'competing';
  const group = selectResultHeaderGroup(page, candidate);
  if (group === null) return 'unknown';
  if (group === 'ambiguous') return 'competing';
  if (group.tableId !== null && group.result.columnIndex !== null) {
    const columnIndex = valueObservation.structure?.columnIndex;
    if (columnIndex === group.result.columnIndex) return 'owned';
    return group.competingColumnIndexes.includes(columnIndex ?? Number.MIN_SAFE_INTEGER)
      ? 'competing'
      : 'unknown';
  }
  const valueX = candidateValueX(page, candidate);
  const interval = group.resultColumnInterval;
  if (valueX !== null && interval !== null && valueX >= interval.left && valueX <= interval.right) {
    return 'owned';
  }
  const competing = group.competingColumnIntervals.filter(
    ({ interval: roleInterval }) =>
      valueX !== null && valueX >= roleInterval.left && valueX <= roleInterval.right,
  );
  return competing.length > 0 ? 'competing' : 'unknown';
}

function referenceFieldFromHeader(
  page: InternalPage,
  candidate: InternalCandidate,
  modelValue: string | null,
): string | null {
  if (modelValue === null) return null;
  const group = selectResultHeaderGroup(page, candidate);
  if (group === 'ambiguous') return null;
  if (group === null || group.references.length === 0) {
    return sourceField(candidate.observations, modelValue);
  }
  const referenceColumnIndexes = group.references
    .map((marker) => marker.columnIndex)
    .filter((columnIndex): columnIndex is number => columnIndex !== null);
  const referenceIntervals = group.competingColumnIntervals
    .filter(({ role }) => role === 'reference')
    .map(({ interval }) => interval);
  const matches = candidate.observations.filter((observation) => {
    if (normalize(observation.text) !== normalize(modelValue)) return false;
    if (group.tableId !== null && referenceColumnIndexes.length > 0) {
      return referenceColumnIndexes.includes(observation.structure?.columnIndex ?? -1);
    }
    const x = centerX(observation.boundingBox);
    if (x === null) return false;
    return referenceIntervals.some((interval) => x >= interval.left && x <= interval.right);
  });
  return matches.length === 1 ? matches[0]!.text : null;
}

function chooseCandidate(
  page: InternalPage,
  candidates: readonly InternalCandidate[],
): InternalCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const bestRank = Math.min(...candidates.map((item) => item.rank));
  let ranked = candidates.filter((item) => item.rank === bestRank);
  const ownership = ranked.map((candidate) => ({
    candidate,
    resultColumn: candidateResultColumnOwnership(page, candidate),
  }));
  const owned = ownership.filter((item) => item.resultColumn === 'owned');
  if (owned.length > 0) {
    ranked = owned.map((item) => item.candidate);
  } else {
    const unresolved = ownership.filter((item) => item.resultColumn === 'unknown');
    if (unresolved.length === 0) return undefined;
    ranked = unresolved.map((item) => item.candidate);
  }
  if (page.resultColumnX !== null) {
    const located = ranked.filter((item) => centerX(item.valueBoundingBox) !== null);
    if (located.length > 0) {
      const closestColumn = Math.min(
        ...located.map((item) => Math.abs(centerX(item.valueBoundingBox)! - page.resultColumnX!)),
      );
      ranked = located.filter(
        (item) =>
          Math.abs(
            Math.abs(centerX(item.valueBoundingBox)! - page.resultColumnX!) - closestColumn,
          ) <= 0.003,
      );
    }
  }
  const bestDistance = Math.min(...ranked.map((item) => item.distance));
  let nearest = ranked.filter((item) => Math.abs(item.distance - bestDistance) <= 0.003);
  if (nearest.length === 1) return nearest[0];
  const sameObservation = nearest.filter(
    (item) => item.labelObservationId === item.valueObservationId,
  );
  if (sameObservation.length === 1) return sameObservation[0];
  return undefined;
}

export function groundVisionProposals(
  proposals: readonly EvaluationMeasurement[],
  pages: readonly VisionPage[],
  options: GroundingOptions = {},
): GroundingResult {
  const maxSpanGap = options.maxSpanGap ?? DEFAULT_MAX_SPAN_GAP;
  const lineGap = options.lineGap ?? DEFAULT_LINE_GAP;
  const prepared = preparePages(pages, lineGap);
  const rejectedByReason = rejectCounts();
  const acceptedByPage: Record<string, number> = {};
  const rejectedByPage: Record<string, number> = {};
  const sourceFieldCounts = {
    unit: 0,
    referenceInterval: 0,
    flag: 0,
    collectionDateUnresolved: 0,
    specimenUnresolved: 0,
    mappingUnresolved: 0,
  };
  const grounded: EvaluationMeasurement[] = [];
  const seenOccurrences = new Set<string>();

  for (const proposal of proposals) {
    const page = proposal.page === null ? null : proposal.page - 1;
    const preparedPage = page === null ? undefined : prepared.get(page);
    let reason: GroundingRejectReason | null = null;
    let candidate: InternalCandidate | undefined;
    if (preparedPage === undefined) reason = 'not-same-row-or-span';
    else if (
      !preparedPage.observations.some((observation) =>
        containsExact(observation.text, proposal.sourceLabel),
      )
    ) {
      reason = 'label-not-found';
    } else if (
      proposal.valueString === null ||
      !preparedPage.observations.some((observation) =>
        valueMatches(observation.text, proposal.valueString!),
      )
    ) {
      reason = 'value-not-found';
    } else {
      const candidates = buildCandidates(preparedPage, page!, proposal, maxSpanGap);
      if (candidates.length === 0) reason = 'not-same-row-or-span';
      else {
        candidate = chooseCandidate(preparedPage, candidates);
        if (candidate === undefined) reason = 'ambiguous-source-span';
      }
    }
    if (reason !== null || candidate === undefined) {
      const pageKey = String(proposal.page ?? 'unknown');
      increment(rejectedByReason, reason ?? 'not-same-row-or-span');
      increment(rejectedByPage, pageKey);
      continue;
    }

    const sourceIds = candidate.observations.map((observation) => observation.id).toSorted();
    const occurrenceKey = `${proposal.page ?? 'null'}\u0000${normalize(proposal.sourceLabel)}\u0000${normalize(proposal.valueString)}\u0000${sourceIds.join(',')}`;
    if (seenOccurrences.has(occurrenceKey)) {
      increment(rejectedByReason, 'duplicate-occurrence');
      increment(rejectedByPage, String(proposal.page ?? 'unknown'));
      continue;
    }
    seenOccurrences.add(occurrenceKey);

    const unit = sourceUnitField(candidate.observations, proposal.unit);
    const referenceInterval = referenceFieldFromHeader(
      preparedPage!,
      candidate,
      proposal.referenceInterval,
    );
    const flag =
      sourceFlaggedResultMarker(candidate, proposal.flag) ??
      sourceTableFlag(preparedPage!, page!, candidate, proposal.flag);
    if (unit !== null) sourceFieldCounts.unit++;
    if (referenceInterval !== null) sourceFieldCounts.referenceInterval++;
    if (flag !== null) sourceFieldCounts.flag++;
    sourceFieldCounts.collectionDateUnresolved++;
    sourceFieldCounts.specimenUnresolved++;
    sourceFieldCounts.mappingUnresolved++;

    const ambiguousFields = proposal.ambiguousFields
      .filter((field) => field !== 'sourceIds')
      .concat(['collectionDate', 'specimen', 'canonicalBiomarkerId'])
      .filter((field, index, fields) => fields.indexOf(field) === index)
      .toSorted();
    const unresolvedFields = (proposal.unresolvedFields ?? [])
      .filter((field) => field !== 'sourceIds')
      .concat(['collectionDate', 'specimen', 'canonicalBiomarkerId'])
      .filter((field, index, fields) => fields.indexOf(field) === index)
      .toSorted();
    const output: EvaluationMeasurement = {
      ...proposal,
      sourceLabel: candidate.labelText,
      valueString: candidate.valueText,
      ...deriveValueFields({ ...proposal, valueString: candidate.valueText }),
      unit,
      referenceInterval,
      flag,
      collectionDate: null,
      collectionGroup: null,
      specimen: null,
      location: unionLocation(candidate.observations),
      ambiguousFields,
      canonicalBiomarkerId: null,
      trendEligible: null,
      unresolvedFields,
      sourceIds,
    };
    grounded.push(output);
    increment(acceptedByPage, String(proposal.page ?? 'unknown'));
  }

  return {
    measurements: grounded,
    diagnostics: {
      proposalCount: proposals.length,
      acceptedCount: grounded.length,
      rejectedCount: proposals.length - grounded.length,
      rejectedByReason,
      acceptedByPage,
      rejectedByPage,
      sourceFieldCounts,
    },
  };
}
