/**
 * Evaluation-only recovery for a local Document VLM response.
 *
 * The production decoder remains strict and is intentionally not changed. This helper is used
 * only after that decoder rejects a response, and admits complete row objects whose fields still
 * satisfy the production row grammar. It never completes an object, fills a missing field, or
 * treats a model diagnostic as a measurement.
 */
import {
  decodeDocumentVLMRows,
  type DocumentVLMRow,
} from '../../apps/mobile/src/features/local-models/document-vlm';

export type DocumentVLMRecoveryStatus = 'strict' | 'recovered' | 'invalid';

export type DocumentVLMRecovery = {
  readonly status: DocumentVLMRecoveryStatus;
  readonly rows: readonly DocumentVLMRow[];
  readonly completeRowObjects: number;
  readonly rejectedRowObjects: number;
  readonly repetitionDetected: boolean;
  readonly repeatedRowIndex: number | null;
  readonly deferredRowObjects: number;
};

const ROW_KEYS = ['flag', 'label', 'reference_interval', 'unit', 'value'] as const;
const MAX_FIELD_LENGTH = 512;
const MAX_ROWS = 80;

function isBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_FIELD_LENGTH);
}

function isTemplatePlaceholder(value: string): boolean {
  return /^(?:\.{3}|…|<\.\.\.|string)$/u.test(value.trim());
}

function normalizedOptional(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

type RawDocumentVLMRow = {
  readonly label: string;
  readonly value: string | null;
  readonly unit: string | null;
  readonly reference_interval: string | null;
  readonly flag: string | null;
};

function isCompleteRow(value: unknown): value is RawDocumentVLMRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (keys.length !== ROW_KEYS.length || keys.some((key, index) => key !== ROW_KEYS[index])) {
    return false;
  }
  return (
    typeof record.label === 'string' &&
    record.label.trim().length > 0 &&
    !isTemplatePlaceholder(record.label) &&
    record.label.length <= MAX_FIELD_LENGTH &&
    isBoundedString(record.value) &&
    (record.value === null ||
      (record.value.trim().length > 0 && !isTemplatePlaceholder(record.value))) &&
    isBoundedString(record.unit) &&
    isBoundedString(record.reference_interval) &&
    isBoundedString(record.flag)
  );
}

function matchingRowsKey(raw: string): number {
  let match: RegExpExecArray | null = null;
  const pattern = /["']rows["']\s*:/gu;
  for (const candidate of raw.matchAll(pattern)) match = candidate;
  return match?.index ?? -1;
}

/** Return the end offset of one complete JSON object, or null when the object is incomplete. */
function completeObjectEnd(raw: string, start: number): number | null {
  if (raw[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function arrayContentEnd(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return raw.length;
}

function recoverCompleteRows(raw: string): {
  readonly rows: readonly DocumentVLMRow[];
  readonly completeRowObjects: number;
  readonly rejectedRowObjects: number;
  readonly repetitionDetected: boolean;
  readonly repeatedRowIndex: number | null;
  readonly deferredRowObjects: number;
} {
  const rowsAnchor = matchingRowsKey(raw);
  if (rowsAnchor < 0) {
    return {
      rows: [],
      completeRowObjects: 0,
      rejectedRowObjects: 0,
      repetitionDetected: false,
      repeatedRowIndex: null,
      deferredRowObjects: 0,
    };
  }
  const arrayStart = raw.indexOf('[', rowsAnchor);
  if (arrayStart < 0)
    return {
      rows: [],
      completeRowObjects: 0,
      rejectedRowObjects: 0,
      repetitionDetected: false,
      repeatedRowIndex: null,
      deferredRowObjects: 0,
    };
  const arrayEnd = arrayContentEnd(raw, arrayStart);

  const rows: DocumentVLMRow[] = [];
  let completeRowObjects = 0;
  let rejectedRowObjects = 0;
  let repetitionDetected = false;
  let repeatedRowIndex: number | null = null;
  let deferredRowObjects = 0;
  const admittedRowKeys = new Set<string>();
  for (let index = arrayStart + 1; index < arrayEnd; index += 1) {
    if (raw[index] !== '{') continue;
    const end = completeObjectEnd(raw, index);
    if (end === null) {
      rejectedRowObjects += 1;
      continue;
    }
    completeRowObjects += 1;
    try {
      const value: unknown = JSON.parse(raw.slice(index, end));
      if (isCompleteRow(value)) {
        const canonicalRow: DocumentVLMRow = {
          label: value.label.trim(),
          value: normalizedOptional(value.value),
          unit: normalizedOptional(value.unit),
          referenceInterval: normalizedOptional(value.reference_interval),
          flag: normalizedOptional(value.flag),
        };
        const rowKey = JSON.stringify(canonicalRow);
        if (repetitionDetected || admittedRowKeys.has(rowKey)) {
          if (!repetitionDetected) {
            repetitionDetected = true;
            repeatedRowIndex = completeRowObjects - 1;
          }
          deferredRowObjects += 1;
        } else if (rows.length < MAX_ROWS) {
          rows.push(canonicalRow);
          admittedRowKeys.add(rowKey);
        } else {
          deferredRowObjects += 1;
        }
      } else {
        rejectedRowObjects += 1;
      }
    } catch {
      rejectedRowObjects += 1;
    }
    index = end - 1;
  }
  return {
    rows,
    completeRowObjects,
    rejectedRowObjects,
    repetitionDetected,
    repeatedRowIndex,
    deferredRowObjects,
  };
}

/**
 * Decode a response strictly first, then recover only complete grammar-valid rows after a rows
 * array marker. The returned status makes a recovered response distinguishable from production
 * decoding in evaluation artifacts.
 */
export function recoverDocumentVLMRows(raw: string): DocumentVLMRecovery {
  try {
    return {
      status: 'strict',
      rows: decodeDocumentVLMRows(raw),
      completeRowObjects: 0,
      rejectedRowObjects: 0,
      repetitionDetected: false,
      repeatedRowIndex: null,
      deferredRowObjects: 0,
    };
  } catch {
    const recovered = recoverCompleteRows(raw);
    return {
      status: recovered.rows.length > 0 ? 'recovered' : 'invalid',
      ...recovered,
    };
  }
}
