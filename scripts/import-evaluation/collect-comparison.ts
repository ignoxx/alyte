import { dirname, extname, resolve } from 'node:path';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  readJsonFile,
  writeJsonFile,
  writePrivateTextFile,
} from './contract';

export const COMPARISON_SCHEMA_VERSION = 'alyte.import-eval.comparison.v1' as const;
const SOURCE_SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
const SHA256 = /^[a-f0-9]{64}$/u;

const REQUIRED_COUNTS = [
  'expectedMeasurements',
  'producedMeasurements',
  'recoveredMeasurements',
  'matchedMeasurements',
  'exactSourceTupleMatches',
  'correctMeasurements',
  'missing',
  'spurious',
  'duplicates',
  'wrongAssociations',
] as const;

// Keep this allowlist aligned with score.ts. Aggregate inputs are untrusted and may contain
// provider-specific or health-bearing keys that must never be copied into the safe artifact.
const SCORER_FIELDS = [
  'sourceLabel',
  'valueString',
  'valueType',
  'parsedValue',
  'comparator',
  'unit',
  'referenceInterval',
  'flag',
  'collectionDate',
  'collectionGroup',
  'specimen',
  'page',
] as const;

const CORRECTION_BURDEN_FIELDS = [
  'changedFieldCount',
  'expectedAmbiguousFieldCount',
  'pipelineUnresolvedFieldCount',
  'unresolvedFieldCount',
  'unexpectedPopulatedFieldCount',
  'inventedAmbiguousFieldCount',
  'inventedAmbiguousCollectionDateCount',
] as const;

type RecordValue = Record<string, unknown>;
type CountName = (typeof REQUIRED_COUNTS)[number];

export type SafeComparisonRow = {
  readonly reportId: string;
  readonly reportSha256: string;
  readonly expectedMeasurements: number;
  readonly pipeline: { readonly id: string; readonly version: string };
  readonly counts: {
    readonly produced: number;
    readonly recoveredLabelValue: number;
    readonly unrecoveredLabelValue: number;
    readonly fullyCorrectCritical: number;
    readonly missing: number;
    readonly spurious: number;
    readonly duplicates: number;
    readonly wrongLabelValueAssociations: number;
    readonly wrongAssociationsTotal: number;
    readonly wrongOtherAssociationsLowerBound: number;
  };
  readonly associations: {
    readonly recoveredLabelValue: AssociationSummary;
    readonly fullyCorrectCritical: AssociationSummary;
  };
  readonly unresolvedFields: {
    readonly scoredTotal: number;
    readonly scoredByField: Readonly<Record<string, number>>;
    readonly pipelineProxyCount: number;
    readonly matchedProxyCount: number;
  };
  readonly correctionBurden: Readonly<Record<string, number>>;
  readonly timing: {
    readonly totalElapsedMs: number;
    readonly stages: readonly StageSummary[];
  };
  readonly diagnosticsTotal: number;
  readonly expectedSetKey?: string;
  readonly provenance?: Readonly<Record<string, unknown>>;
};

type AssociationSummary = {
  readonly correct: number;
  readonly incorrect: number;
  readonly unresolved: number;
  readonly denominator: number;
};

type StageSummary = {
  readonly stageIndex: number;
  readonly elapsedMs: number;
  readonly status: string;
};

export type ComparisonArtifact = {
  readonly schemaVersion: typeof COMPARISON_SCHEMA_VERSION;
  readonly sourceSchemaVersion: typeof SOURCE_SCHEMA_VERSION;
  readonly status: 'complete';
  readonly aggregateInputCount: number;
  readonly reportIdentities: readonly {
    readonly reportId: string;
    readonly reportSha256: string;
    readonly expectedMeasurements: number;
  }[];
  readonly pipelines: readonly SafeComparisonRow[];
};

function record(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid comparison aggregate: ${field}`);
  }
  return value as RecordValue;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`invalid comparison aggregate: ${field}`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid comparison aggregate: ${field}`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid comparison aggregate: ${field}`);
  }
  return value;
}

function association(value: unknown, field: string): AssociationSummary {
  const item = record(value, field);
  return {
    correct: nonNegativeInteger(item.correctCount, `${field}.correctCount`),
    incorrect: nonNegativeInteger(item.incorrectCount, `${field}.incorrectCount`),
    unresolved: nonNegativeInteger(item.unresolvedCount, `${field}.unresolvedCount`),
    denominator: nonNegativeInteger(item.denominator, `${field}.denominator`),
  };
}

function safeProvenance(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const source = record(value, 'provenance');
  const allowedKeys = new Set([
    'codeVersion',
    'configurationVersion',
    'configVersion',
    'sourceSha256',
    'sourceHash',
    'snapshotId',
    'adapterCommit',
    'runtimeVersion',
    'schemaVersion',
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof item !== 'string' || item.length === 0) continue;
    if (
      key.toLocaleLowerCase('en-US').includes('sha') ||
      key.toLocaleLowerCase('en-US').includes('hash')
    ) {
      if (!SHA256.test(item)) continue;
    }
    result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

type ParsedRow = SafeComparisonRow & { readonly expectedSetKey?: string };

function parseAggregate(value: unknown): ParsedRow {
  const input = record(value, 'root');
  if (input.schemaVersion !== SOURCE_SCHEMA_VERSION || input.status !== 'complete') {
    throw new Error('invalid comparison aggregate: schema or status');
  }
  const reportId = stringValue(input.reportId, 'reportId');
  const reportSha256 = stringValue(input.reportSha256, 'reportSha256');
  if (!SHA256.test(reportSha256)) throw new Error('invalid comparison aggregate: reportSha256');
  const pipelineInput = record(input.pipeline, 'pipeline');
  const pipeline = {
    id: stringValue(pipelineInput.id, 'pipeline.id'),
    version: stringValue(pipelineInput.version, 'pipeline.version'),
  } as const;
  const countsInput = record(input.counts, 'counts');
  const counts = Object.fromEntries(
    REQUIRED_COUNTS.map((name) => [name, nonNegativeInteger(countsInput[name], `counts.${name}`)]),
  ) as Record<CountName, number>;
  const critical = association(input.criticalAssociation, 'criticalAssociation');
  const labelValue = association(input.labelValueAssociation, 'labelValueAssociation');
  const fieldsInput = record(input.fieldScores, 'fieldScores');
  const scoredByField: Record<string, number> = {};
  for (const field of SCORER_FIELDS) {
    const item = fieldsInput[field];
    if (item === undefined) continue;
    const fieldScore = record(item, 'fieldScores');
    scoredByField[field] = nonNegativeInteger(fieldScore.unresolved, 'fieldScores.unresolved');
  }
  const burdenInput = record(input.correctionBurden, 'correctionBurden');
  const correctionBurden: Record<string, number> = {};
  for (const field of CORRECTION_BURDEN_FIELDS) {
    const item = burdenInput[field];
    if (item === undefined) continue;
    correctionBurden[field] = nonNegativeInteger(item, 'correctionBurden');
  }
  const stagesInput = input.stageTimings;
  if (!Array.isArray(stagesInput)) throw new Error('invalid comparison aggregate: stageTimings');
  const stages = stagesInput.map((item, index) => {
    const stage = record(item, `stageTimings.${index}`);
    return {
      stageIndex: nonNegativeInteger(stage.stageIndex, `stageTimings.${index}.stageIndex`),
      elapsedMs: finiteNumber(stage.elapsedMs, `stageTimings.${index}.elapsedMs`),
      status: stringValue(stage.status, `stageTimings.${index}.status`),
    };
  });
  const expectedMeasurements = counts.expectedMeasurements;
  const wrongOtherAssociationsLowerBound = Math.max(
    0,
    counts.wrongAssociations - labelValue.incorrect,
  );
  const provenance = safeProvenance(
    input.provenance ?? input.metadata ?? pipelineInput.provenance ?? pipelineInput.metadata,
  );
  return {
    reportId,
    reportSha256,
    expectedMeasurements,
    pipeline,
    counts: {
      produced: counts.producedMeasurements,
      recoveredLabelValue: labelValue.correct,
      unrecoveredLabelValue: Math.max(0, counts.expectedMeasurements - labelValue.correct),
      fullyCorrectCritical: critical.correct,
      missing: counts.missing,
      spurious: counts.spurious,
      duplicates: counts.duplicates,
      wrongLabelValueAssociations: labelValue.incorrect,
      wrongAssociationsTotal: counts.wrongAssociations,
      wrongOtherAssociationsLowerBound,
    },
    associations: {
      recoveredLabelValue: labelValue,
      fullyCorrectCritical: critical,
    },
    unresolvedFields: {
      scoredTotal: Object.values(scoredByField).reduce((sum, count) => sum + count, 0),
      scoredByField,
      pipelineProxyCount: correctionBurden.pipelineUnresolvedFieldCount ?? 0,
      matchedProxyCount: correctionBurden.unresolvedFieldCount ?? 0,
    },
    correctionBurden,
    timing: {
      totalElapsedMs: finiteNumber(input.elapsedMs, 'elapsedMs'),
      stages,
    },
    diagnosticsTotal: nonNegativeInteger(
      record(input.diagnostics, 'diagnostics').totalCount,
      'diagnostics.totalCount',
    ),
    ...(provenance === undefined ? {} : { provenance }),
    ...((typeof input.expectedSetId === 'string' && input.expectedSetId.length > 0) ||
    (typeof input.groundTruthSha256 === 'string' && SHA256.test(input.groundTruthSha256))
      ? { expectedSetKey: String(input.expectedSetId ?? input.groundTruthSha256) }
      : {}),
  };
}

function parseAggregateFile(value: unknown): ParsedRow[] {
  const input = record(value, 'root');
  if (!('pipelines' in input)) return [parseAggregate(value)];
  if (input.schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new Error('invalid comparison aggregate: schema');
  }
  const reportId = stringValue(input.reportId, 'reportId');
  const reportSha256 = stringValue(input.reportSha256, 'reportSha256');
  if (!SHA256.test(reportSha256)) throw new Error('invalid comparison aggregate: reportSha256');
  if (!Array.isArray(input.pipelines) || input.pipelines.length === 0) {
    throw new Error('invalid comparison aggregate: pipelines');
  }
  const expectedSetKey =
    typeof input.groundTruthSha256 === 'string' && SHA256.test(input.groundTruthSha256)
      ? input.groundTruthSha256
      : undefined;
  return input.pipelines.map((item, index) => {
    const row = parseAggregate(item);
    if (row.reportId !== reportId || row.reportSha256 !== reportSha256) {
      throw new Error(`comparison aggregate pipeline identity mismatch at index ${index}`);
    }
    if (
      expectedSetKey !== undefined &&
      row.expectedSetKey !== undefined &&
      row.expectedSetKey !== expectedSetKey
    ) {
      throw new Error('comparison aggregate expected set mismatch');
    }
    return expectedSetKey === undefined || row.expectedSetKey !== undefined
      ? row
      : { ...row, expectedSetKey };
  });
}

function validateCompatibility(rows: readonly ParsedRow[]): void {
  const byReport = new Map<string, ParsedRow>();
  const pipelineKeys = new Set<string>();
  for (const row of rows) {
    const existing = byReport.get(row.reportId);
    if (
      existing &&
      (existing.reportSha256 !== row.reportSha256 ||
        existing.expectedMeasurements !== row.expectedMeasurements)
    ) {
      throw new Error('comparison aggregates have incompatible report hashes or expected counts');
    }
    byReport.set(row.reportId, existing ?? row);
    const pipelineKey = `${row.reportId}\u0000${row.pipeline.id}\u0000${row.pipeline.version}`;
    if (pipelineKeys.has(pipelineKey))
      throw new Error('comparison aggregates contain a duplicate pipeline identity');
    pipelineKeys.add(pipelineKey);
  }
  const expectedSetByReport = new Map<string, string | undefined>();
  for (const row of rows) {
    if (!expectedSetByReport.has(row.reportId)) {
      expectedSetByReport.set(row.reportId, row.expectedSetKey);
      continue;
    }
    if (expectedSetByReport.get(row.reportId) !== row.expectedSetKey) {
      throw new Error('comparison aggregates have incompatible expected sets');
    }
  }
}

export function collectComparison(values: readonly unknown[]): ComparisonArtifact {
  if (values.length === 0) throw new Error('at least one aggregate input is required');
  const parsed = values.flatMap(parseAggregateFile);
  validateCompatibility(parsed);
  const rows = [...parsed].sort((left, right) =>
    `${left.reportId}\u0000${left.pipeline.id}\u0000${left.pipeline.version}`.localeCompare(
      `${right.reportId}\u0000${right.pipeline.id}\u0000${right.pipeline.version}`,
    ),
  );
  const reportIdentities = [...new Map(rows.map((row) => [row.reportId, row])).values()]
    .sort((left, right) => left.reportId.localeCompare(right.reportId))
    .map((row) => ({
      reportId: row.reportId,
      reportSha256: row.reportSha256,
      expectedMeasurements: row.expectedMeasurements,
    }));
  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    status: 'complete',
    aggregateInputCount: values.length,
    reportIdentities,
    pipelines: rows,
  };
}

function markdownValue(value: string | number): string {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderComparisonMarkdown(comparison: ComparisonArtifact): string {
  const lines = [
    '# Import evaluation comparison',
    '',
    'This comparison is assembled from safe aggregate counts. Detailed matches, source text, and model outputs remain in their private original artifacts.',
    '',
    `Inputs: ${comparison.aggregateInputCount} aggregate files; ${comparison.reportIdentities.length} report identities.`,
    '',
    '## Report identities',
    '',
    '| Report | Report SHA-256 | Expected |',
    '| --- | --- | ---: |',
    ...comparison.reportIdentities.map(
      (report) =>
        `| ${markdownValue(report.reportId)} | ${report.reportSha256} | ${report.expectedMeasurements} |`,
    ),
    '',
    '## Results',
    '',
    '| Report | Pipeline | Version | Expected | Produced | Recovered label/value | Unrecovered label/value | Fully correct critical | Missing | Spurious | Duplicates | Wrong label/value | Wrong associations | Other lower bound | Unresolved field proxy | Time (ms) |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...comparison.pipelines.map((row) => {
      const c = row.counts;
      return `| ${markdownValue(row.reportId)} | ${markdownValue(row.pipeline.id)} | ${markdownValue(row.pipeline.version)} | ${row.expectedMeasurements} | ${c.produced} | ${c.recoveredLabelValue} | ${c.unrecoveredLabelValue} | ${c.fullyCorrectCritical}/${row.associations.fullyCorrectCritical.denominator} | ${c.missing} | ${c.spurious} | ${c.duplicates} | ${c.wrongLabelValueAssociations} | ${c.wrongAssociationsTotal} | ${c.wrongOtherAssociationsLowerBound} | ${row.unresolvedFields.pipelineProxyCount}/${row.unresolvedFields.matchedProxyCount} | ${row.timing.totalElapsedMs} |`;
    }),
    '',
    'Fully correct critical is the strict critical-row count over the scorer’s matched critical denominator; it does not mean every expected row was produced. Other lower bound is the residual after subtracting wrong label/value associations from total wrong associations; scorer counters can overlap.',
    '',
    '## Stage timings',
    '',
    '| Report | Pipeline | Stage | Time (ms) | Status |',
    '| --- | --- | --- | ---: | --- |',
    ...comparison.pipelines.flatMap((row) =>
      row.timing.stages.map(
        (stage) =>
          `| ${markdownValue(row.reportId)} | ${markdownValue(row.pipeline.id)} | ${stage.stageIndex} | ${stage.elapsedMs} | ${markdownValue(stage.status)} |`,
      ),
    ),
    '',
    'Field unresolved counts and correction-burden values are scorer proxies; they do not represent user time.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function argumentValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing ${name}`);
    values.push(value);
  }
  return values;
}

function argumentValue(name: string): string | undefined {
  const values = argumentValues(name);
  if (values.length > 1) throw new Error(`duplicate ${name}`);
  return values[0];
}

function runCli(): void {
  const inputs = argumentValues('--input');
  const privateRoot = argumentValue('--private-root');
  const output = argumentValue('--output');
  const markdownOutput = argumentValue('--markdown-output');
  if (!privateRoot || !output || inputs.length === 0) {
    throw new Error('--private-root, --input (at least once), and --output are required');
  }
  const root = resolve(privateRoot);
  ensurePrivateDirectory(root);
  const inputPaths = inputs.map((path) => assertPrivatePath(path, root));
  const outputPath = assertPrivatePath(output, root);
  const markdownDefault =
    extname(output) === '.json' ? output.slice(0, -'.json'.length) + '.md' : `${output}.md`;
  const markdownPath = assertPrivatePath(markdownOutput ?? markdownDefault, root);
  const values = inputPaths.map((path) => readJsonFile(path));
  const comparison = collectComparison(values);
  ensurePrivateDirectory(dirname(outputPath));
  ensurePrivateDirectory(dirname(markdownPath));
  writeJsonFile(outputPath, comparison);
  writePrivateTextFile(markdownPath, renderComparisonMarkdown(comparison));
  process.stdout.write(
    JSON.stringify({
      reports: comparison.reportIdentities.length,
      pipelines: comparison.pipelines.length,
    }) + '\n',
  );
}

if (process.argv[1]?.endsWith('/collect-comparison.ts') === true) {
  try {
    runCli();
  } catch {
    process.exitCode = 1;
  }
}
