import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const IMPORT_EVALUATION_SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
export const GROUND_TRUTH_VERSION = 1 as const;

export type EvaluationValueType = 'numeric' | 'bounded' | 'categorical' | 'text' | 'unknown';
export type EvaluationComparator = '<' | '>' | '<=' | '>=' | '=' | null;

export type EvaluationLocation = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type EvaluationMeasurement = {
  readonly id: string;
  readonly sourceLabel: string;
  readonly valueString: string | null;
  readonly valueType: EvaluationValueType;
  readonly parsedValue: number | string | null;
  readonly comparator: EvaluationComparator;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
  readonly collectionDate: string | null;
  readonly collectionGroup: string | null;
  readonly specimen: string | null;
  readonly page: number | null;
  readonly location: EvaluationLocation | null;
  readonly ambiguousFields: readonly string[];
  readonly canonicalBiomarkerId?: string | null;
  readonly trendEligible?: boolean | null;
  readonly unresolvedFields?: readonly string[];
  readonly sourceIds?: readonly string[];
};

export type GroundTruthReview = {
  readonly status: 'draft' | 'source-checked';
  readonly method: string;
  readonly reviewedPages: readonly number[];
  readonly notes: readonly string[];
};

export type ExpectedResults = {
  readonly schemaVersion: typeof IMPORT_EVALUATION_SCHEMA_VERSION;
  readonly reportId: string;
  readonly reportSha256: string;
  readonly groundTruthVersion: typeof GROUND_TRUTH_VERSION;
  readonly review: GroundTruthReview;
  readonly measurements: readonly EvaluationMeasurement[];
};

export type PipelineMetadata = {
  readonly id: string;
  readonly version: string;
  readonly configuration: Record<string, unknown>;
  readonly runtime: Record<string, unknown>;
};

export type PipelineStage = {
  readonly name: string;
  readonly elapsedMs: number;
  readonly inputCount?: number;
  readonly outputCount?: number;
  readonly status: string;
};

export type PipelineResult = {
  readonly schemaVersion: typeof IMPORT_EVALUATION_SCHEMA_VERSION;
  readonly reportId: string;
  readonly reportSha256: string;
  readonly pipeline: PipelineMetadata;
  readonly stages: readonly PipelineStage[];
  readonly elapsedMs: number;
  readonly measurements: readonly EvaluationMeasurement[];
  readonly diagnostics: {
    readonly counts: Record<string, number>;
    readonly limitations: readonly string[];
  };
};

export type EvaluationArtifact = ExpectedResults | PipelineResult;

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const VALUE_TYPES = new Set<EvaluationValueType>([
  'numeric',
  'bounded',
  'categorical',
  'text',
  'unknown',
]);
const COMPARATORS = new Set<Exclude<EvaluationComparator, null>>(['<', '>', '<=', '>=', '=']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
  // Keep validation errors structural. In particular, never interpolate a source label, value,
  // OCR line, or JSON parser message into an ordinary runner error.
  throw new Error(`invalid import-evaluation artifact: ${message}`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value;
}

function nullableStringField(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') fail(`${field} must be a string or null`);
  return value;
}

function booleanOrNullField(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== 'boolean') fail(`${field} must be a boolean or null`);
  return value;
}

function finiteNumberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${field} must be finite`);
  return value;
}

function stringArrayField(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return value as string[];
}

function integerArrayField(value: unknown, field: string): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 1)
  ) {
    fail(`${field} must be an array of positive integers`);
  }
  return value as number[];
}

function hashField(value: unknown, field: string): string {
  const result = stringField(value, field);
  if (!HEX_SHA256.test(result)) fail(`${field} must be a SHA-256 hex digest`);
  return result;
}

function optionalStringOrNull(
  record: Record<string, unknown>,
  field: string,
): string | null | undefined {
  if (!(field in record)) return undefined;
  return nullableStringField(record[field], field);
}

function optionalBooleanOrNull(
  record: Record<string, unknown>,
  field: string,
): boolean | null | undefined {
  if (!(field in record)) return undefined;
  return booleanOrNullField(record[field], field);
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  if (!(field in record)) return undefined;
  return stringArrayField(record[field], field);
}

function parseLocation(value: unknown): EvaluationLocation | null {
  if (value === null) return null;
  if (!isRecord(value)) fail('location must be an object or null');
  return {
    x: finiteNumberField(value.x, 'location.x'),
    y: finiteNumberField(value.y, 'location.y'),
    width: finiteNumberField(value.width, 'location.width'),
    height: finiteNumberField(value.height, 'location.height'),
  };
}

export function parseMeasurement(value: unknown): EvaluationMeasurement {
  if (!isRecord(value)) fail('measurement must be an object');
  const valueType = stringField(value.valueType, 'valueType') as EvaluationValueType;
  if (!VALUE_TYPES.has(valueType)) fail('valueType is unsupported');
  const comparator = nullableStringField(value.comparator, 'comparator') as EvaluationComparator;
  if (comparator !== null && !COMPARATORS.has(comparator)) fail('comparator is unsupported');
  const parsedValue = value.parsedValue;
  if (
    parsedValue !== null &&
    typeof parsedValue !== 'string' &&
    (typeof parsedValue !== 'number' || !Number.isFinite(parsedValue))
  ) {
    fail('parsedValue must be a finite number, string, or null');
  }
  const page = value.page === null ? null : finiteNumberField(value.page, 'page');
  if (page !== null && (!Number.isInteger(page) || page < 1))
    fail('page must be a positive integer');
  const measurement = {
    id: stringField(value.id, 'id'),
    sourceLabel: stringField(value.sourceLabel, 'sourceLabel'),
    valueString: nullableStringField(value.valueString, 'valueString'),
    valueType,
    parsedValue: parsedValue as number | string | null,
    comparator,
    unit: nullableStringField(value.unit, 'unit'),
    referenceInterval: nullableStringField(value.referenceInterval, 'referenceInterval'),
    flag: nullableStringField(value.flag, 'flag'),
    collectionDate: nullableStringField(value.collectionDate, 'collectionDate'),
    collectionGroup: nullableStringField(value.collectionGroup, 'collectionGroup'),
    specimen: nullableStringField(value.specimen, 'specimen'),
    page,
    location: parseLocation(value.location),
    ambiguousFields: stringArrayField(value.ambiguousFields, 'ambiguousFields'),
  };
  const canonicalBiomarkerId = optionalStringOrNull(value, 'canonicalBiomarkerId');
  const trendEligible = optionalBooleanOrNull(value, 'trendEligible');
  const unresolvedFields = optionalStringArray(value, 'unresolvedFields');
  const sourceIds = optionalStringArray(value, 'sourceIds');
  return {
    ...measurement,
    ...(canonicalBiomarkerId === undefined ? {} : { canonicalBiomarkerId }),
    ...(trendEligible === undefined ? {} : { trendEligible }),
    ...(unresolvedFields === undefined ? {} : { unresolvedFields }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
  };
}

function parseMeasurements(value: unknown): readonly EvaluationMeasurement[] {
  if (!Array.isArray(value)) fail('measurements must be an array');
  const measurements = value.map(parseMeasurement);
  const ids = new Set<string>();
  for (const measurement of measurements) {
    if (ids.has(measurement.id)) fail('measurement ids must be unique');
    ids.add(measurement.id);
  }
  return measurements;
}

function parseReview(value: unknown): GroundTruthReview {
  if (!isRecord(value)) fail('review must be an object');
  const status = stringField(value.status, 'review.status');
  if (status !== 'draft' && status !== 'source-checked') fail('review.status is unsupported');
  return {
    status,
    method: stringField(value.method, 'review.method'),
    reviewedPages: integerArrayField(value.reviewedPages, 'review.reviewedPages'),
    notes: stringArrayField(value.notes, 'review.notes'),
  };
}

function schemaAndIdentity(value: Record<string, unknown>): {
  readonly reportId: string;
  readonly reportSha256: string;
} {
  if (value.schemaVersion !== IMPORT_EVALUATION_SCHEMA_VERSION) {
    fail('schemaVersion is unsupported');
  }
  return {
    reportId: stringField(value.reportId, 'reportId'),
    reportSha256: hashField(value.reportSha256, 'reportSha256'),
  };
}

export function parseExpectedResults(value: unknown): ExpectedResults {
  if (!isRecord(value)) fail('expected results must be an object');
  const identity = schemaAndIdentity(value);
  if (value.groundTruthVersion !== GROUND_TRUTH_VERSION) fail('groundTruthVersion is unsupported');
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    ...identity,
    groundTruthVersion: GROUND_TRUTH_VERSION,
    review: parseReview(value.review),
    measurements: parseMeasurements(value.measurements),
  };
}

function parseRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object`);
  return value;
}

function parseOptionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const count = finiteNumberField(value, field);
  if (!Number.isInteger(count) || count < 0) fail(`${field} must be a non-negative integer`);
  return count;
}

function parseStages(value: unknown): readonly PipelineStage[] {
  if (!Array.isArray(value)) fail('stages must be an array');
  return value.map((stage) => {
    if (!isRecord(stage)) fail('stage must be an object');
    const parsed = {
      name: stringField(stage.name, 'stage.name'),
      elapsedMs: finiteNumberField(stage.elapsedMs, 'stage.elapsedMs'),
      status: stringField(stage.status, 'stage.status'),
    };
    const inputCount = parseOptionalCount(stage.inputCount, 'stage.inputCount');
    const outputCount = parseOptionalCount(stage.outputCount, 'stage.outputCount');
    return {
      ...parsed,
      ...(inputCount === undefined ? {} : { inputCount }),
      ...(outputCount === undefined ? {} : { outputCount }),
    };
  });
}

function parseDiagnosticCounts(value: unknown): Record<string, number> {
  const record = parseRecord(value, 'diagnostics.counts');
  const counts: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    const count = finiteNumberField(item, `diagnostics.counts.${key}`);
    if (!Number.isInteger(count) || count < 0)
      fail('diagnostic counts must be non-negative integers');
    counts[key] = count;
  }
  return counts;
}

export function parsePipelineResult(value: unknown): PipelineResult {
  if (!isRecord(value)) fail('pipeline result must be an object');
  const identity = schemaAndIdentity(value);
  const pipeline = parseRecord(value.pipeline, 'pipeline');
  const diagnostics = parseRecord(value.diagnostics, 'diagnostics');
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    ...identity,
    pipeline: {
      id: stringField(pipeline.id, 'pipeline.id'),
      version: stringField(pipeline.version, 'pipeline.version'),
      configuration: parseRecord(pipeline.configuration, 'pipeline.configuration'),
      runtime: parseRecord(pipeline.runtime, 'pipeline.runtime'),
    },
    stages: parseStages(value.stages),
    elapsedMs: finiteNumberField(value.elapsedMs, 'elapsedMs'),
    measurements: parseMeasurements(value.measurements),
    diagnostics: {
      counts: parseDiagnosticCounts(diagnostics.counts),
      limitations: stringArrayField(diagnostics.limitations, 'diagnostics.limitations'),
    },
  };
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('invalid import-evaluation JSON artifact');
  }
}

export function readExpectedResults(path: string): ExpectedResults {
  return parseExpectedResults(readJsonFile(path));
}

export function readPipelineResult(path: string): PipelineResult {
  return parsePipelineResult(readJsonFile(path));
}

export function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writePrivateTextFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

export function securePrivateFile(path: string): void {
  chmodSync(path, 0o600);
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!pathExists(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('evaluation artifact path cannot be resolved');
    candidate = parent;
  }
  return candidate;
}

function isWithinRealPath(child: string, parent: string): boolean {
  const remainder = relative(parent, child);
  return remainder !== '' && !remainder.startsWith('..') && !isAbsolute(remainder);
}

/** Resolve an artifact through its nearest existing ancestor before it is read or written. */
export function assertPrivatePath(path: string, privateRoot: string): string {
  const absolute = resolve(path);
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(privateRoot));
  } catch {
    throw new Error('evaluation artifact resolves outside the private root');
  }
  const existing = pathExists(absolute) ? absolute : nearestExistingAncestor(absolute);
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new Error('evaluation artifact resolves outside the private root');
  }
  if (realExisting !== realRoot && !isWithinRealPath(realExisting, realRoot)) {
    throw new Error('evaluation artifact resolves outside the private root');
  }
  if (pathExists(absolute)) {
    let realArtifact: string;
    try {
      realArtifact = realpathSync(absolute);
    } catch {
      throw new Error('evaluation artifact resolves outside the private root');
    }
    if (realArtifact !== realRoot && !isWithinRealPath(realArtifact, realRoot)) {
      throw new Error('evaluation artifact resolves outside the private root');
    }
  }
  return absolute;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyReportAndGroundTruth(
  reportPath: string,
  expected: ExpectedResults,
  reportId: string,
): string {
  if (expected.reportId !== reportId) throw new Error('evaluation report identity mismatch');
  if (expected.review.status !== 'source-checked') {
    throw new Error('ground truth is not source-checked');
  }
  const actualHash = sha256File(reportPath);
  if (actualHash !== expected.reportSha256)
    throw new Error('report hash does not match ground truth');
  return actualHash;
}

export function assertPipelineIdentity(
  pipeline: PipelineResult,
  expected: ExpectedResults,
  reportSha256: string,
): void {
  if (
    pipeline.reportId !== expected.reportId ||
    pipeline.reportSha256 !== reportSha256 ||
    pipeline.pipeline.id.length === 0
  ) {
    throw new Error('pipeline result identity does not match evaluation input');
  }
}
