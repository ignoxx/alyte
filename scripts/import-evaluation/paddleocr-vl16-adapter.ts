/**
 * Evaluation-only adapter for a persisted PaddleOCR-VL text response.
 *
 * PaddleOCR-VL returns a linear transcription for this experiment, without source boxes or a
 * machine-readable table. This adapter admits only structurally supported candidates: a scalar
 * token, an adjacent generic unit, and an optional immediately following reference interval.
 * It does not consult ground truth, a biomarker catalogue, or any report-specific label/value.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  IMPORT_EVALUATION_SCHEMA_VERSION,
  sha256File,
  writeJsonFile,
  type EvaluationComparator,
  type EvaluationMeasurement,
  type PipelineResult,
} from './contract';

const PIPELINE_ID = 'paddleocr-vl16' as const;
const PIPELINE_VERSION = 'paddleocr-vl16-text-adapter.v2' as const;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,80}$/u;

type NumericToken = {
  readonly text: string;
  readonly parsedValue: number;
  readonly comparator: EvaluationComparator;
};

type Candidate = {
  readonly lineIndex: number;
  readonly valueIndex: number;
  readonly value: NumericToken;
  readonly unitIndex: number;
  readonly unitEndIndex: number;
  readonly unit: string | null;
  readonly flag: string | null;
  readonly referenceInterval: string | null;
  readonly referenceEndIndex: number;
};

type ParsedPage = {
  readonly measurements: readonly EvaluationMeasurement[];
  readonly lineCount: number;
  readonly numericCandidateCount: number;
  readonly admittedNumericCount: number;
  readonly admittedCategoricalCount: number;
  readonly admittedTextCount: number;
  readonly skippedUnitlessCount: number;
};

type RawPageInput = {
  readonly page: number;
  readonly path: string;
};

function measurementKey(measurement: EvaluationMeasurement): string {
  // Source line IDs are intentionally excluded: overlapping page captures assign different line
  // numbers to the same visible row. All source/result fields remain part of the identity.
  return JSON.stringify([
    measurement.page,
    measurement.sourceLabel.normalize('NFKC').trim().toLocaleLowerCase('en-US'),
    measurement.valueString?.normalize('NFKC').trim() ?? null,
    measurement.valueType,
    measurement.parsedValue,
    measurement.comparator,
    measurement.unit,
    measurement.referenceInterval,
    measurement.flag,
    measurement.collectionDate,
    measurement.collectionGroup,
    measurement.specimen,
    measurement.location,
  ]);
}

function measurementLabelKey(measurement: EvaluationMeasurement): string {
  return `${measurement.page ?? 'unknown'}:${measurement.sourceLabel
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')}`;
}

export function deduplicateOverlappingMeasurements(
  measurements: readonly EvaluationMeasurement[],
  overlapPages: ReadonlySet<number>,
): readonly EvaluationMeasurement[] {
  const keysByLabel = new Map<string, Set<string>>();
  for (const measurement of measurements) {
    if (measurement.page === null || !overlapPages.has(measurement.page)) continue;
    const labelKey = measurementLabelKey(measurement);
    const keys = keysByLabel.get(labelKey) ?? new Set<string>();
    keys.add(measurementKey(measurement));
    keysByLabel.set(labelKey, keys);
  }
  const conflictingLabels = new Set(
    [...keysByLabel.entries()].filter(([, keys]) => keys.size > 1).map(([labelKey]) => labelKey),
  );
  const seen = new Set<string>();
  const unique: EvaluationMeasurement[] = [];
  for (const measurement of measurements) {
    if (measurement.page !== null && overlapPages.has(measurement.page)) {
      if (conflictingLabels.has(measurementLabelKey(measurement))) continue;
      const key = measurementKey(measurement);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(measurement);
  }
  // Each band parser starts its ordinal at one. Reassign IDs after merging so the contract keeps
  // stable, page-local identifiers without touching any source provenance fields.
  const nextByPage = new Map<number, number>();
  return unique.map((measurement) => {
    const page = measurement.page;
    if (page === null) return measurement;
    const ordinal = (nextByPage.get(page) ?? 0) + 1;
    nextByPage.set(page, ordinal);
    return { ...measurement, id: `p${page}-m${String(ordinal).padStart(3, '0')}` };
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/gu, ' ').trim();
}

function cleanSourceLabel(value: string): string {
  // Paddle's transcription can retain superscript markup. Removing the markup wrapper and its
  // footnote marker preserves the visible source label without inventing punctuation or aliases.
  const stripped = normalizeWhitespace(
    value
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/giu, '')
      .replace(/\\\([^)]*\\\)/gu, '')
      .replace(/\s*:\s*$/u, ''),
  );
  const headerEnd = stripped.lastIndexOf('Reference Interval');
  return normalizeWhitespace(
    headerEnd >= 0 ? stripped.slice(headerEnd + 'Reference Interval'.length) : stripped,
  );
}

function comparatorFromToken(value: string): EvaluationComparator {
  const match = value.match(/^(<=|>=|<|>|=)/u)?.[1];
  return match === undefined ? null : (match as Exclude<EvaluationComparator, null>);
}

function numberFromToken(value: string): NumericToken | null {
  const normalized = normalizeWhitespace(value);
  const comparator = comparatorFromToken(normalized);
  const numberPart = normalized.replace(/^(?:<=|>=|<|>|=)/u, '').replace(',', '.');
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(numberPart)) return null;
  const parsedValue = Number(numberPart);
  if (!Number.isFinite(parsedValue)) return null;
  return { text: normalized, parsedValue, comparator };
}

function isRangeToken(value: string): boolean {
  const normalized = normalizeWhitespace(value).replace(',', '.');
  return /^(?:<=|>=|<|>|=)?(?:\d+(?:\.\d+)?|\.\d+)-(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized);
}

function tokenLooksLikeUnit(value: string): boolean {
  const normalized = normalizeWhitespace(value).replace(/[µμ]/gu, 'u');
  if (normalized.toLocaleLowerCase('en-US') === 'ratio') return true;
  if (normalized === '%' || normalized === '°C') return true;
  // Units are constrained by a generic unit vocabulary, while the actual token is copied from
  // the OCR response. This accepts compound forms such as mg/dL, nmol/L and cells/uL without a
  // health catalogue or report-specific assumptions.
  if (/^\/[a-z]+$/iu.test(normalized) || normalized.toLocaleLowerCase('en-US') === 'nm')
    return true;
  if (/^x10e\d+(?:\/[a-z]+[0-9]*)+(?:\/[0-9.]+)?$/iu.test(normalized)) return true;
  return /^(?:u?mol|nmol|pmol|mmol|mol|mg|mcg|ug|ng|pg|fg|g|kg|ml|dl|fl|u|iu|miu|mu|kat|mmhg|kpa|bpm|ph|inr|sec|s|msec|meq|mosm|cells?)(?:\/[a-z]+[0-9]*)*(?:\/[0-9.]+)?(?:\^?[0-9]+)?$/iu.test(
    normalized,
  );
}

function unitAt(
  tokens: readonly string[],
  startIndex: number,
): { readonly unit: string; readonly endIndex: number } | null {
  const token = tokens[startIndex];
  if (token === undefined || !tokenLooksLikeUnit(token)) return null;
  const qualifier = tokens[startIndex + 1];
  // Generic laboratory unit qualifiers remain part of the source unit, for example `mg/g creat`.
  const secondQualifier = tokens[startIndex + 2];
  if (qualifier !== undefined && /^(?:creat)$/iu.test(qualifier)) {
    return {
      unit: `${normalizeWhitespace(token)} ${normalizeWhitespace(qualifier)}`,
      endIndex: startIndex + 1,
    };
  }
  if (
    normalizedUnitQualifier(token) === '%' &&
    qualifier !== undefined &&
    secondQualifier !== undefined &&
    /^by$/iu.test(qualifier) &&
    /^wt$/iu.test(secondQualifier)
  ) {
    return {
      unit: `${normalizeWhitespace(token)} ${normalizeWhitespace(qualifier)} ${normalizeWhitespace(secondQualifier)}`,
      endIndex: startIndex + 2,
    };
  }
  return { unit: normalizeWhitespace(token), endIndex: startIndex };
}

function normalizedUnitQualifier(value: string): string {
  return normalizeWhitespace(value).replace(/[µμ]/gu, 'u').toLocaleLowerCase('en-US');
}

function parseReference(
  tokens: readonly string[],
  unitIndex: number,
): { readonly value: string | null; readonly endIndex: number } {
  const first = tokens[unitIndex + 1];
  if (first === undefined) return { value: null, endIndex: unitIndex };
  const normalizedFirst = normalizeWhitespace(first);
  if (isRangeToken(normalizedFirst) || numberFromToken(normalizedFirst) !== null) {
    return { value: normalizedFirst, endIndex: unitIndex + 1 };
  }
  if (/^(?:<=|>=|<|>|=|≤|≥)$/u.test(normalizedFirst)) {
    const second = tokens[unitIndex + 2];
    const normalizedSecond = second === undefined ? null : normalizeWhitespace(second);
    if (normalizedSecond !== null && numberFromToken(normalizedSecond) !== null) {
      return { value: `${normalizedFirst} ${normalizedSecond}`, endIndex: unitIndex + 2 };
    }
  }
  return { value: null, endIndex: unitIndex };
}

function resultCandidate(
  tokens: readonly string[],
  lineIndex: number,
  valueIndex: number,
): Candidate | null {
  const valueToken = tokens[valueIndex];
  if (valueToken === undefined || isRangeToken(valueToken)) return null;
  const value = numberFromToken(valueToken);
  if (value === null) return null;

  let unitIndex = valueIndex + 1;
  const skipped: string[] = [];
  while (unitIndex < tokens.length && skipped.length <= 2 && unitAt(tokens, unitIndex) === null) {
    const token = tokens[unitIndex]!;
    if (numberFromToken(token) !== null || isRangeToken(token)) break;
    skipped.push(token);
    unitIndex += 1;
  }
  const unitToken = unitAt(tokens, unitIndex);
  if (unitToken === null) {
    const next = tokens[valueIndex + 1];
    const nextIsLabel = next !== undefined && /^[A-Z][A-Za-z0-9'/(+-]*$/u.test(next);
    const nextIsRange = next !== undefined && isRangeToken(next);
    const nextIsStatus =
      next !== undefined && /^(?:High|Low|Abnormal|Critical|Alert)$/iu.test(next);
    const nextIsMalformedReference =
      next !== undefined && /^[A-Za-z]+-(?:\d+(?:\.\d+)?|\.\d+)$/u.test(next);
    const leadingLabel = cleanSourceLabel(
      tokens.slice(labelStartAt(tokens, valueIndex), valueIndex).join(' '),
    );
    const unitlessRowShape =
      value.comparator === null &&
      leadingLabel.length > 0 &&
      !isProseLabel(leadingLabel) &&
      (next === undefined || nextIsLabel || nextIsMalformedReference) &&
      skipped.length <= 3;
    // Unitless numeric rows are admitted only when a bounded comparator, explicit reference
    // range, status flag, or an obvious label boundary makes the row boundary visible. Plain
    // prose numbers stay excluded.
    if (value.comparator === null && !nextIsRange && !nextIsStatus && !unitlessRowShape)
      return null;
    // A comparator with no unit is commonly a reference-column threshold in flattened lab
    // tables. Without geometry there is no safe way to attach it to the preceding label.
    if (value.comparator !== null && !nextIsRange && !nextIsStatus) return null;
    if (value.comparator !== null && next !== undefined && !nextIsLabel && !nextIsStatus) {
      if (!nextIsRange && skipped.length === 0) return null;
    }
    if (nextIsStatus && skipped.length > 1) return null;
    const reference = nextIsRange
      ? { value: normalizeWhitespace(next!), endIndex: valueIndex + 1 }
      : isRangeToken(tokens[unitIndex] ?? '')
        ? { value: normalizeWhitespace(tokens[unitIndex]!), endIndex: unitIndex }
        : { value: null, endIndex: valueIndex };
    return {
      lineIndex,
      valueIndex,
      value,
      unitIndex: -1,
      unitEndIndex: -1,
      unit: null,
      flag: nextIsStatus ? normalizeWhitespace(skipped.join(' ')) : null,
      referenceInterval: reference.value,
      referenceEndIndex: reference.endIndex,
    };
  }

  const reference = parseReference(tokens, unitToken.endIndex);
  return {
    lineIndex,
    valueIndex,
    value,
    unitIndex,
    unitEndIndex: unitToken.endIndex,
    unit: unitToken.unit,
    flag: skipped.length === 0 ? null : normalizeWhitespace(skipped.join(' ')),
    referenceInterval: reference.value,
    referenceEndIndex: reference.endIndex,
  };
}

function labelStart(tokens: readonly string[], candidate: Candidate): number {
  // A preceding incomplete numeric/reference token can belong to an omitted row in a flattened
  // table. Start after the final numeric-looking token so it cannot become part of the next label.
  for (let index = candidate.valueIndex - 1; index >= 0; index -= 1) {
    if (numberFromToken(tokens[index]!) !== null || isRangeToken(tokens[index]!)) return index + 1;
  }
  return 0;
}

function labelStartAt(tokens: readonly string[], valueIndex: number): number {
  for (let index = valueIndex - 1; index >= 0; index -= 1) {
    if (numberFromToken(tokens[index]!) !== null || isRangeToken(tokens[index]!)) return index + 1;
  }
  return 0;
}

function collectionDateFromText(text: string): string | null {
  const match = text.match(/\bDate\s+Collected\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/iu);
  if (match === null) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function textStatusMeasurement(
  line: string,
  lineIndex: number,
  page: number,
  collectionDate: string | null,
  ordinal: number,
): EvaluationMeasurement | null {
  const match = line.match(
    /\b((?:Test\s+not\s+performed|Pending|Cancelled)\.?[^]*|See\s+below:?|Will\s+Follow)$/iu,
  );
  if (match === null || match.index === undefined) return null;
  const prefixTokens = normalizeWhitespace(line.slice(0, match.index)).split(' ').filter(Boolean);
  let sourceStart = 0;
  for (let index = prefixTokens.length - 1; index >= 0; index -= 1) {
    if (numberFromToken(prefixTokens[index]!) !== null || isRangeToken(prefixTokens[index]!)) {
      sourceStart = index + 1;
      break;
    }
  }
  const sourceLabel = cleanSourceLabel(prefixTokens.slice(sourceStart).join(' '));
  const valueString = normalizeWhitespace(match[1]);
  if (sourceLabel.length === 0 || valueString.length === 0) return null;
  return {
    id: `p${page}-m${String(ordinal).padStart(3, '0')}`,
    sourceLabel,
    valueString,
    valueType: 'text',
    parsedValue: valueString,
    comparator: null,
    unit: null,
    referenceInterval: null,
    flag: null,
    collectionDate,
    collectionGroup: null,
    specimen: null,
    page,
    location: null,
    ambiguousFields: [],
    unresolvedFields: ['location'],
    sourceIds: [`p${page}-line${lineIndex + 1}`],
  };
}

function categoricalToken(value: string): string | null {
  const normalized = normalizeWhitespace(value).replace(/:$/u, '');
  if (
    /^(?:negative|positive|yellow|clear|normal|abnormal|trace|none|none\s+seen|a|b|ab|o)$/iu.test(
      normalized,
    )
  ) {
    return normalized;
  }
  if (/^\d+\+$/u.test(normalized)) return normalized;
  return null;
}

function categoricalReference(
  tokens: readonly string[],
  startIndex: number,
  unitEndIndex: number,
): { readonly value: string | null; readonly endIndex: number } {
  const firstIndex = unitEndIndex >= startIndex ? unitEndIndex + 1 : startIndex;
  const first = tokens[firstIndex];
  if (first === undefined) return { value: null, endIndex: startIndex - 1 };
  const firstStatus = categoricalToken(first);
  if (firstStatus !== null) return { value: firstStatus, endIndex: firstIndex };
  if (/^[A-Za-z]+(?:\/[A-Za-z]+)+$/u.test(first)) {
    return { value: normalizeWhitespace(first), endIndex: firstIndex };
  }
  if (isRangeToken(first)) return { value: normalizeWhitespace(first), endIndex: firstIndex };
  return { value: null, endIndex: startIndex - 1 };
}

function categoricalMeasurement(
  tokens: readonly string[],
  lineIndex: number,
  page: number,
  collectionDate: string | null,
  ordinal: number,
): EvaluationMeasurement | null {
  for (let valueIndex = 0; valueIndex < tokens.length; valueIndex += 1) {
    let valueEndIndex = valueIndex;
    let value =
      valueIndex + 1 < tokens.length
        ? categoricalToken(`${tokens[valueIndex]} ${tokens[valueIndex + 1]}`)
        : null;
    if (value !== null) valueEndIndex += 1;
    else value = categoricalToken(tokens[valueIndex]!);
    if (value === null) continue;
    const label = cleanSourceLabel(
      tokens.slice(labelStartAt(tokens, valueIndex), valueIndex).join(' '),
    );
    if (label.length === 0 || isProseLabel(label)) continue;
    // A one-letter blood-group result is only structurally credible when the adjacent label
    // identifies a grouping/factor field. This keeps isolated prose/article letters out while
    // admitting ordinary categorical rows without a biomarker catalogue.
    if (/^(?:a|b|ab|o)$/iu.test(value) && !/\b(?:group(?:ing)?|factor)\b/iu.test(label)) continue;
    const unit = unitAt(tokens, valueEndIndex + 1);
    const unitEndIndex = unit?.endIndex ?? valueEndIndex;
    // An immediately repeated categorical token is a current/reference pair in flattened table
    // text with no geometry to identify the current column. Defer that ambiguous row; a distinct
    // following reference (for example `Negative Negative/Trace`) remains representable.
    if (categoricalToken(tokens[unitEndIndex + 1] ?? '') === value) continue;
    const maybeFlag = tokens[unitEndIndex + 1];
    const flag =
      value.endsWith('+') && categoricalToken(maybeFlag ?? '') !== null
        ? normalizeWhitespace(maybeFlag!)
        : null;
    const referenceStart = flag === null ? unitEndIndex : unitEndIndex + 1;
    const reference = categoricalReference(tokens, valueEndIndex, referenceStart);
    return {
      id: `p${page}-m${String(ordinal).padStart(3, '0')}`,
      sourceLabel: label,
      valueString: value,
      valueType: 'categorical',
      parsedValue: value,
      comparator: null,
      unit: unit?.unit ?? null,
      referenceInterval: reference.value,
      flag,
      collectionDate,
      collectionGroup: null,
      specimen: null,
      page,
      location: null,
      ambiguousFields: [],
      unresolvedFields: ['location'],
      sourceIds: [`p${page}-line${lineIndex + 1}`],
    };
  }
  return null;
}

function textMeasurementWithUnit(
  tokens: readonly string[],
  lineIndex: number,
  page: number,
  collectionDate: string | null,
  ordinal: number,
): EvaluationMeasurement | null {
  for (let unitIndex = 1; unitIndex < tokens.length; unitIndex += 1) {
    const unit = unitAt(tokens, unitIndex);
    if (unit === null) continue;
    const sourceLabel = cleanSourceLabel(tokens.slice(0, unitIndex).join(' '));
    const remainder = normalizeWhitespace(tokens.slice(unit.endIndex + 1).join(' '));
    if (
      sourceLabel.length === 0 ||
      isProseLabel(sourceLabel) ||
      remainder.split(' ').length < 4 ||
      !/^[A-Z]/u.test(remainder)
    )
      continue;
    const sentence = normalizeWhitespace(
      remainder.match(/^.*?[.!?](?:\s|$).*?[.!?](?:\s|$)/u)?.[0] ??
        remainder.match(/^.*?[.!?](?:\s|$)/u)?.[0] ??
        remainder,
    );
    if (sentence.length === 0 || /^(?:Reference|Date|Page)\b/iu.test(sourceLabel)) continue;
    return {
      id: `p${page}-m${String(ordinal).padStart(3, '0')}`,
      sourceLabel,
      valueString: sentence,
      valueType: 'text',
      parsedValue: sentence,
      comparator: null,
      unit: unit.unit,
      referenceInterval: null,
      flag: null,
      collectionDate,
      collectionGroup: null,
      specimen: null,
      page,
      location: null,
      ambiguousFields: [],
      unresolvedFields: ['location'],
      sourceIds: [`p${page}-line${lineIndex + 1}`],
    };
  }
  return null;
}

function numericMeasurement(
  tokens: readonly string[],
  candidate: Candidate,
  page: number,
  collectionDate: string | null,
  ordinal: number,
): EvaluationMeasurement | null {
  const sourceLabel = cleanSourceLabel(
    tokens.slice(labelStart(tokens, candidate), candidate.valueIndex).join(' '),
  );
  if (sourceLabel.length === 0 || isProseLabel(sourceLabel)) return null;
  return {
    id: `p${page}-m${String(ordinal).padStart(3, '0')}`,
    sourceLabel,
    valueString: candidate.value.text,
    valueType: candidate.value.comparator === null ? 'numeric' : 'bounded',
    parsedValue: candidate.value.parsedValue,
    comparator: candidate.value.comparator,
    unit: candidate.unit,
    referenceInterval: candidate.referenceInterval,
    flag: candidate.flag,
    collectionDate,
    collectionGroup: null,
    specimen: null,
    page,
    location: null,
    ambiguousFields: [],
    unresolvedFields: ['location'],
    sourceIds: [`p${page}-line${candidate.lineIndex + 1}`],
  };
}

function isProseLabel(value: string): boolean {
  // A flattened OCR response also contains explanatory notes and method text with numeric tokens.
  // Reject obvious prose containers so their numbers cannot become measurements. This is a
  // structural filter; it has no knowledge of biomarker names or expected values.
  return (
    /^(?:note|please note|comment(?:s)?)\b/iu.test(value) ||
    /\breference interval is based\b/iu.test(value) ||
    /\b(?:testing performed|performance characteristics|assay|reduced risk|increased risk|exclusion|rule out|diagnostic evaluation|optimal cut point|age independent|ordered items|collection method|environmental exposure|deficiency has been defined|insufficiency|endocrine society|ascvd risk|therapeutic target|risk|percentile in reference population|laboratory corporation|labcorp phoenix|date|page|accession|record|patient|specimen|account|ordering physician|all rights reserved|dob|age|id|phone|fax|zip|dir|ste|street|court|burlington|san diego)\b/iu.test(
      value,
    ) ||
    /\bthis\s+test\s+may\b/iu.test(value) ||
    /\d{2}:/u.test(value) ||
    /^(?:high|low|abnormal|critical|alert|very|small|large|-|and|of|nmol\/min\/mL)$/iu.test(value)
  );
}

function isInterpretiveMarker(value: string): boolean {
  return /\b(?:INTERPRETATIVE INFORMATION|PARTICLE CONCENTRATION AND SIZE|INSULIN RESISTANCE\s*\/\s*DIABETES RISK MARKERS|Percentile in Reference Population)\b/iu.test(
    value,
  );
}

export function parsePaddleOcrPage(text: string, page: number): ParsedPage {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('paddleocr-page-invalid');
  const lines = text.split(/\r?\n/u);
  const collectionDate = collectionDateFromText(text);
  const measurements: EvaluationMeasurement[] = [];
  let numericCandidateCount = 0;
  let skippedUnitlessCount = 0;
  let admittedTextCount = 0;
  let admittedCategoricalCount = 0;
  let interpretive = false;

  for (const [lineIndex, line] of lines.entries()) {
    const normalizedLine = normalizeWhitespace(line);
    if (normalizedLine.length === 0) continue;
    if (isInterpretiveMarker(normalizedLine)) {
      interpretive = true;
      continue;
    }
    if (interpretive && /\bTest\s+Current\s+Result\b/iu.test(normalizedLine)) {
      interpretive = false;
      continue;
    }
    if (interpretive) continue;
    const tokens = normalizedLine.split(' ');
    const measurementsBeforeLine = measurements.length;
    for (let valueIndex = 0; valueIndex < tokens.length; valueIndex += 1) {
      const value = numberFromToken(tokens[valueIndex]!);
      if (value === null || isRangeToken(tokens[valueIndex]!)) continue;
      numericCandidateCount += 1;
      const candidate = resultCandidate(tokens, lineIndex, valueIndex);
      if (candidate === null) {
        skippedUnitlessCount += 1;
        continue;
      }
      const measurement = numericMeasurement(
        tokens,
        candidate,
        page,
        collectionDate,
        measurements.length + 1,
      );
      if (measurement !== null) measurements.push(measurement);
      // The candidate consumed the result-shaped sequence; a later reference number must not
      // be reconsidered as another current value on the same flattened OCR line.
      valueIndex = candidate.referenceEndIndex;
    }
    const status = textStatusMeasurement(
      normalizedLine,
      lineIndex,
      page,
      collectionDate,
      measurements.length + 1,
    );
    if (status !== null) {
      measurements.push(status);
      admittedTextCount += 1;
    }
    const categorical = categoricalMeasurement(
      tokens,
      lineIndex,
      page,
      collectionDate,
      measurements.length + 1,
    );
    if (categorical !== null) {
      measurements.push(categorical);
      admittedCategoricalCount += 1;
    }
    if (measurements.length === measurementsBeforeLine) {
      const textWithUnit = textMeasurementWithUnit(
        tokens,
        lineIndex,
        page,
        collectionDate,
        measurements.length + 1,
      );
      if (textWithUnit !== null) {
        measurements.push(textWithUnit);
        admittedTextCount += 1;
      }
    }
  }
  return {
    measurements,
    lineCount: lines.length,
    numericCandidateCount,
    admittedNumericCount: measurements.filter(
      (item) => item.valueType === 'numeric' || item.valueType === 'bounded',
    ).length,
    admittedCategoricalCount,
    admittedTextCount,
    skippedUnitlessCount,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function requiredPage(): number {
  const value = argument('--page') ?? '1';
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('paddleocr-page-invalid');
  return page;
}

function defaultRawPath(privateRoot: string, reportId: string, page: number): string {
  const pageNames = [...new Set([String(page), String(page).padStart(2, '0')])];
  const names = [
    ...pageNames.flatMap((pageName) => [
      `paddleocr-vl16-q8-${reportId}-page${pageName}-v1.raw.txt`,
      `paddleocr-vl16-q4-${reportId}-page${pageName}-v2.raw.txt`,
      `paddleocr-vl16-q4-${reportId}-page${pageName}-v1.raw.txt`,
      `paddleocr-vl16-q4-${reportId}-page${pageName}.raw.txt`,
    ]),
  ];
  for (const name of names) {
    const path = resolve(privateRoot, 'raw', name);
    try {
      readFileSync(path);
      return path;
    } catch {
      // Try the next persisted capture without exposing filesystem details.
    }
  }
  return resolve(privateRoot, 'raw', names[0]!);
}

function existingRawPaths(
  privateRoot: string,
  reportId: string,
  page: number,
  kind: 'band' | 'small',
): readonly string[] {
  const pageNames = [...new Set([String(page), String(page).padStart(2, '0')])];
  const paths: string[] = [];
  for (const pageName of pageNames) {
    for (let band = 1; band <= (kind === 'small' ? 4 : 3); band += 1) {
      const path = resolve(
        privateRoot,
        'raw',
        `paddleocr-vl16-q8-${reportId}-page${pageName}-${kind}${band}-v1.raw.txt`,
      );
      try {
        readFileSync(path);
        paths.push(path);
      } catch {
        // A partial capture is still useful; callers can see every selected raw-file digest.
      }
    }
  }
  return [...new Set(paths)];
}

function defaultRawPaths(privateRoot: string, reportId: string, page: number): readonly string[] {
  if (page === 8) {
    const smallBands = existingRawPaths(privateRoot, reportId, page, 'small');
    if (smallBands.length > 0) return smallBands;
    const bands = existingRawPaths(privateRoot, reportId, page, 'band');
    if (bands.length > 0) return bands;
  }
  if (page === 9) {
    const bands = existingRawPaths(privateRoot, reportId, page, 'band');
    if (bands.length > 0) return bands;
  }
  return [defaultRawPath(privateRoot, reportId, page)];
}

function captureTag(path: string, page: number): string {
  const pageName = String(page).padStart(2, '0');
  const match = basename(path).match(
    new RegExp(`-page(?:${page}|${pageName})-(small\\d+|band\\d+)-v\\d+\\.raw\\.txt$`, 'iu'),
  );
  return match?.[1] === undefined ? 'full' : match[1].toLocaleLowerCase('en-US');
}

function withCaptureProvenance(
  measurements: readonly EvaluationMeasurement[],
  path: string,
  page: number,
): readonly EvaluationMeasurement[] {
  const tag = captureTag(path, page);
  return measurements.map((measurement) => ({
    ...measurement,
    sourceIds: measurement.sourceIds?.map((sourceId) =>
      sourceId.replace(`p${page}-`, `p${page}-${tag}-`),
    ),
  }));
}

export function runPaddleOcrAdapter(options: {
  readonly reportPath: string;
  readonly reportId: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly rawPath?: string;
  readonly rawPaths?: readonly RawPageInput[];
  readonly page?: number;
}): PipelineResult {
  if (!SAFE_TOKEN.test(options.reportId)) throw new Error('paddleocr-report-id-invalid');
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('paddleocr-page-invalid');
  const privateRoot = resolve(options.privateRoot);
  const reportPath = assertPrivatePath(options.reportPath, privateRoot);
  const outputPath = assertPrivatePath(options.outputPath, privateRoot);
  if (options.rawPath !== undefined && options.rawPaths !== undefined) {
    throw new Error('paddleocr-inputs-ambiguous');
  }
  const rawInputs: readonly RawPageInput[] = options.rawPaths ?? [
    { page, path: options.rawPath ?? defaultRawPath(privateRoot, options.reportId, page) },
  ];
  if (
    rawInputs.length === 0 ||
    rawInputs.some((input) => !Number.isSafeInteger(input.page) || input.page < 1)
  ) {
    throw new Error('paddleocr-inputs-invalid');
  }
  const checkedRawInputs = rawInputs.map((input) => ({
    page: input.page,
    path: assertPrivatePath(input.path, privateRoot),
  }));
  if (
    new Set([reportPath, outputPath, ...checkedRawInputs.map((input) => input.path)]).size !==
    2 + checkedRawInputs.length
  ) {
    throw new Error('paddleocr-output-input-collision');
  }
  const started = performance.now();
  const readStarted = performance.now();
  const pageResults = checkedRawInputs.map((input) => ({
    ...input,
    rawText: readFileSync(input.path, 'utf8'),
  }));
  const readElapsedMs = Math.max(0, Math.round(performance.now() - readStarted));
  const parsedPages = pageResults.map((input) => {
    const parsed = parsePaddleOcrPage(input.rawText, input.page);
    return {
      page: input.page,
      parsed: {
        ...parsed,
        measurements: withCaptureProvenance(parsed.measurements, input.path, input.page),
      },
    };
  });
  const datesByPage = new Map<number, Set<string>>();
  for (const input of pageResults) {
    const date = collectionDateFromText(input.rawText);
    if (date === null) continue;
    const dates = datesByPage.get(input.page) ?? new Set<string>();
    dates.add(date);
    datesByPage.set(input.page, dates);
  }
  const pageDate = new Map<number, string>();
  for (const [inputPage, dates] of datesByPage) {
    if (dates.size === 1) pageDate.set(inputPage, [...dates][0]!);
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const reportSha256 = sha256File(reportPath);
  const rawSha256 = checkedRawInputs.map((input) => ({
    page: input.page,
    file: basename(input.path),
    sha256: sha256File(input.path),
  }));
  const overlapPages = new Set(
    checkedRawInputs
      .map((input) => input.page)
      .filter((inputPage, index, pages) => pages.indexOf(inputPage) !== index),
  );
  const measurements = deduplicateOverlappingMeasurements(
    parsedPages.flatMap((item) =>
      item.parsed.measurements.map((measurement) =>
        measurement.collectionDate === null && pageDate.has(item.page)
          ? { ...measurement, collectionDate: pageDate.get(item.page)! }
          : measurement,
      ),
    ),
    overlapPages,
  );
  const lineCount = parsedPages.reduce((total, item) => total + item.parsed.lineCount, 0);
  const numericCandidateCount = parsedPages.reduce(
    (total, item) => total + item.parsed.numericCandidateCount,
    0,
  );
  const admittedNumericCount = parsedPages.reduce(
    (total, item) => total + item.parsed.admittedNumericCount,
    0,
  );
  const admittedTextCount = parsedPages.reduce(
    (total, item) => total + item.parsed.admittedTextCount,
    0,
  );
  const skippedUnitlessCount = parsedPages.reduce(
    (total, item) => total + item.parsed.skippedUnitlessCount,
    0,
  );
  ensurePrivateDirectory(dirname(outputPath));
  const result: PipelineResult = {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: options.reportId,
    reportSha256,
    pipeline: {
      id: PIPELINE_ID,
      version: PIPELINE_VERSION,
      configuration: {
        source: 'persisted-paddleocr-vl-text',
        model: 'PaddleOCR-VL-1.6',
        rawFiles: rawSha256,
        rawSha256,
        pages: checkedRawInputs.map((input) => input.page),
        quantization: rawSha256.some((input) => /q8/iu.test(input.file))
          ? 'Q8_0'
          : rawSha256.some((input) => /q4/iu.test(input.file))
            ? 'Q4'
            : 'unknown',
        geometry: 'unavailable',
        groundTruthAccess: false,
        timingScope: 'cached-ocr-read-and-structural-admission',
      },
      runtime: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        cachedInput: true,
      },
    },
    stages: [
      {
        name: 'read-persisted-ocr-output',
        elapsedMs: readElapsedMs,
        outputCount: lineCount,
        status: 'success',
      },
      {
        name: 'structural-candidate-admission',
        elapsedMs: Math.max(0, elapsedMs - readElapsedMs),
        inputCount: numericCandidateCount,
        outputCount: measurements.length,
        status: 'success',
      },
    ],
    elapsedMs,
    measurements,
    diagnostics: {
      counts: {
        pages: parsedPages.length,
        lines: lineCount,
        numericCandidates: numericCandidateCount,
        admittedNumeric: admittedNumericCount,
        admittedText: admittedTextCount,
        skippedUnitless: skippedUnitlessCount,
        deduplicatedOverlapping:
          parsedPages.reduce((total, item) => total + item.parsed.measurements.length, 0) -
          measurements.length,
      },
      limitations: [
        'The persisted PaddleOCR-VL response has no source geometry; locations remain null.',
        'Only result-shaped numeric candidates and generic status text are admitted.',
        'Cached OCR inference time is outside this adapter timing scope.',
      ],
    },
  };
  // Confirm the report identity after parsing so a changed input cannot receive a stale result.
  if (sha256File(reportPath) !== reportSha256) throw new Error('paddleocr-report-mutated');
  writeJsonFile(outputPath, result);
  return result;
}

function main(): void {
  const reportPath = argument('--report');
  const reportId = argument('--report-id');
  const outputPath = argument('--output');
  if (reportPath === undefined || reportId === undefined || outputPath === undefined) {
    throw new Error('paddleocr-arguments-invalid');
  }
  const privateRoot = argument('--private-root') ?? resolve(dirname(reportPath), '..');
  const rawPath = argument('--raw');
  const pageArgument = argument('--page');
  const page = requiredPage();
  const pagesArgument = argument('--pages');
  const pages =
    pagesArgument === undefined
      ? [page]
      : [...new Set(pagesArgument.split(',').map((value) => Number(value.trim())))].toSorted(
          (left, right) => left - right,
        );
  if (
    pages.length === 0 ||
    pages.some((item) => !Number.isSafeInteger(item) || item < 1) ||
    (rawPath !== undefined && pages.length !== 1)
  ) {
    throw new Error('paddleocr-pages-invalid');
  }
  const rawPaths =
    rawPath === undefined
      ? pages.flatMap((item) =>
          defaultRawPaths(privateRoot, reportId, item).map((path) => ({ page: item, path })),
        )
      : undefined;
  const result = runPaddleOcrAdapter({
    reportPath,
    reportId,
    outputPath,
    privateRoot,
    ...(rawPaths === undefined ? {} : { rawPaths }),
    ...(rawPath === undefined || rawPaths !== undefined ? {} : { rawPath }),
    page: pageArgument === undefined ? pages[0] : page,
  });
  process.stdout.write(
    JSON.stringify({ elapsedMs: result.elapsedMs, measurements: result.measurements.length }) +
      '\n',
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch {
    process.stderr.write('paddleocr-vl16-adapter failed\n');
    process.exitCode = 1;
  }
}
