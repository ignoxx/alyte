import { existsSync, realpathSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMPORT_EVALUATION_SCHEMA_VERSION,
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  readExpectedResults,
  readJsonFile,
  securePrivateFile,
  sha256File,
  verifyReportAndGroundTruth,
  writePrivateTextFile,
  writeJsonFile,
  type PipelineResult,
} from './contract';
import {
  renderAggregateMarkdown,
  scoreEvaluation,
  toSafeAggregate,
  type SafeAggregate,
} from './score';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PRIVATE_ROOT = resolve(REPOSITORY_ROOT, '.scratch/import-evaluation');
const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,80}$/u;

type Adapter = {
  readonly id: string;
  readonly path: string;
};

type FailureSummary = {
  readonly pipelineId: string;
  readonly category: 'adapter-failed' | 'invalid-result' | 'score-failed';
};

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function validateComponent(value: string, field: string): void {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`${field} is unsafe`);
}

function repeatedArgument(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function parseAdapters(args: readonly string[]): readonly Adapter[] {
  const values = repeatedArgument(args, '--adapter');
  const adapters = values.map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('--adapter values must use id=path');
    }
    return { id: value.slice(0, separator), path: value.slice(separator + 1) };
  });
  const named = [
    ['alyte', optionalArgument(args, '--alyte-adapter')],
    ['vitametr', optionalArgument(args, '--vitametr-adapter')],
  ] as const;
  for (const [id, path] of named) {
    if (path !== undefined) adapters.push({ id, path });
  }
  if (adapters.length > 0) return adapters;

  const discovered: Adapter[] = [];
  for (const id of ['alyte', 'vitametr']) {
    for (const extension of ['.ts', '.mjs', '.js']) {
      const candidate = resolve(REPOSITORY_ROOT, `scripts/import-evaluation/${id}${extension}`);
      if (existsSync(candidate)) {
        discovered.push({ id, path: candidate });
        break;
      }
    }
  }
  if (discovered.length === 0) {
    throw new Error('at least one adapter is required; use --adapter id=path');
  }
  return discovered;
}

function resolveAdapterPath(adapterPath: string): string {
  const candidate = resolve(REPOSITORY_ROOT, adapterPath);
  if (!existsSync(candidate)) throw new Error('adapter path does not exist');
  return candidate;
}

function adapterInvocation(adapterPath: string): {
  readonly command: string;
  readonly prefix: readonly string[];
} {
  if (adapterPath.endsWith('.ts') || adapterPath.endsWith('.tsx')) {
    return { command: process.execPath, prefix: ['--import', 'tsx', adapterPath] };
  }
  if (adapterPath.endsWith('.mjs') || adapterPath.endsWith('.js')) {
    return { command: process.execPath, prefix: [adapterPath] };
  }
  return { command: adapterPath, prefix: [] };
}

function failurePipeline(
  adapter: Adapter,
  reportId: string,
  reportSha256: string,
  elapsedMs: number,
  category: 'adapter-failed' | 'invalid-result',
): PipelineResult {
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId,
    reportSha256,
    pipeline: {
      id: adapter.id,
      version: 'runner-failure',
      configuration: {},
      runtime: { node: process.version },
    },
    stages: [{ name: 'adapter', elapsedMs, status: 'failed' }],
    elapsedMs,
    measurements: [],
    diagnostics: {
      counts: { [category]: 1 },
      limitations: ['adapter did not produce a valid result'],
    },
  };
}

function runAdapter(
  adapter: Adapter,
  reportPath: string,
  reportId: string,
  reportSha256: string,
  outputPath: string,
  privateRoot: string,
): { readonly pipeline: PipelineResult; readonly failed: boolean } {
  assertPrivatePath(outputPath, privateRoot);
  ensurePrivateDirectory(dirname(outputPath));
  assertPrivatePath(outputPath, privateRoot);
  if (existsSync(outputPath)) unlinkSync(outputPath);
  const started = performance.now();
  const resolvedPath = resolveAdapterPath(adapter.path);
  const invocation = adapterInvocation(resolvedPath);
  const result = spawnSync(
    invocation.command,
    [...invocation.prefix, '--report', reportPath, '--report-id', reportId, '--output', outputPath],
    {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
      env: { ...process.env, ALYTE_IMPORT_EVALUATION: '1' },
    },
  );
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  if (result.error || result.status !== 0 || !existsSync(outputPath)) {
    return {
      pipeline: failurePipeline(adapter, reportId, reportSha256, elapsedMs, 'adapter-failed'),
      failed: true,
    };
  }
  try {
    assertPrivatePath(outputPath, privateRoot);
    securePrivateFile(outputPath);
    const pipeline = parsePipelineResult(readJsonFile(outputPath));
    return { pipeline, failed: false };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('private root') || error.message.includes('outside the private root'))
    ) {
      throw error;
    }
    return {
      pipeline: failurePipeline(adapter, reportId, reportSha256, elapsedMs, 'invalid-result'),
      failed: true,
    };
  }
}

function aggregateDocument(
  reportId: string,
  reportSha256: string,
  groundTruthSha256: string,
  aggregates: readonly SafeAggregate[],
  failures: readonly FailureSummary[],
): Record<string, unknown> {
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId,
    reportSha256,
    groundTruthSha256,
    pipelines: aggregates,
    failureCount: failures.length,
  };
}

export function runEvaluation(options: {
  readonly reportPath: string;
  readonly reportId: string;
  readonly expectedPath: string;
  readonly privateRoot: string;
  readonly adapters: readonly Adapter[];
  readonly runId?: string;
}): {
  readonly aggregates: readonly SafeAggregate[];
  readonly failures: readonly FailureSummary[];
  readonly groundTruthSha256: string;
} {
  validateComponent(options.reportId, 'report id');
  for (const adapter of options.adapters) validateComponent(adapter.id, 'adapter id');
  if (options.runId !== undefined) validateComponent(options.runId, 'run id');
  ensurePrivateDirectory(options.privateRoot);
  const privateRoot = realpathSync(options.privateRoot);
  const reportPath = assertPrivatePath(options.reportPath, privateRoot);
  const expectedPath = assertPrivatePath(options.expectedPath, privateRoot);
  ensurePrivateDirectory(dirname(reportPath));
  ensurePrivateDirectory(dirname(expectedPath));
  securePrivateFile(reportPath);
  securePrivateFile(expectedPath);
  const expected = readExpectedResults(expectedPath);
  const reportSha256 = verifyReportAndGroundTruth(reportPath, expected, options.reportId);
  const groundTruthSha256 = sha256File(expectedPath);
  const aggregates: SafeAggregate[] = [];
  const failures: FailureSummary[] = [];
  for (const adapter of options.adapters) {
    const runDirectory =
      options.runId === undefined
        ? resolve(privateRoot, 'runs')
        : resolve(privateRoot, 'runs', options.runId);
    const pipelinePath = resolve(runDirectory, adapter.id, `${options.reportId}.json`);
    const detailedPath = resolve(runDirectory, adapter.id, `${options.reportId}.score.json`);
    const aggregatePath = resolve(runDirectory, adapter.id, `${options.reportId}.aggregate.json`);
    if (
      options.runId !== undefined &&
      [pipelinePath, detailedPath, aggregatePath].some((path) => existsSync(path))
    ) {
      throw new Error('run id already exists');
    }
    assertPrivatePath(pipelinePath, privateRoot);
    assertPrivatePath(detailedPath, privateRoot);
    assertPrivatePath(aggregatePath, privateRoot);
    ensurePrivateDirectory(dirname(pipelinePath));
    const run = runAdapter(
      adapter,
      reportPath,
      options.reportId,
      reportSha256,
      pipelinePath,
      privateRoot,
    );
    if (run.failed) failures.push({ pipelineId: adapter.id, category: 'adapter-failed' });
    try {
      const detailed = scoreEvaluation(expected, run.pipeline);
      const aggregate = toSafeAggregate(detailed);
      ensurePrivateDirectory(dirname(detailedPath));
      assertPrivatePath(detailedPath, privateRoot);
      assertPrivatePath(aggregatePath, privateRoot);
      writeJsonFile(detailedPath, detailed);
      writeJsonFile(aggregatePath, aggregate);
      aggregates.push(aggregate);
    } catch {
      failures.push({ pipelineId: adapter.id, category: 'score-failed' });
    }
  }
  const aggregateDirectory =
    options.runId === undefined
      ? resolve(privateRoot, 'aggregate')
      : resolve(privateRoot, 'aggregate', options.runId);
  const aggregateJsonPath = assertPrivatePath(
    resolve(aggregateDirectory, `${options.reportId}.json`),
    privateRoot,
  );
  ensurePrivateDirectory(aggregateDirectory);
  writeJsonFile(
    aggregateJsonPath,
    aggregateDocument(options.reportId, reportSha256, groundTruthSha256, aggregates, failures),
  );
  const markdownPath = assertPrivatePath(
    resolve(aggregateDirectory, `${options.reportId}.md`),
    privateRoot,
  );
  writePrivateTextFile(markdownPath, renderAggregateMarkdown(aggregates));
  return { aggregates, failures, groundTruthSha256 };
}

function main(): void {
  const args = process.argv.slice(2);
  const explicitReportIds = repeatedArgument(args, '--report-id');
  const reportList =
    optionalArgument(args, '--reports')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const reportIds = [...new Set([...explicitReportIds, ...reportList])];
  if (reportIds.length === 0) throw new Error('--report-id or --reports is required');
  for (const reportId of reportIds) validateComponent(reportId, 'report id');
  const privateRoot = resolve(optionalArgument(args, '--root') ?? DEFAULT_PRIVATE_ROOT);
  const adapters = parseAdapters(args).map((adapter) => ({
    ...adapter,
    path: resolveAdapterPath(adapter.path),
  }));
  const explicitReportPath = optionalArgument(args, '--report');
  const explicitExpectedPath = optionalArgument(args, '--expected');
  if (
    reportIds.length > 1 &&
    (explicitReportPath !== undefined || explicitExpectedPath !== undefined)
  ) {
    throw new Error(
      '--report and --expected are only supported for one report; use --root for a report set',
    );
  }
  const runId = optionalArgument(args, '--run-id');
  if (runId !== undefined) validateComponent(runId, 'run id');
  const allAggregates: SafeAggregate[] = [];
  const failures: FailureSummary[] = [];
  const groundTruthSha256: Record<string, string> = {};
  for (const reportId of reportIds) {
    const reportPath = resolve(
      explicitReportPath ?? resolve(privateRoot, 'reports', `${reportId}.pdf`),
    );
    const expectedPath = resolve(
      explicitExpectedPath ?? resolve(privateRoot, 'ground-truth', `${reportId}.json`),
    );
    const result = runEvaluation({
      reportPath,
      reportId,
      expectedPath,
      privateRoot,
      adapters,
      ...(runId === undefined ? {} : { runId }),
    });
    allAggregates.push(...result.aggregates);
    failures.push(...result.failures);
    groundTruthSha256[reportId] = result.groundTruthSha256;
  }
  const aggregateDirectory =
    runId === undefined
      ? resolve(privateRoot, 'aggregate')
      : resolve(privateRoot, 'aggregate', runId);
  const comparisonJsonPath = assertPrivatePath(
    resolve(aggregateDirectory, 'comparison.json'),
    privateRoot,
  );
  const comparisonMarkdownPath = assertPrivatePath(
    resolve(aggregateDirectory, 'comparison.md'),
    privateRoot,
  );
  ensurePrivateDirectory(aggregateDirectory);
  writeJsonFile(comparisonJsonPath, {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    groundTruthSha256,
    pipelines: allAggregates,
    failureCount: failures.length,
  });
  writePrivateTextFile(comparisonMarkdownPath, renderAggregateMarkdown(allAggregates));
  process.stdout.write(
    `${JSON.stringify({ reportCount: reportIds.length, pipelineCount: allAggregates.length, failureCount: failures.length })}\n`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('/run.ts') === true) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'import evaluation failed');
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}
