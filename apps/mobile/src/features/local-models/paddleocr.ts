import {
  parseComparatorValue,
  parseGeometryCandidateVariantAsProvisional,
  proposeBiomarkerId,
  revalidateExtractionRow,
  type ExtractionAliasEntry,
  type ExtractionDateContext,
  type ExtractionDraftRow,
  type GeometryCandidateWindowGroup,
  type GeometryCandidateWindowRow,
  type LabDateState,
  type LabSourceArtifact,
  type MeasurementValue,
  type VisionTextObservation,
} from '@alyte/domain';
import { canStartAutomatedExtraction } from './model';
import { productionLocalModelManifest } from './production-manifest.generated';
import type { LocalModelService } from './native';

/** Wire/schema identity for Paddle's bounded plain-text transcription adapter. */
export const PADDLEOCR_SCHEMA_VERSION = 'alyte.paddleocr-vl.flat-rows.v1' as const;
export const PADDLEOCR_PROMPT_VERSION = 'alyte.paddleocr-vl.prompt.v1' as const;
export const PADDLEOCR_ADAPTER_VERSION = 'alyte.paddleocr-vl16.text-extractor.v1' as const;

const MAX_RAW_CHARS = 200_000;
const MAX_LINES = 500;
const MAX_LINE_LENGTH = 1_000;
const MAX_ROWS = 256;
const MAX_FIELD_LENGTH = 512;
const MAX_INFERENCE_OUTPUT_TOKENS = 4_096;
const MAX_INFERENCE_OUTPUT_BYTES = 131_072;
const DEFAULT_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 1_000;

export type PaddleOCRValueType = 'numeric' | 'bounded' | 'categorical' | 'text';
export type PaddleOCRComparator = '<' | '>' | '<=' | '>=' | '=' | null;

/**
 * A parsed row is still untrusted model output. The source fields are only accepted downstream
 * after matching this row against a same-page source observation set.
 */
export type PaddleOCRRow = {
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
  readonly valueType: PaddleOCRValueType;
  readonly parsedValue: number | string;
  readonly comparator: PaddleOCRComparator;
};

export type PaddleOCRRetryRequest = {
  readonly kind: 'full-page' | 'band';
  readonly pageIndex: number;
  readonly bandIndex: number | null;
  readonly yPx: number;
  readonly heightPx: number;
  readonly overlapPx: number;
};

export type PaddleOCRRetryPlan = {
  readonly version: 'alyte.paddleocr-retry.v1';
  readonly pageIndex: number;
  readonly pageHeightPx: number;
  readonly bandHeightPx: number;
  readonly overlapPx: number;
  readonly requests: readonly PaddleOCRRetryRequest[];
};

/** The renderer owns actual crops; this metadata keeps the retry sequence deterministic. */
export function buildPaddleOCRRetryPlan(input: {
  readonly pageIndex: number;
  readonly pageHeightPx?: number;
  readonly bandHeightPx?: number;
  readonly overlapPx?: number;
}): PaddleOCRRetryPlan {
  const pageHeightPx = input.pageHeightPx ?? 1_800;
  const bandHeightPx = input.bandHeightPx ?? 600;
  const overlapPx = input.overlapPx ?? 200;
  if (
    !Number.isSafeInteger(input.pageIndex) ||
    input.pageIndex < 0 ||
    !Number.isSafeInteger(pageHeightPx) ||
    pageHeightPx < 1 ||
    !Number.isSafeInteger(bandHeightPx) ||
    bandHeightPx < 1 ||
    !Number.isSafeInteger(overlapPx) ||
    overlapPx < 0 ||
    overlapPx >= bandHeightPx
  )
    throw new Error('paddleocr-retry-plan-invalid');
  const requests: PaddleOCRRetryRequest[] = [
    {
      kind: 'full-page',
      pageIndex: input.pageIndex,
      bandIndex: null,
      yPx: 0,
      heightPx: pageHeightPx,
      overlapPx: 0,
    },
  ];
  const stride = bandHeightPx - overlapPx;
  let bandIndex = 0;
  for (let yPx = 0; yPx < pageHeightPx; yPx += stride) {
    requests.push({
      kind: 'band',
      pageIndex: input.pageIndex,
      bandIndex,
      yPx,
      heightPx: Math.min(bandHeightPx, pageHeightPx - yPx),
      overlapPx,
    });
    bandIndex += 1;
  }
  return {
    version: 'alyte.paddleocr-retry.v1',
    pageIndex: input.pageIndex,
    pageHeightPx,
    bandHeightPx,
    overlapPx,
    requests,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[\s\u00a0\u202f]+/gu, ' ').trim();
}

function boundedText(value: string | null): string | null {
  if (value === null) return null;
  const result = normalizeWhitespace(value);
  return result.length === 0 || result.length > MAX_FIELD_LENGTH ? null : result;
}

function cleanLabel(value: string): string {
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

function comparatorFor(value: string): PaddleOCRComparator {
  const match = value.match(/^(<=|>=|<|>|=)/u)?.[1];
  return match === undefined ? null : (match as Exclude<PaddleOCRComparator, null>);
}

function numberToken(value: string): {
  readonly text: string;
  readonly parsedValue: number;
  readonly comparator: PaddleOCRComparator;
} | null {
  const text = normalizeWhitespace(value);
  const comparator = comparatorFor(text);
  const numberPart = text.replace(/^(?:<=|>=|<|>|=)/u, '').replace(',', '.');
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(numberPart)) return null;
  const parsedValue = Number(numberPart);
  return Number.isFinite(parsedValue) ? { text, parsedValue, comparator } : null;
}

function rangeToken(value: string): boolean {
  return /^(?:<=|>=|<|>|=)?(?:\d+(?:[.,]\d+)?|\.\d+)[\-–—](?:\d+(?:[.,]\d+)?|\.\d+)$/u.test(
    normalizeWhitespace(value),
  );
}

type RangeSpan = {
  readonly value: string;
  readonly endIndex: number;
};

/** Recognize compact ranges and OCR ranges split around a dash into three tokens. */
function rangeAt(tokens: readonly string[], startIndex: number): RangeSpan | null {
  const token = tokens[startIndex];
  if (token !== undefined && rangeToken(token))
    return { value: normalizeWhitespace(token), endIndex: startIndex };

  const first = numberToken(token ?? '');
  const dash = tokens[startIndex + 1];
  const second = numberToken(tokens[startIndex + 2] ?? '');
  if (
    first?.comparator === null &&
    second?.comparator === null &&
    dash !== undefined &&
    /^[-–—]$/u.test(dash)
  )
    return {
      value: `${first.text} ${dash} ${second.text}`,
      endIndex: startIndex + 2,
    };
  return null;
}

function spacedRangeAt(tokens: readonly string[], startIndex: number): RangeSpan | null {
  const range = rangeAt(tokens, startIndex);
  return range !== null && range.endIndex > startIndex ? range : null;
}

function looksLikeUnit(value: string): boolean {
  const normalized = normalizeWhitespace(value).replace(/[µμ]/gu, 'u');
  if (normalized.toLocaleLowerCase('en-US') === 'ratio') return true;
  if (normalized === '%' || normalized === '°C') return true;
  // Generic units intentionally remain vocabulary-bound while retaining the exact OCR token.
  // The standalone slash and x10e forms occur in flattened laboratory tables.
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
  if (token === undefined || !looksLikeUnit(token)) return null;
  const qualifier = tokens[startIndex + 1];
  const secondQualifier = tokens[startIndex + 2];
  if (qualifier !== undefined && /^(?:creat)$/iu.test(qualifier))
    return {
      unit: `${normalizeWhitespace(token)} ${normalizeWhitespace(qualifier)}`,
      endIndex: startIndex + 1,
    };
  if (
    normalizeWhitespace(token).replace(/[µμ]/gu, 'u').toLocaleLowerCase('en-US') === '%' &&
    qualifier !== undefined &&
    secondQualifier !== undefined &&
    /^by$/iu.test(qualifier) &&
    /^wt$/iu.test(secondQualifier)
  )
    return {
      unit: `${normalizeWhitespace(token)} ${normalizeWhitespace(qualifier)} ${normalizeWhitespace(secondQualifier)}`,
      endIndex: startIndex + 2,
    };
  return { unit: normalizeWhitespace(token), endIndex: startIndex };
}

function referenceAfter(
  tokens: readonly string[],
  index: number,
): { readonly value: string | null; readonly endIndex: number } {
  const range = rangeAt(tokens, index + 1);
  if (range !== null) return range;
  const first = tokens[index + 1];
  if (first === undefined) return { value: null, endIndex: index };
  if (rangeToken(first) || numberToken(first) !== null)
    return { value: normalizeWhitespace(first), endIndex: index + 1 };
  if (/^(?:<=|>=|<|>|≤|≥)$/u.test(first) && numberToken(tokens[index + 2] ?? '') !== null)
    return { value: `${first} ${normalizeWhitespace(tokens[index + 2]!)}`, endIndex: index + 2 };
  return { value: null, endIndex: index };
}

function proseLabel(value: string): boolean {
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

function labelStart(tokens: readonly string[], valueIndex: number): number {
  for (let index = valueIndex - 1; index >= 0; index -= 1)
    if (numberToken(tokens[index]!) !== null || rangeToken(tokens[index]!)) return index + 1;
  return 0;
}

type NumericRowResult = {
  /** Null means the candidate was structurally consumed but its label is non-admissible. */
  readonly row: PaddleOCRRow | null;
  /** Last token consumed by this candidate, including an attached reference. */
  readonly endIndex: number;
};

/**
 * Paddle can emit a visually reconstructed table in column order, with the measured value after
 * the unit and reference interval. Keep that order deterministic: only consume an immediately
 * preceding range/unit pair, and leave the complete model line available as source provenance.
 */
function numericRowWithTrailingValue(
  tokens: readonly string[],
  valueIndex: number,
  value: NonNullable<ReturnType<typeof numberToken>>,
): NumericRowResult | null {
  if (valueIndex === 0) return null;

  let fieldEnd = valueIndex;
  let unit: { readonly unit: string; readonly endIndex: number } | null = null;
  let reference: string | null = null;
  const previousIndex = valueIndex - 1;
  const previous = tokens[previousIndex];

  if (previous !== undefined && rangeToken(previous)) {
    reference = normalizeWhitespace(previous);
    fieldEnd = previousIndex;
    const unitIndex = previousIndex - 1;
    const precedingUnit = unitAt(tokens, unitIndex);
    if (precedingUnit !== null && precedingUnit.endIndex === unitIndex) {
      unit = precedingUnit;
      fieldEnd = unitIndex;
    }
  } else {
    const precedingUnit = unitAt(tokens, previousIndex);
    if (precedingUnit !== null && precedingUnit.endIndex === previousIndex) {
      unit = precedingUnit;
      fieldEnd = previousIndex;
      const referenceIndex = previousIndex - 1;
      const precedingReference = tokens[referenceIndex];
      if (precedingReference !== undefined && rangeToken(precedingReference)) {
        reference = normalizeWhitespace(precedingReference);
        fieldEnd = referenceIndex;
      }
    }
  }

  if (unit === null && reference === null) return null;
  const label = cleanLabel(tokens.slice(0, fieldEnd).join(' '));
  const boundedLabel = boundedText(label);
  if (label.length === 0 || proseLabel(label) || boundedLabel === null) return null;

  return {
    row: {
      label: boundedLabel,
      value: value.text,
      unit: boundedText(unit?.unit ?? null),
      referenceInterval: boundedText(reference),
      flag: null,
      valueType: value.comparator === null ? 'numeric' : 'bounded',
      parsedValue: value.parsedValue,
      comparator: value.comparator,
    },
    endIndex: valueIndex,
  };
}

/**
 * A flattened table can place the measured value after a spaced reference range. Consume the
 * entire range and bind the final numeric token as the result so the lower bound cannot become a
 * second measurement.
 */
function numericRowWithSpacedRange(
  tokens: readonly string[],
  rangeStart: number,
  range: RangeSpan,
): NumericRowResult {
  const measuredIndex = range.endIndex + 1;
  const measured = numberToken(tokens[measuredIndex] ?? '');
  const endIndex = measured === null ? range.endIndex : measuredIndex;
  const unitIndex = rangeStart - 1;
  const unit = unitAt(tokens, unitIndex);
  if (measured === null || unit === null || unit.endIndex !== unitIndex)
    return { row: null, endIndex };

  const label = cleanLabel(tokens.slice(0, unitIndex).join(' '));
  const boundedLabel = boundedText(label);
  if (label.length === 0 || proseLabel(label) || boundedLabel === null)
    return { row: null, endIndex };

  return {
    row: {
      label: boundedLabel,
      value: measured.text,
      unit: boundedText(unit.unit),
      referenceInterval: boundedText(range.value),
      flag: null,
      valueType: measured.comparator === null ? 'numeric' : 'bounded',
      parsedValue: measured.parsedValue,
      comparator: measured.comparator,
    },
    endIndex,
  };
}

function numericRow(tokens: readonly string[], valueIndex: number): NumericRowResult | null {
  const valueToken = tokens[valueIndex];
  if (valueToken === undefined || rangeToken(valueToken)) return null;
  const value = numberToken(valueToken);
  if (value === null) return null;
  const spacedRange = spacedRangeAt(tokens, valueIndex);
  if (spacedRange !== null) return numericRowWithSpacedRange(tokens, valueIndex, spacedRange);
  const trailingValue = numericRowWithTrailingValue(tokens, valueIndex, value);
  if (trailingValue !== null) return trailingValue;
  let unitIndex = valueIndex + 1;
  const skipped: string[] = [];
  while (unitIndex < tokens.length && skipped.length <= 2 && unitAt(tokens, unitIndex) === null) {
    if (numberToken(tokens[unitIndex]!) !== null || rangeToken(tokens[unitIndex]!)) break;
    skipped.push(tokens[unitIndex]!);
    unitIndex += 1;
  }
  const unit = unitAt(tokens, unitIndex);
  const next = tokens[valueIndex + 1];
  const nextIsLabel = next !== undefined && /^[A-Z][A-Za-z0-9'/(+\-]*$/u.test(next);
  const nextIsRange = next !== undefined && rangeToken(next);
  const nextIsStatus = next !== undefined && /^(?:High|Low|Abnormal|Critical|Alert)$/iu.test(next);
  const nextIsMalformedReference =
    next !== undefined && /^[A-Za-z]+-(?:\d+(?:\.\d+)?|\.\d+)$/u.test(next);
  const leadingLabel = cleanLabel(
    tokens.slice(labelStart(tokens, valueIndex), valueIndex).join(' '),
  );
  if (unit === null) {
    const unitless =
      value.comparator === null &&
      leadingLabel.length > 0 &&
      !proseLabel(leadingLabel) &&
      (next === undefined || nextIsLabel || nextIsMalformedReference) &&
      skipped.length <= 3;
    if (value.comparator === null && !nextIsRange && !nextIsStatus && !unitless) return null;
    // A comparator without a unit is usually a reference-column threshold in flattened text.
    // It is admitted only when a visible boundary keeps it tied to this row.
    if (value.comparator !== null && !nextIsRange && !nextIsStatus) return null;
    if (value.comparator !== null && next !== undefined && !nextIsLabel && !nextIsStatus) {
      if (!nextIsRange && skipped.length === 0) return null;
    }
    if (nextIsStatus && skipped.length > 1) return null;
  }
  if (leadingLabel.length === 0 || proseLabel(leadingLabel)) return null;
  const boundedLabel = boundedText(leadingLabel);
  if (boundedLabel === null) return null;
  const reference =
    unit === null
      ? nextIsRange
        ? { value: normalizeWhitespace(next!), endIndex: valueIndex + 1 }
        : rangeToken(tokens[unitIndex] ?? '')
          ? { value: normalizeWhitespace(tokens[unitIndex]!), endIndex: unitIndex }
          : { value: null, endIndex: valueIndex }
      : referenceAfter(tokens, unit.endIndex);
  const endIndex =
    reference.value !== null ? reference.endIndex : unit === null ? valueIndex : unit.endIndex;
  if (leadingLabel.length === 0 || proseLabel(leadingLabel) || boundedText(leadingLabel) === null)
    return { row: null, endIndex };
  return {
    row: {
      label: boundedLabel,
      value: value.text,
      unit: boundedText(unit?.unit ?? null),
      referenceInterval: boundedText(reference.value),
      flag: boundedText(
        unit === null
          ? nextIsStatus && skipped.length > 0
            ? skipped.join(' ')
            : null
          : skipped.length === 0
            ? null
            : skipped.join(' '),
      ),
      valueType: value.comparator === null ? 'numeric' : 'bounded',
      parsedValue: value.parsedValue,
      comparator: value.comparator,
    },
    endIndex,
  };
}

function categorical(value: string): string | null {
  const normalized = normalizeWhitespace(value).replace(/:$/u, '');
  if (
    /^(?:negative|positive|yellow|clear|normal|abnormal|trace|none|none\s+seen|a|b|ab|o)$/iu.test(
      normalized,
    ) ||
    /^\d+\+$/u.test(normalized)
  )
    return normalized;
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
  const firstStatus = categorical(first);
  if (firstStatus !== null) return { value: firstStatus, endIndex: firstIndex };
  if (/^[A-Za-z]+(?:\/[A-Za-z]+)+$/u.test(first))
    return { value: normalizeWhitespace(first), endIndex: firstIndex };
  if (rangeToken(first)) return { value: normalizeWhitespace(first), endIndex: firstIndex };
  return { value: null, endIndex: startIndex - 1 };
}

function categoricalRow(tokens: readonly string[]): PaddleOCRRow | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const two =
      index + 1 < tokens.length ? categorical(`${tokens[index]} ${tokens[index + 1]}`) : null;
    const value = two ?? categorical(tokens[index]!);
    if (value === null) continue;
    const valueEnd = two === null ? index : index + 1;
    const label = cleanLabel(tokens.slice(labelStart(tokens, index), index).join(' '));
    if (label.length === 0 || proseLabel(label) || boundedText(label) === null) continue;
    if (/^(?:a|b|ab|o)$/iu.test(value) && !/\b(?:group(?:ing)?|factor)\b/iu.test(label)) continue;
    const unit = unitAt(tokens, valueEnd + 1);
    const unitEnd = unit?.endIndex ?? valueEnd;
    if (categorical(tokens[(unit?.endIndex ?? valueEnd) + 1] ?? '') === value) continue;
    const maybeFlag = tokens[unitEnd + 1];
    const flag =
      value.endsWith('+') && categorical(maybeFlag ?? '') !== null
        ? normalizeWhitespace(maybeFlag!)
        : null;
    const referenceStart = flag === null ? unitEnd : unitEnd + 1;
    const reference = categoricalReference(tokens, valueEnd, referenceStart);
    return {
      label,
      value,
      unit: unit?.unit ?? null,
      referenceInterval: reference.value,
      flag,
      valueType: 'categorical',
      parsedValue: value,
      comparator: null,
    };
  }
  return null;
}

function textRowWithUnit(tokens: readonly string[]): PaddleOCRRow | null {
  for (let unitIndex = 1; unitIndex < tokens.length; unitIndex += 1) {
    const unit = unitAt(tokens, unitIndex);
    if (unit === null) continue;
    const label = cleanLabel(tokens.slice(0, unitIndex).join(' '));
    const remainder = normalizeWhitespace(tokens.slice(unit.endIndex + 1).join(' '));
    if (
      label.length === 0 ||
      proseLabel(label) ||
      remainder.split(' ').length < 4 ||
      !/^[A-Z]/u.test(remainder)
    )
      continue;
    const sentence = normalizeWhitespace(
      remainder.match(/^.*?[.!?](?:\s|$).*?[.!?](?:\s|$)/u)?.[0] ??
        remainder.match(/^.*?[.!?](?:\s|$)/u)?.[0] ??
        remainder,
    );
    if (sentence.length === 0 || /^(?:Reference|Date|Page)\b/iu.test(label)) continue;
    return {
      label,
      value: sentence,
      unit: unit.unit,
      referenceInterval: null,
      flag: null,
      valueType: 'text',
      parsedValue: sentence,
      comparator: null,
    };
  }
  return null;
}

function statusRow(line: string): PaddleOCRRow | null {
  const match = line.match(
    /\b((?:Test\s+not\s+performed|Pending|Cancelled)\.?[^]*|See\s+below:?|Will\s+Follow)$/iu,
  );
  if (match === null || match.index === undefined) return null;
  const prefixTokens = normalizeWhitespace(line.slice(0, match.index)).split(' ').filter(Boolean);
  let sourceStart = 0;
  for (let index = prefixTokens.length - 1; index >= 0; index -= 1) {
    if (numberToken(prefixTokens[index]!) !== null || rangeToken(prefixTokens[index]!)) {
      sourceStart = index + 1;
      break;
    }
  }
  const source = cleanLabel(prefixTokens.slice(sourceStart).join(' '));
  const safeLabel = source;
  if (safeLabel.length === 0 || proseLabel(safeLabel) || boundedText(safeLabel) === null)
    return null;
  const value = boundedText(match[1] ?? '');
  if (value === null) return null;
  return {
    label: safeLabel,
    value,
    unit: null,
    referenceInterval: null,
    flag: null,
    valueType: 'text',
    parsedValue: value,
    comparator: null,
  };
}

/** Parse Paddle's plain transcription while rejecting unbounded/prose numeric hallucinations. */
export function parsePaddleOCRText(raw: string): readonly PaddleOCRRow[] {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_CHARS)
    throw new Error('paddleocr-output-too-large');
  const lines = raw.split(/\r?\n/u);
  if (lines.length > MAX_LINES) throw new Error('paddleocr-too-many-lines');
  if (lines.some((line) => line.length > MAX_LINE_LENGTH))
    throw new Error('paddleocr-line-too-long');
  const normalizedLines = lines
    .map((line) => normalizeWhitespace(line).toLocaleLowerCase('en-US'))
    .filter(Boolean);
  for (let size = 2; size <= Math.floor(normalizedLines.length / 2); size += 1) {
    if (
      normalizedLines.slice(0, size).join('\n') === normalizedLines.slice(size, size * 2).join('\n')
    )
      throw new Error('paddleocr-pathological-repetition');
  }
  const rows: PaddleOCRRow[] = [];
  let interpretive = false;
  for (const line of lines) {
    const normalized = normalizeWhitespace(line);
    if (normalized.length === 0) continue;
    if (
      /\b(?:INTERPRETATIVE INFORMATION|PARTICLE CONCENTRATION AND SIZE|INSULIN RESISTANCE\s*\/\s*DIABETES RISK MARKERS|Percentile in Reference Population)\b/iu.test(
        normalized,
      )
    ) {
      interpretive = true;
      continue;
    }
    if (interpretive && /\bTest\s+Current\s+Result\b/iu.test(normalized)) {
      interpretive = false;
      continue;
    }
    if (interpretive) continue;
    const tokens = normalized.split(' ');
    const before = rows.length;
    for (let index = 0; index < tokens.length; index += 1) {
      if (numberToken(tokens[index]!) === null || rangeToken(tokens[index]!)) continue;
      const parsed = numericRow(tokens, index);
      if (parsed !== null) {
        if (parsed.row !== null) rows.push(parsed.row);
        // Preserve the proven parser's token consumption. In a flattened row the reference
        // number is part of the current result and must never become a second measurement.
        index = parsed.endIndex;
      }
      if (rows.length >= MAX_ROWS) throw new Error('paddleocr-too-many-rows');
    }
    const status = statusRow(normalized);
    if (status !== null) rows.push(status);
    const categoricalResult = categoricalRow(tokens);
    if (categoricalResult !== null) rows.push(categoricalResult);
    if (rows.length === before) {
      const textWithUnit = textRowWithUnit(tokens);
      if (textWithUnit !== null) rows.push(textWithUnit);
    }
    if (rows.length >= MAX_ROWS) throw new Error('paddleocr-too-many-rows');
  }
  return rows;
}

function paddleOCRRowKey(row: PaddleOCRRow): string {
  return JSON.stringify([
    comparable(row.label),
    row.value,
    row.unit,
    row.referenceInterval,
    row.flag,
    row.valueType,
    row.parsedValue,
    row.comparator,
  ]);
}

function paddleOCRRowLabelKey(row: PaddleOCRRow): string {
  return comparable(row.label);
}

function paddleOCRSemantic(
  sourceObservationIds: readonly string[],
  sourceFieldObservationIds?: {
    readonly label: string;
    readonly value: string;
    readonly unit: string | null;
    readonly referenceInterval: string | null;
    readonly flag: string | null;
  },
) {
  return {
    adapterVersion: PADDLEOCR_ADAPTER_VERSION,
    schemaVersion: PADDLEOCR_SCHEMA_VERSION,
    sourceObservationIds: [...sourceObservationIds],
    ...(sourceFieldObservationIds === undefined ? {} : { sourceFieldObservationIds }),
    modelVersion: productionLocalModelManifest.pack.artifact.revision,
    runtimeVersion: productionLocalModelManifest.runtime.revision,
    promptVersion: PADDLEOCR_PROMPT_VERSION,
  } as const;
}

type PaddleOCRReviewProposal = Omit<
  Pick<PaddleOCRRow, 'label' | 'value' | 'unit' | 'referenceInterval' | 'flag'>,
  'value'
> & {
  readonly value: string | null;
  /** Optional fields keep this compatibility API lossless when the caller has parsed rows. */
  readonly valueType?: PaddleOCRValueType;
  readonly parsedValue?: number | string;
  readonly comparator?: PaddleOCRComparator;
};

function reviewProposalValue(proposal: PaddleOCRReviewProposal): MeasurementValue {
  const value = proposal.value ?? '';
  if (
    proposal.valueType === 'numeric' &&
    proposal.comparator === null &&
    typeof proposal.parsedValue === 'number' &&
    Number.isFinite(proposal.parsedValue)
  )
    return { kind: 'numeric', value: proposal.parsedValue };
  if (
    proposal.valueType === 'bounded' &&
    (proposal.comparator === '<' || proposal.comparator === '>') &&
    typeof proposal.parsedValue === 'number' &&
    Number.isFinite(proposal.parsedValue)
  )
    return { kind: 'bounded', comparator: proposal.comparator, value: proposal.parsedValue };
  if (proposal.valueType === 'categorical' && value.length > 0)
    return { kind: 'categorical', value };

  // The domain value contract has only strict bounded comparators. Preserve <= and >= as exact
  // free text and keep them mandatory review work until that contract can represent their meaning.
  if (proposal.valueType === 'bounded') return { kind: 'free_text', value };
  const parsed = parseComparatorValue(value);
  if (parsed?.kind === 'numeric' || parsed?.kind === 'bounded') return parsed;
  if (
    /^(?:negative|positive|yellow|clear|normal|abnormal|trace|none|none\s+seen|a|b|ab|o)$/iu.test(
      value,
    )
  )
    return { kind: 'categorical', value };
  return { kind: 'free_text', value };
}

function reviewFieldObservation(
  id: string,
  text: string,
  pageIndex: number,
  locale: string,
): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x: 0, y: 0, width: 1, height: 1 },
    pageIndex,
    orientation: 0,
    structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
    recognition: { level: 'accurate', language: locale, internalConfidence: null },
  };
}

/**
 * Merge results from a full-page capture and retry bands without selecting between conflicting
 * source claims. Exact duplicates are kept once; rows sharing a label but disagreeing in any
 * parsed/source field are all discarded for later review.
 */
export function deduplicatePaddleOCRRows(rows: readonly PaddleOCRRow[]): readonly PaddleOCRRow[] {
  const keysByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    const labelKey = paddleOCRRowLabelKey(row);
    const keys = keysByLabel.get(labelKey) ?? new Set<string>();
    keys.add(paddleOCRRowKey(row));
    keysByLabel.set(labelKey, keys);
  }
  const conflictingLabels = new Set(
    [...keysByLabel.entries()].filter(([, keys]) => keys.size > 1).map(([label]) => label),
  );
  const seen = new Set<string>();
  return rows.filter((row) => {
    const labelKey = paddleOCRRowLabelKey(row);
    if (conflictingLabels.has(labelKey)) return false;
    const key = paddleOCRRowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Preserves ungrounded Paddle transcription as explicit page-level review work. These values are
 * extracted candidates, never confirmed Measurements: the whole-page location and model
 * provenance make the missing field geometry visible and force a person to resolve the row. The
 * semantic marker records a model-derived page candidate and does not certify independent Vision
 * evidence.
 */
export function createPaddleOCRReviewRows(
  proposalsByPage: ReadonlyMap<number, readonly PaddleOCRReviewProposal[]>,
  options: PaddleOCRGroundingOptions,
): readonly ExtractionDraftRow[] {
  return [...proposalsByPage].flatMap(([pageIndex, proposals]) =>
    proposals.flatMap((proposal, index) => {
      if (proposal.value === null) return [];
      const proposalLabel = normalizeWhitespace(proposal.label);
      const proposalValue = normalizeWhitespace(proposal.value);
      // A flattened OCR line is not a field selection. Keep the source for review, but do not
      // present the same complete line as both the editable Name and Value.
      if (
        proposalLabel.length === 0 ||
        proposalValue.length === 0 ||
        comparable(proposalLabel) === comparable(proposalValue)
      )
        return [];
      const rowId = `paddleocr:p${pageIndex}:r${index}`;
      const fieldIds = {
        label: `${rowId}:label`,
        value: `${rowId}:value`,
        unit: proposal.unit === null ? null : `${rowId}:unit`,
        referenceInterval:
          proposal.referenceInterval === null ? null : `${rowId}:reference-interval`,
        flag: proposal.flag === null ? null : `${rowId}:flag`,
      } as const;
      const observations = [
        reviewFieldObservation(fieldIds.label, proposal.label, pageIndex, options.locale),
        reviewFieldObservation(fieldIds.value, proposal.value, pageIndex, options.locale),
        ...(proposal.unit === null
          ? []
          : [reviewFieldObservation(fieldIds.unit!, proposal.unit, pageIndex, options.locale)]),
        ...(proposal.referenceInterval === null
          ? []
          : [
              reviewFieldObservation(
                fieldIds.referenceInterval!,
                proposal.referenceInterval,
                pageIndex,
                options.locale,
              ),
            ]),
        ...(proposal.flag === null
          ? []
          : [reviewFieldObservation(fieldIds.flag!, proposal.flag, pageIndex, options.locale)]),
      ];
      const sourceText = observations.map((observation) => observation.text).join('  ');
      const sourceValue = reviewProposalValue(proposal);
      const proposedBiomarkerId = proposeBiomarkerId(proposal.label, options.aliases);
      const proposedLabel =
        proposedBiomarkerId === null
          ? proposal.label
          : (options.aliases.find((entry) => entry.id === proposedBiomarkerId)?.canonicalLabel ??
            proposal.label);
      const initialRow: ExtractionDraftRow = {
        id: rowId,
        order: index,
        panelLabel: null,
        sourceText,
        sourceLabel: proposal.label,
        sourceValue,
        sourceValueString: proposal.value,
        sourceUnit: proposal.unit,
        sourceReferenceInterval: proposal.referenceInterval,
        sourceFlag: proposal.flag,
        source: {
          pageIndex,
          orientation: 0,
          artifact: options.artifact,
          observationIds: observations.map((observation) => observation.id),
          observations,
          boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          semantic: paddleOCRSemantic(
            observations.map((observation) => observation.id),
            fieldIds,
          ),
          raw: {
            label: proposal.label,
            value: proposal.value,
            unit: proposal.unit,
            referenceInterval: proposal.referenceInterval,
            flag: proposal.flag,
            collectionDate: null,
          },
        },
        collectionDateContext: null,
        proposedLabel,
        proposedValue: sourceValue,
        proposedUnit: proposal.unit,
        proposedReferenceInterval: proposal.referenceInterval,
        proposedFlag: proposal.flag,
        proposedBiomarkerId,
        proposedSpecimenType: 'unknown',
        collectionDate: options.collectionDate,
        reviewReasons: [],
        reviewState: 'needs-review',
        decision: 'preserve',
        editState: 'automatic',
      };
      // The source fields are already exact Paddle fields. This domain pass checks compatibility
      // and review reasons through the selected fields without rescanning a flattened source line.
      const row = revalidateExtractionRow(initialRow, {}, options.aliases, {
        sourceFields: fieldIds,
        collectionDateDefaulted: options.collectionDateDefaulted,
      });
      const reviewReasons = new Set([...row.reviewReasons, 'unsupported-layout' as const]);
      if (
        proposal.valueType === 'bounded' &&
        proposal.comparator !== undefined &&
        proposal.comparator !== '<' &&
        proposal.comparator !== '>'
      )
        reviewReasons.add('unparseable-value');
      return [
        {
          ...row,
          reviewReasons: [...reviewReasons],
          reviewState: 'needs-review' as const,
          decision: 'preserve' as const,
          editState: 'automatic' as const,
        },
      ];
    }),
  );
}

export function createPaddleOCRPrompt(): string {
  // Native owns model-family framing. The JS adapter supplies the reviewed literal OCR task.
  return 'OCR:';
}

export type GroundPaddleOCRRowsResult = {
  readonly rows: readonly ExtractionDraftRow[];
  readonly matchedPhysicalRowIds: ReadonlySet<string>;
  readonly matchedProposalKeys: ReadonlySet<string>;
  readonly matchedPhysicalRows: number;
  readonly ambiguousPhysicalRows: number;
  readonly unmatchedProposals: number;
};

type PaddleOCRGroundingProposal = {
  readonly label: string;
  readonly value: string | null;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
};

export type PaddleOCRGroundingOptions = {
  readonly locale: string;
  readonly collectionDate: LabDateState;
  readonly collectionDateDefaulted: boolean;
  readonly collectionDateContexts: readonly ExtractionDateContext[];
  readonly aliases: readonly ExtractionAliasEntry[];
  readonly artifact: LabSourceArtifact;
  readonly existingSourceObservationIds?: ReadonlySet<string>;
};

function comparable(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}
function sourceText(variant: GeometryCandidateWindowRow, id: string | null): string | null {
  return id === null
    ? null
    : (variant.observations.find((observation) => observation.id === id)?.text ?? null);
}
function labelMatches(proposal: string, source: string | null): boolean {
  if (source === null) return false;
  const left = comparable(proposal);
  const right = comparable(source);
  return left === right || (left.length >= 3 && right.includes(left));
}
function optionalFieldMatches(proposal: string | null, source: string | null): boolean {
  return proposal === null || (source !== null && comparable(proposal) === comparable(source));
}
function rowMatches(
  proposal: PaddleOCRGroundingProposal,
  variant: GeometryCandidateWindowRow,
): boolean {
  const fields = variant.provisionalSourceFields;
  return (
    labelMatches(proposal.label, sourceText(variant, fields.label)) &&
    optionalFieldMatches(proposal.value, sourceText(variant, fields.value)) &&
    optionalFieldMatches(proposal.unit, sourceText(variant, fields.unit)) &&
    optionalFieldMatches(
      proposal.referenceInterval,
      sourceText(variant, fields.referenceInterval),
    ) &&
    optionalFieldMatches(proposal.flag, sourceText(variant, fields.flag))
  );
}

/**
 * Source grounding is a fail-closed join: model strings can identify one exact physical row, but
 * the returned draft is rebuilt entirely from that row's trusted observations.
 */
export function groundPaddleOCRRows(
  proposalsByPage: ReadonlyMap<number, readonly PaddleOCRGroundingProposal[]>,
  groups: readonly GeometryCandidateWindowGroup[],
  options: PaddleOCRGroundingOptions,
): GroundPaddleOCRRowsResult {
  const rows: ExtractionDraftRow[] = [];
  const matched = new Set<string>();
  const matchedProposalKeys = new Set<string>();
  let ambiguousPhysicalRows = 0;
  let unmatchedProposals = 0;
  for (const [pageIndex, proposals] of proposalsByPage) {
    const pageGroups = groups.filter(
      (group) => group.context.pageIndex === pageIndex && group.withinInputBounds,
    );
    for (const [proposalIndex, proposal] of proposals.entries()) {
      const matches = pageGroups.flatMap((group) =>
        matched.has(group.physicalRowId) ||
        group.sourceObservationIds.some((id) => options.existingSourceObservationIds?.has(id))
          ? []
          : group.variants
              .filter((variant) => rowMatches(proposal, variant))
              .map((variant) => ({ group, variant })),
      );
      const physical = new Set(matches.map((match) => match.group.physicalRowId));
      if (matches.length !== 1 || physical.size !== 1) {
        if (matches.length > 1) ambiguousPhysicalRows += 1;
        else unmatchedProposals += 1;
        continue;
      }
      const match = matches[0]!;
      const provisional = parseGeometryCandidateVariantAsProvisional(match.variant, {
        locale: options.locale,
        collectionDate: options.collectionDate,
        collectionDateDefaulted: options.collectionDateDefaulted,
        collectionDateContexts: options.collectionDateContexts,
        specimenType: 'unknown',
        aliases: options.aliases,
        artifact: options.artifact,
      });
      if (provisional === null) {
        unmatchedProposals += 1;
        continue;
      }
      matched.add(match.group.physicalRowId);
      matchedProposalKeys.add(`${pageIndex}:${proposalIndex}`);
      rows.push({
        ...provisional.row,
        source: {
          ...provisional.row.source,
          // This metadata records the model-derived selection. The row itself is rebuilt from
          // exact page observations and remains mandatory review work; it does not certify
          // independent Vision evidence.
          semantic: paddleOCRSemantic(match.group.sourceObservationIds),
        },
        reviewState: 'needs-review',
        decision: 'preserve',
        editState: 'automatic',
      });
    }
  }
  return {
    rows,
    matchedPhysicalRowIds: matched,
    matchedProposalKeys,
    matchedPhysicalRows: matched.size,
    ambiguousPhysicalRows,
    unmatchedProposals,
  };
}

function failureCategory(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    readonly failure?: unknown;
    readonly failureCategory?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown };
  };
  return candidate.failure ?? candidate.failureCategory ?? candidate.userInfo?.failureCategory;
}

function isTruncatedFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly failure?: unknown;
    readonly failureCategory?: unknown;
    readonly message?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown; readonly code?: unknown };
  };
  return [
    candidate.code,
    candidate.failure,
    candidate.failureCategory,
    candidate.message,
    candidate.userInfo?.code,
    candidate.userInfo?.failureCategory,
  ].some(
    (value) => typeof value === 'string' && /(?:runtimeerror\.)?truncat(?:ed|ion)/iu.test(value),
  );
}

function waitForSettlement(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    () => true,
    () => true,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * A native stop signal is advisory. The timeout/cancellation race returns to JS promptly, while
 * the bounded drain gives the serialized native context a chance to finish before reuse.
 */
function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  onCancel: () => void,
  cancellation:
    | {
        readonly isCancelled: () => boolean;
        readonly subscribe: (listener: () => void) => () => void;
      }
    | undefined,
  onDrainComplete: (settled: boolean) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cancelled = false;
  let unsubscribe: () => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        onCancel();
      } catch {
        // A failed native stop signal cannot prevent the bounded timeout fallback.
      }
      reject(new Error('paddleocr-timeout'));
    }, milliseconds);
  });
  const cancellationPromise =
    cancellation === undefined
      ? null
      : new Promise<never>((_, reject) => {
          unsubscribe = cancellation.subscribe(() => {
            if (timedOut || cancelled) return;
            cancelled = true;
            try {
              onCancel();
            } catch {
              // The extraction still observes the cancellation error below.
            }
            reject(new Error('paddleocr-cancelled'));
          });
        });
  const raced =
    cancellationPromise === null
      ? Promise.race([work, timeout])
      : Promise.race([work, timeout, cancellationPromise]);
  return raced.finally(async () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    if (timedOut || cancelled) onDrainComplete(await waitForSettlement(work, DRAIN_TIMEOUT_MS));
  });
}

export class PaddleOCRUnavailableError extends Error {
  readonly code = 'paddleocr-unavailable' as const;
}

/** Native C-8 exhaustion is recoverable by the report crop retry path. */
export class PaddleOCRTruncatedError extends Error {
  readonly code = 'paddleocr-truncated' as const;
  readonly recoverable = true as const;
}

export type PaddleOCRExtractor = {
  readonly adapterVersion: typeof PADDLEOCR_ADAPTER_VERSION;
  readonly schemaVersion: typeof PADDLEOCR_SCHEMA_VERSION;
  readonly provenance: {
    readonly modelVersion: string;
    readonly runtimeVersion: string;
    readonly promptVersion: typeof PADDLEOCR_PROMPT_VERSION;
  };
  readonly retryPlan: typeof buildPaddleOCRRetryPlan;
  readonly checkAvailability: () => Promise<void>;
  readonly prepare: () => Promise<{ readonly release: () => Promise<void> }>;
  readonly supports: (locale: string | null) => boolean;
  readonly extract: (input: {
    readonly pageIndex: number;
    readonly imageURI: string;
    readonly locale: string;
    readonly timeoutMs?: number;
    readonly maxOutputTokens?: number;
    readonly cancellation?: {
      readonly isCancelled: () => boolean;
      readonly subscribe: (listener: () => void) => () => void;
    };
  }) => Promise<readonly PaddleOCRRow[]>;
};

type ActiveInference = {
  readonly generation: number;
  readonly settled: Promise<void>;
  readonly cancel: () => void;
};

/** Local-only lifecycle adapter. A late native completion is quarantined until it has drained. */
export function createLocalPaddleOCR(options: {
  readonly models: LocalModelService;
  readonly timeoutMs?: number;
  /** Retained for callers of the initial adapter; late settlement is now event-driven. */
  readonly recoveryTimeoutMs?: number;
}): PaddleOCRExtractor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('paddleocr-inference-timeout-invalid');
  let activeLeases = 0;
  let lifecycleQueue: Promise<void> = Promise.resolve();
  let inferenceQueue: Promise<void> = Promise.resolve();
  let active: ActiveInference | null = null;
  let generation = 0;
  let quarantined = false;
  let deferredReleaseGeneration: number | null = null;

  const enqueueLifecycle = <T>(work: () => Promise<T>) => {
    const next = lifecycleQueue.then(work, work);
    lifecycleQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const enqueueInference = <T>(work: () => Promise<T>) => {
    const next = inferenceQueue.then(work, work);
    inferenceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const requireReady = async () => {
    const state = await options.models.getState();
    if (!canStartAutomatedExtraction(state) || options.models.inferImageRaw === undefined)
      throw new PaddleOCRUnavailableError('The verified PaddleOCR model pack is not installed');
  };

  const deferRuntimeRelease = (inference: ActiveInference): void => {
    if (deferredReleaseGeneration === inference.generation) return;
    deferredReleaseGeneration = inference.generation;
    void inference.settled.then(() => {
      if (deferredReleaseGeneration !== inference.generation) return;
      deferredReleaseGeneration = null;
      if (activeLeases !== 0 || active !== null) return;
      void enqueueLifecycle(async () => {
        if (activeLeases !== 0 || active !== null || quarantined) return;
        const current = await options.models.getState();
        if (current.loaded) await options.models.unload();
      }).catch(() => undefined);
    });
  };

  const releaseRuntime = async () => {
    // cancelInference is a signal, not a completion barrier. Issue it before waiting on the
    // serialized JS queue so the native context can drain concurrently.
    if (activeLeases === 1 && active !== null) {
      try {
        active.cancel();
      } catch {
        // Native cancellation is advisory; the bounded drain/quarantine still protects reuse.
      }
    }
    await inferenceQueue;
    activeLeases = Math.max(0, activeLeases - 1);
    if (activeLeases !== 0) return;

    const running = active;
    if (running !== null) {
      const settled = await waitForSettlement(running.settled, DRAIN_TIMEOUT_MS);
      if (!settled || active !== null) {
        // JS release returns even when the native bridge never settles. The runtime cannot be
        // reused or unloaded until the late completion has actually drained.
        quarantined = true;
        deferRuntimeRelease(running);
        return;
      }
    }
    if (quarantined || active !== null) return;
    const state = await options.models.getState();
    if (state.loaded) await options.models.unload();
  };

  const languageCode = (value: string | null): string | null => {
    if (value === null) return null;
    const code = value.toLocaleLowerCase().split(/[-_]/u)[0];
    return code === undefined || code.length === 0 ? null : code;
  };

  const runNativeInference = async (input: {
    readonly imageURI: string;
    readonly cancellation:
      | {
          readonly isCancelled: () => boolean;
          readonly subscribe: (listener: () => void) => () => void;
        }
      | undefined;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  }): Promise<string> => {
    if (input.cancellation?.isCancelled() === true) throw new Error('paddleocr-cancelled');
    if (quarantined || active !== null)
      throw new PaddleOCRUnavailableError(
        'The previous PaddleOCR request has not released its runtime',
      );
    const inferImageRaw = options.models.inferImageRaw;
    if (inferImageRaw === undefined)
      throw new PaddleOCRUnavailableError('The PaddleOCR runtime is unavailable');
    const requestGeneration = ++generation;
    const nativeWork = Promise.resolve().then(() =>
      inferImageRaw(createPaddleOCRPrompt(), input.imageURI, {
        maxOutputTokens: input.maxOutputTokens,
        outputCapacity: MAX_INFERENCE_OUTPUT_BYTES,
      }),
    );
    let cancelled = false;
    const current: ActiveInference = {
      generation: requestGeneration,
      settled: nativeWork.then(
        () => undefined,
        () => undefined,
      ),
      cancel: () => {
        if (cancelled || active?.generation !== requestGeneration) return;
        cancelled = true;
        options.models.cancelInference();
      },
    };
    active = current;
    void current.settled.then(() => {
      if (active !== current) return;
      active = null;
      quarantined = false;
    });
    try {
      return await withTimeout(
        nativeWork,
        input.timeoutMs,
        current.cancel,
        input.cancellation,
        (settled) => {
          if (!settled && active === current) quarantined = true;
        },
      );
    } catch (error) {
      if (isTruncatedFailure(error))
        throw new PaddleOCRTruncatedError('PaddleOCR output truncated');
      if (failureCategory(error) === 'unavailable')
        throw new PaddleOCRUnavailableError(
          'The PaddleOCR runtime became unavailable during import',
        );
      throw error;
    }
  };

  return {
    adapterVersion: PADDLEOCR_ADAPTER_VERSION,
    schemaVersion: PADDLEOCR_SCHEMA_VERSION,
    provenance: {
      modelVersion: productionLocalModelManifest.pack.artifact.revision,
      runtimeVersion: productionLocalModelManifest.runtime.revision,
      promptVersion: PADDLEOCR_PROMPT_VERSION,
    },
    retryPlan: buildPaddleOCRRetryPlan,
    checkAvailability: () => enqueueLifecycle(requireReady),
    supports: (locale) => {
      const code = languageCode(locale);
      return (
        code !== null &&
        productionLocalModelManifest.compatibility.languages.includes(
          code as (typeof productionLocalModelManifest.compatibility.languages)[number],
        )
      );
    },
    prepare: () =>
      enqueueLifecycle(async () => {
        await requireReady();
        if (quarantined || active !== null)
          throw new PaddleOCRUnavailableError(
            'The previous PaddleOCR request has not released its runtime',
          );
        const state = await options.models.getState();
        if (!state.loaded) await options.models.load();
        activeLeases += 1;
        let released = false;
        return {
          release: () => {
            if (released) return Promise.resolve();
            released = true;
            return enqueueLifecycle(releaseRuntime);
          },
        };
      }),
    extract: async (input) =>
      enqueueInference(async () => {
        if (input.cancellation?.isCancelled() === true) throw new Error('paddleocr-cancelled');
        if (activeLeases === 0 || quarantined || active !== null)
          throw new PaddleOCRUnavailableError('The PaddleOCR model is not loaded');
        const requestTimeout = Math.min(timeoutMs, input.timeoutMs ?? timeoutMs);
        const maxOutputTokens = input.maxOutputTokens ?? MAX_INFERENCE_OUTPUT_TOKENS;
        if (
          !Number.isSafeInteger(maxOutputTokens) ||
          maxOutputTokens < 1 ||
          maxOutputTokens > MAX_INFERENCE_OUTPUT_TOKENS ||
          !Number.isFinite(requestTimeout) ||
          requestTimeout <= 0
        )
          throw new Error('paddleocr-inference-limits-invalid');
        const raw = await runNativeInference({
          imageURI: input.imageURI,
          cancellation: input.cancellation,
          maxOutputTokens,
          timeoutMs: requestTimeout,
        });
        return parsePaddleOCRText(raw);
      }),
  };
}
