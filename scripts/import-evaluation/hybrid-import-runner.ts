import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
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
  writeJsonFile,
  writePrivateTextFile,
  type EvaluationMeasurement,
  type PipelineResult,
} from './contract';
import {
  renderAggregateMarkdown,
  scoreEvaluation,
  toSafeAggregate,
  type SafeAggregate,
} from './score';
import { validatePreflightPaths, type PreflightPaths } from './evaluation-preflight';
import { runRoutedHeaderTable, type HeaderTableRoute } from './header-table-router';
import {
  POPPLER_LAYOUT_READER_VERSION,
  readPopplerLayout,
  writePopplerBinding,
} from './alyte-poppler-layout-reader';
import * as rawSnapshotBinding from './raw-snapshot-binding';
import {
  buildHybridRetryPlan,
  deduplicateExactRows,
  type HybridRetryPlan,
} from './hybrid-band-retry';
import { PADDLE_ADAPTER_ARGUMENTS, PADDLE_OCR_VL_SEAM_VERSION } from './paddle-ocr-vl-seam';

export const HYBRID_PIPELINE_ID = 'alyte-hybrid-import' as const;
export const HYBRID_PIPELINE_VERSION = 'mac-hybrid-poppler-header-table-paddle-ocr-vl.v1' as const;

const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,80}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_RUN_ID = 'hybrid';

type HybridPaths = {
  readonly privateRoot: string;
  readonly report: string;
  readonly expected: string;
  readonly snapshot: string;
  readonly binding: string;
  readonly runDirectory: string;
  readonly output: string;
  readonly fastOutput: string;
  readonly paddleOutput: string;
  readonly retryOutput: string;
  readonly routeOutput: string;
  readonly scoreOutput: string;
  readonly aggregateOutput: string;
  readonly markdownOutput: string;
};

export type HybridRunnerOptions = {
  readonly reportPath: string;
  readonly reportId: string;
  readonly expectedPath: string;
  readonly privateRoot: string;
  readonly rawSnapshotPath?: string;
  readonly bindingPath?: string;
  readonly bindingModulePath?: string;
  readonly paddleAdapterPath?: string;
  readonly paddleModelPath?: string;
  readonly paddleProjectorPath?: string;
  readonly paddleRuntimePath?: string;
  readonly runId?: string;
  readonly denseObservationThreshold?: number;
  readonly bandHeight?: number;
  readonly overlap?: number;
};

export type HybridRunResult = {
  readonly pipeline: PipelineResult;
  readonly aggregate: SafeAggregate;
  readonly routes: readonly HeaderTableRoute[];
  readonly initialPlan: HybridRetryPlan;
  readonly retryPlan: HybridRetryPlan | null;
  readonly paths: HybridPaths;
};

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = argument(args, name);
  if (value === undefined) throw new Error(`hybrid-${name.slice(2)}-missing`);
  return value;
}

function component(value: string, field: string): string {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`hybrid-${field}-invalid`);
  return value;
}

function defaultBindingPath(snapshotPath: string): string {
  return snapshotPath.endsWith('.json')
    ? snapshotPath.replace(/\.json$/u, '.binding.json')
    : `${snapshotPath}.binding.json`;
}

function defaultPaths(options: HybridRunnerOptions): HybridPaths {
  const privateRoot = resolve(options.privateRoot);
  const runId = component(options.runId ?? DEFAULT_RUN_ID, 'run-id');
  const runDirectory = resolve(privateRoot, 'runs', runId);
  const report = resolve(options.reportPath);
  const expected = resolve(options.expectedPath);
  const snapshot = resolve(
    options.rawSnapshotPath ?? join(privateRoot, 'raw', `${options.reportId}.poppler-layout.json`),
  );
  const binding = resolve(options.bindingPath ?? defaultBindingPath(snapshot));
  return {
    privateRoot,
    report,
    expected,
    snapshot,
    binding,
    runDirectory,
    output: join(runDirectory, `${options.reportId}.json`),
    fastOutput: join(runDirectory, `${options.reportId}.header-table.json`),
    paddleOutput: join(runDirectory, `${options.reportId}.paddle.json`),
    retryOutput: join(runDirectory, `${options.reportId}.paddle-retry.json`),
    routeOutput: join(runDirectory, `${options.reportId}.route-plan.json`),
    scoreOutput: join(runDirectory, `${options.reportId}.score.json`),
    aggregateOutput: join(runDirectory, `${options.reportId}.aggregate.json`),
    markdownOutput: join(runDirectory, `${options.reportId}.aggregate.md`),
  };
}

function existingFile(path: string, error: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new Error(error);
  } catch (cause) {
    if (cause instanceof Error && cause.message === error) throw cause;
    throw new Error(error);
  }
}

function artifactHash(path: string | null, field: string): string | null {
  if (path === null) return null;
  existingFile(path, `hybrid-${field}-missing`);
  const hash = sha256File(path);
  if (!SHA256.test(hash)) throw new Error(`hybrid-${field}-hash-invalid`);
  return hash;
}

function ensureBoundPopplerSnapshot(paths: HybridPaths, runtimeVersion: string): void {
  // Check containment before inspecting or chmod-ing a caller-supplied snapshot. A stale
  // snapshot or binding may be a symlink outside the private root.
  assertPrivatePath(paths.snapshot, paths.privateRoot);
  assertPrivatePath(paths.binding, paths.privateRoot);
  const snapshotExists = existsSync(paths.snapshot);
  const bindingExists = existsSync(paths.binding);
  if (snapshotExists !== bindingExists) throw new Error('hybrid-poppler-binding-missing');
  if (snapshotExists) {
    existingFile(paths.snapshot, 'hybrid-poppler-snapshot-missing');
    existingFile(paths.binding, 'hybrid-poppler-binding-missing');
    securePrivateFile(paths.snapshot);
    securePrivateFile(paths.binding);
    return;
  }
  ensurePrivateDirectory(dirname(paths.snapshot));
  const read = readPopplerLayout({
    reportPath: paths.report,
    outputPath: paths.snapshot,
    privateRoot: paths.privateRoot,
    runtimeVersion,
  });
  ensurePrivateDirectory(dirname(paths.binding));
  writePopplerBinding({
    rawText: read.rawText,
    identity: read.identity,
    outputPath: paths.binding,
    bindingModule: rawSnapshotBinding,
  });
  securePrivateFile(paths.snapshot);
  securePrivateFile(paths.binding);
}

function preflightPaths(paths: HybridPaths): PreflightPaths {
  return {
    privateRoot: paths.privateRoot,
    report: paths.report,
    reportId: basename(paths.report, extname(paths.report)),
    expected: paths.expected,
    // The existing preflight names this input `vision`; the hybrid runner binds the Poppler
    // snapshot through the same private-input and report-hash checks.
    vision: paths.snapshot,
    binding: paths.binding,
    output: paths.output,
    rawOutput: paths.fastOutput,
    groundedOutput: paths.paddleOutput,
    excludedOutput: paths.retryOutput,
    modelProposalsOutput: paths.routeOutput,
    metadataOutput: join(paths.runDirectory, 'metadata.json'),
    scoreOutput: paths.scoreOutput,
    aggregateOutput: paths.aggregateOutput,
    runnerLog: join(paths.runDirectory, 'runner.log'),
    groundingLog: join(paths.runDirectory, 'paddle.log'),
    scoreLog: join(paths.runDirectory, 'score.log'),
  };
}

function adapterInvocation(path: string): {
  readonly command: string;
  readonly prefix: readonly string[];
} {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) {
    return { command: process.execPath, prefix: ['--import', 'tsx', path] };
  }
  if (path.endsWith('.mjs') || path.endsWith('.js')) {
    return { command: process.execPath, prefix: [path] };
  }
  return { command: path, prefix: [] };
}

function safeAdapterPath(path: string): string {
  const resolved = resolve(path);
  existingFile(resolved, 'hybrid-paddle-adapter-missing');
  return resolved;
}

function paddleArgs(options: {
  readonly report: string;
  readonly reportId: string;
  readonly privateRoot: string;
  readonly output: string;
  readonly planPath: string;
  readonly retry: boolean;
  readonly model: string | null;
  readonly projector: string | null;
  readonly runtime: string | null;
}): readonly string[] {
  const args = [
    PADDLE_ADAPTER_ARGUMENTS[0],
    options.report,
    PADDLE_ADAPTER_ARGUMENTS[1],
    options.reportId,
    PADDLE_ADAPTER_ARGUMENTS[2],
    options.privateRoot,
    PADDLE_ADAPTER_ARGUMENTS[3],
    options.output,
    PADDLE_ADAPTER_ARGUMENTS[4],
    options.planPath,
    PADDLE_ADAPTER_ARGUMENTS[5],
    PADDLE_OCR_VL_SEAM_VERSION,
    PADDLE_ADAPTER_ARGUMENTS[6],
    options.retry ? '1' : '0',
  ];
  if (options.model !== null) args.push('--model', options.model);
  if (options.projector !== null) args.push('--projector', options.projector);
  if (options.runtime !== null) args.push('--runtime', options.runtime);
  return args;
}

function runPaddleAdapter(options: {
  readonly adapterPath: string;
  readonly report: string;
  readonly reportId: string;
  readonly privateRoot: string;
  readonly output: string;
  readonly planPath: string;
  readonly retry: boolean;
  readonly model: string | null;
  readonly projector: string | null;
  readonly runtime: string | null;
  readonly expectedReportSha256: string;
}): { readonly pipeline: PipelineResult; readonly elapsedMs: number } {
  const invocation = adapterInvocation(options.adapterPath);
  const started = performance.now();
  const child = spawnSync(
    invocation.command,
    [
      ...invocation.prefix,
      ...paddleArgs({
        report: options.report,
        reportId: options.reportId,
        privateRoot: options.privateRoot,
        output: options.output,
        planPath: options.planPath,
        retry: options.retry,
        model: options.model,
        projector: options.projector,
        runtime: options.runtime,
      }),
    ],
    {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      stdio: 'ignore',
      env: {
        ...process.env,
        ALYTE_IMPORT_EVALUATION: '1',
        ALYTE_HYBRID_IMPORT: '1',
        ALYTE_PRIVATE_ROOT: options.privateRoot,
      },
    },
  );
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  if (child.error || child.status !== 0 || !existsSync(options.output)) {
    throw new Error('hybrid-paddle-adapter-failed');
  }
  assertPrivatePath(options.output, options.privateRoot);
  securePrivateFile(options.output);
  const pipeline = parsePipelineResult(readJsonFile(options.output));
  if (
    pipeline.reportId !== options.reportId ||
    pipeline.reportSha256 !== options.expectedReportSha256
  ) {
    throw new Error('hybrid-paddle-result-identity-mismatch');
  }
  return { pipeline, elapsedMs };
}

function finitePageIndexes(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is number => Number.isSafeInteger(item) && item >= 0)),
  ].toSorted((left, right) => left - right);
}

function requestedRetryPages(
  pipeline: PipelineResult,
  fallbackMeasurements: readonly EvaluationMeasurement[],
  deferredPages: readonly number[],
): readonly number[] {
  const deferred = new Set(deferredPages);
  const configuration = pipeline.pipeline.configuration;
  const configured = finitePageIndexes(
    configuration.repetitionDetectedPageIndexes ?? configuration.retryPageIndexes,
  );
  const diagnosticRepetitions = Object.entries(pipeline.diagnostics.counts).some(
    ([key, value]) => /repetition/iu.test(key) && Number.isSafeInteger(value) && value > 0,
  );
  const duplicatePages = deduplicateExactRows(fallbackMeasurements).duplicatePageIndexes;
  const selected =
    configured.length > 0 ? configured : diagnosticRepetitions ? deferredPages : duplicatePages;
  return [...new Set(selected.filter((page) => deferred.has(page)))].toSorted(
    (left, right) => left - right,
  );
}

function pageTimings(value: unknown): readonly {
  readonly pageIndex: number;
  readonly elapsedMs: number | null;
  readonly status: string;
  readonly attempts: number;
}[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const pageIndex = record.pageIndex;
    const elapsedMs = record.elapsedMs;
    const status = record.status;
    const attempts = record.attempts;
    if (
      typeof pageIndex !== 'number' ||
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      typeof elapsedMs !== 'number' ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      typeof status !== 'string' ||
      !SAFE_COMPONENT.test(status)
    )
      return [];
    return [
      {
        pageIndex,
        elapsedMs,
        status,
        attempts:
          Number.isSafeInteger(attempts) && (attempts as number) > 0 ? (attempts as number) : 1,
      },
    ];
  });
}

function completePageTimings(
  reported: ReturnType<typeof pageTimings>,
  pageIndexes: readonly number[],
): ReturnType<typeof pageTimings> {
  const byPage = new Map(reported.map((item) => [item.pageIndex, item]));
  return pageIndexes.map(
    (pageIndex) =>
      byPage.get(pageIndex) ?? {
        pageIndex,
        elapsedMs: null,
        status: 'adapter-unreported',
        attempts: 1,
      },
  );
}

function scopedFallbackMeasurements(
  measurements: readonly EvaluationMeasurement[],
  deferredPages: ReadonlySet<number>,
): { readonly measurements: readonly EvaluationMeasurement[]; readonly rejected: number } {
  const accepted: EvaluationMeasurement[] = [];
  let rejected = 0;
  for (const measurement of measurements) {
    // A null page cannot prove that the Paddle candidate came from a deferred page, so it is
    // retained only in the adapter artifact and excluded from the hybrid result.
    if (measurement.page === null || !deferredPages.has(measurement.page - 1)) {
      rejected += 1;
      continue;
    }
    accepted.push(measurement);
  }
  return { measurements: accepted, rejected };
}

function routeMaps(routes: readonly HeaderTableRoute[]): {
  readonly reasons: Readonly<Record<number, string>>;
  readonly observations: Readonly<Record<number, number>>;
} {
  const reasons: Record<number, string> = {};
  const observations: Record<number, number> = {};
  for (const route of routes) {
    reasons[route.pageIndex] = route.reason;
    observations[route.pageIndex] = route.observationCount;
  }
  return { reasons, observations };
}

function fallbackConfigurationHash(
  pipelines: readonly PipelineResult[],
  field: 'modelSha256' | 'projectorSha256' | 'runtimeSha256',
): string | null {
  const configured = pipelines
    .map((pipeline) => pipeline.pipeline.configuration[field])
    .find((value): value is string => typeof value === 'string' && SHA256.test(value));
  return configured ?? null;
}

function mergePipeline(options: {
  readonly reportId: string;
  readonly reportSha256: string;
  readonly fast: PipelineResult;
  readonly fallback: readonly PipelineResult[];
  readonly routes: readonly HeaderTableRoute[];
  readonly initialPlan: HybridRetryPlan;
  readonly retryPlan: HybridRetryPlan | null;
  readonly modelSha256: string | null;
  readonly projectorSha256: string | null;
  readonly runtimeSha256: string | null;
  readonly adapterSha256: string | null;
  readonly fallbackElapsedMs: number;
  readonly retryElapsedMs: number;
  readonly fallbackRejectedRows: number;
  readonly replacedPageIndexes: readonly number[];
  readonly fallbackPageTimings: readonly {
    readonly pageIndex: number;
    readonly elapsedMs: number | null;
    readonly status: string;
    readonly attempts: number;
  }[];
}): PipelineResult {
  const deferredIndexes = options.routes
    .filter((route) => route.kind === 'unstructured-or-image')
    .map((route) => route.pageIndex);
  const deferred = new Set(deferredIndexes);
  const fastPages = new Set(
    options.routes
      .filter((route) => route.kind === 'structured-text-table')
      .map((route) => route.pageIndex),
  );
  const allFallback = options.fallback.flatMap((pipeline) =>
    scopedFallbackMeasurements(pipeline.measurements, deferred),
  );
  const fallbackRows = allFallback.flatMap((item) => item.measurements);
  const deduplicated = deduplicateExactRows(fallbackRows);
  const modelSha256 =
    options.modelSha256 ?? fallbackConfigurationHash(options.fallback, 'modelSha256');
  const projectorSha256 =
    options.projectorSha256 ?? fallbackConfigurationHash(options.fallback, 'projectorSha256');
  const runtimeSha256 =
    options.runtimeSha256 ?? fallbackConfigurationHash(options.fallback, 'runtimeSha256');
  const seenIds = new Set(options.fast.measurements.map((measurement) => measurement.id));
  const fallbackUniqueIds = deduplicated.measurements.filter((measurement) => {
    if (seenIds.has(measurement.id)) return false;
    seenIds.add(measurement.id);
    return true;
  });
  const routeReasonCounts = options.routes.reduce<Record<string, number>>((counts, route) => {
    counts[route.reason] = (counts[route.reason] ?? 0) + 1;
    return counts;
  }, {});
  const modelConfiguration = {
    seamVersion: PADDLE_OCR_VL_SEAM_VERSION,
    adapterSha256: options.adapterSha256,
    modelSha256,
    projectorSha256,
    runtimeSha256,
    fallbackPageIndexes: deferredIndexes,
    fastPageIndexes: [...fastPages].toSorted((left, right) => left - right),
    routeReasonCounts,
    initialRetryPlan: options.initialPlan,
    retryPlan: options.retryPlan,
    replacedPageIndexes: options.replacedPageIndexes,
    pageTimings: options.fallbackPageTimings,
    timingScope: 'runner-stage-and-adapter-reported-page-timings',
  };
  const fallbackDiagnostics = options.fallback.reduce<Record<string, number>>(
    (counts, pipeline) => {
      for (const [key, value] of Object.entries(pipeline.diagnostics.counts)) {
        if (Number.isSafeInteger(value) && value >= 0) {
          const safeKey = `paddle${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          counts[safeKey] = (counts[safeKey] ?? 0) + value;
        }
      }
      return counts;
    },
    {},
  );
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: options.reportId,
    reportSha256: options.reportSha256,
    pipeline: {
      id: HYBRID_PIPELINE_ID,
      version: HYBRID_PIPELINE_VERSION,
      configuration: {
        router: 'alyte.header-table-router.v1',
        headerTable: 'native-parent-cell-owned-columns.v3',
        popplerReader: POPPLER_LAYOUT_READER_VERSION,
        routePolicy: 'bound-selectable-text-fast-path-deferred-pages-to-paddle',
        model: modelConfiguration,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        reader: 'bound-poppler-layout-snapshot',
      },
    },
    stages: [
      ...options.fast.stages,
      {
        name: 'paddle-ocr-vl-fallback',
        elapsedMs: options.fallbackElapsedMs,
        inputCount: deferredIndexes.length,
        outputCount: fallbackRows.length,
        status: deferredIndexes.length === 0 ? 'not-needed' : 'complete',
      },
      {
        name: 'paddle-overlapping-band-retry',
        elapsedMs: options.retryElapsedMs,
        inputCount: options.retryPlan?.pages.length ?? 0,
        outputCount: options.retryPlan?.pages.length ?? 0,
        status: options.retryPlan === null ? 'not-needed' : 'complete',
      },
      {
        name: 'hybrid-exact-row-deduplication',
        elapsedMs: 0,
        inputCount: fallbackRows.length,
        outputCount: fallbackUniqueIds.length,
        status: 'complete',
      },
    ],
    elapsedMs: options.fast.elapsedMs + options.fallbackElapsedMs + options.retryElapsedMs,
    measurements: [...options.fast.measurements, ...fallbackUniqueIds],
    diagnostics: {
      counts: {
        ...options.fast.diagnostics.counts,
        ...fallbackDiagnostics,
        hybridFastPathPages: fastPages.size,
        hybridDeferredPages: deferredIndexes.length,
        hybridFallbackRowsProduced: fallbackRows.length,
        hybridFallbackRowsRejected: options.fallbackRejectedRows,
        hybridExactDuplicateRows: deduplicated.duplicateCount,
        hybridDuplicateMeasurementIds: Math.max(
          0,
          deduplicated.measurements.length - fallbackUniqueIds.length,
        ),
        hybridRetryReplacedPages: options.replacedPageIndexes.length,
      },
      limitations: [
        'Bound selectable-text Poppler pages use the source-owned header-table v3 fast path.',
        'Image or unstructured pages are sent only to the configured local PaddleOCR-VL adapter.',
        'Model rows without a one-based deferred page are retained in the private adapter artifact and excluded from the merged result.',
        'Overlapping-band deduplication excludes geometry from the exact-row key so crop-relative boxes do not create duplicates.',
        ...(options.replacedPageIndexes.length > 0
          ? [
              'Pathological full-page attempts were replaced by overlapping-band attempts for the flagged pages.',
            ]
          : []),
        ...(modelSha256 === null
          ? ['Paddle model hash is unavailable because no --model path was supplied.']
          : []),
        ...(runtimeSha256 === null
          ? ['Paddle runtime hash is unavailable because no --runtime path was supplied.']
          : []),
      ],
    },
  };
}

export async function runHybridImport(options: HybridRunnerOptions): Promise<HybridRunResult> {
  const reportId = component(options.reportId, 'report-id');
  const paths = defaultPaths({ ...options, reportId });
  ensurePrivateDirectory(paths.privateRoot);
  assertPrivatePath(paths.report, paths.privateRoot);
  assertPrivatePath(paths.expected, paths.privateRoot);
  existingFile(paths.report, 'hybrid-report-missing');
  existingFile(paths.expected, 'hybrid-ground-truth-missing');
  securePrivateFile(paths.report);
  securePrivateFile(paths.expected);

  const runtimeVersion = `${process.platform}-${process.arch}-${process.version}`;
  ensureBoundPopplerSnapshot(paths, runtimeVersion);
  validatePreflightPaths({ ...preflightPaths(paths), reportId });
  ensurePrivateDirectory(paths.runDirectory);

  const expected = readExpectedResults(paths.expected);
  const reportSha256 = verifyReportAndGroundTruth(paths.report, expected, reportId);
  const routeStarted = performance.now();
  const routed = await runRoutedHeaderTable({
    reportPath: paths.report,
    reportId,
    snapshotPath: paths.snapshot,
    bindingPath: paths.binding,
    outputPath: paths.fastOutput,
    privateRoot: paths.privateRoot,
    bindingModulePath:
      options.bindingModulePath ??
      resolve(dirname(fileURLToPath(import.meta.url)), 'raw-snapshot-binding.ts'),
  });
  const routeElapsedMs = Math.max(0, Math.round(performance.now() - routeStarted));
  const maps = routeMaps(routed.routes);
  const deferredIndexes = routed.deferredPageIndexes;
  const initialPlan = buildHybridRetryPlan({
    deferredPageIndexes: deferredIndexes,
    routeReasons: maps.reasons,
    observationCounts: maps.observations,
    denseObservationThreshold: options.denseObservationThreshold,
    bandHeight: options.bandHeight,
    overlap: options.overlap,
  });
  writeJsonFile(paths.routeOutput, {
    schemaVersion: 'alyte.import-eval.hybrid-route-plan.v1',
    reportId,
    reportSha256,
    routeElapsedMs,
    routes: routed.routes,
    plan: initialPlan,
  });

  const modelPath = options.paddleModelPath === undefined ? null : resolve(options.paddleModelPath);
  const projectorPath =
    options.paddleProjectorPath === undefined ? null : resolve(options.paddleProjectorPath);
  const runtimePath =
    options.paddleRuntimePath === undefined ? null : resolve(options.paddleRuntimePath);
  const modelSha256 = deferredIndexes.length > 0 ? artifactHash(modelPath, 'model') : null;
  const projectorSha256 =
    deferredIndexes.length > 0 ? artifactHash(projectorPath, 'projector') : null;
  const runtimeSha256 = deferredIndexes.length > 0 ? artifactHash(runtimePath, 'runtime') : null;
  const adapterPath =
    deferredIndexes.length === 0 || options.paddleAdapterPath === undefined
      ? null
      : safeAdapterPath(options.paddleAdapterPath);
  const adapterSha256 = deferredIndexes.length > 0 ? artifactHash(adapterPath, 'adapter') : null;
  let fallbackPipelines: PipelineResult[] = [];
  let fallbackElapsedMs = 0;
  let retryElapsedMs = 0;
  let retryPlan: HybridRetryPlan | null = null;
  let fallbackRejectedRows = 0;
  let replacedPageIndexes: readonly number[] = [];
  let fallbackPageTimings: ReturnType<typeof pageTimings> = [];
  if (deferredIndexes.length > 0) {
    if (adapterPath === null) throw new Error('hybrid-paddle-adapter-required');
    const initialStarted = performance.now();
    writeJsonFile(join(paths.runDirectory, `${reportId}.paddle-plan.json`), initialPlan);
    const initial = runPaddleAdapter({
      adapterPath,
      report: paths.report,
      reportId,
      privateRoot: paths.privateRoot,
      output: paths.paddleOutput,
      planPath: join(paths.runDirectory, `${reportId}.paddle-plan.json`),
      retry: false,
      model: modelPath,
      projector: projectorPath,
      runtime: runtimePath,
      expectedReportSha256: reportSha256,
    });
    fallbackElapsedMs += Math.max(0, Math.round(performance.now() - initialStarted));
    fallbackPageTimings = completePageTimings(
      pageTimings(initial.pipeline.pipeline.configuration.pageTimings),
      deferredIndexes,
    );
    const scopedInitial = scopedFallbackMeasurements(
      initial.pipeline.measurements,
      new Set(deferredIndexes),
    );
    fallbackRejectedRows += scopedInitial.rejected;
    const retryPages = requestedRetryPages(
      initial.pipeline,
      scopedInitial.measurements,
      deferredIndexes,
    );
    if (retryPages.length > 0) {
      replacedPageIndexes = retryPages;
      const retryPageSet = new Set(retryPages);
      fallbackPipelines.push({
        ...initial.pipeline,
        measurements: initial.pipeline.measurements.filter(
          (measurement) => measurement.page !== null && !retryPageSet.has(measurement.page - 1),
        ),
      });
      retryPlan = buildHybridRetryPlan({
        deferredPageIndexes: deferredIndexes,
        routeReasons: maps.reasons,
        observationCounts: maps.observations,
        denseObservationThreshold: options.denseObservationThreshold,
        bandHeight: options.bandHeight,
        overlap: options.overlap,
        reason: 'repetition-detected',
        onlyPages: retryPages,
      });
      const retryPlanPath = join(paths.runDirectory, `${reportId}.paddle-retry-plan.json`);
      writeJsonFile(retryPlanPath, retryPlan);
      const retryStarted = performance.now();
      const retry = runPaddleAdapter({
        adapterPath,
        report: paths.report,
        reportId,
        privateRoot: paths.privateRoot,
        output: paths.retryOutput,
        planPath: retryPlanPath,
        retry: true,
        model: modelPath,
        projector: projectorPath,
        runtime: runtimePath,
        expectedReportSha256: reportSha256,
      });
      retryElapsedMs = Math.max(0, Math.round(performance.now() - retryStarted));
      fallbackPipelines.push(retry.pipeline);
      fallbackPageTimings = [
        ...fallbackPageTimings,
        ...completePageTimings(
          pageTimings(retry.pipeline.pipeline.configuration.pageTimings),
          retryPlan.pages.map((page) => page.pageIndex),
        ),
      ];
      const scopedRetry = scopedFallbackMeasurements(
        retry.pipeline.measurements,
        new Set(deferredIndexes),
      );
      fallbackRejectedRows += scopedRetry.rejected;
    } else {
      fallbackPipelines.push(initial.pipeline);
    }
  }

  const pipeline = mergePipeline({
    reportId,
    reportSha256,
    fast: routed.pipeline,
    fallback: fallbackPipelines,
    routes: routed.routes,
    initialPlan,
    retryPlan,
    modelSha256,
    projectorSha256,
    runtimeSha256,
    adapterSha256,
    fallbackElapsedMs,
    retryElapsedMs,
    fallbackRejectedRows,
    replacedPageIndexes,
    fallbackPageTimings,
  });
  if (sha256File(paths.report) !== reportSha256) throw new Error('hybrid-report-mutated');
  writeJsonFile(paths.output, pipeline);
  const detailed = scoreEvaluation(expected, pipeline);
  writeJsonFile(paths.scoreOutput, detailed);
  const aggregate: SafeAggregate = {
    ...toSafeAggregate(detailed),
    groundTruthSha256: sha256File(paths.expected),
    groundTruthVersion: expected.groundTruthVersion,
  };
  writeJsonFile(paths.aggregateOutput, aggregate);
  writePrivateTextFile(paths.markdownOutput, renderAggregateMarkdown([aggregate]));
  return {
    pipeline,
    aggregate,
    routes: routed.routes,
    initialPlan,
    retryPlan,
    paths,
  };
}

function parseCli(): HybridRunnerOptions {
  const args = process.argv.slice(2);
  const reportId = requiredArgument(args, '--report-id');
  const privateRoot = resolve(
    argument(args, '--private-root') ??
      argument(args, '--root') ??
      requiredArgument(args, '--private-root'),
  );
  const reportPath = resolve(
    argument(args, '--report') ?? join(privateRoot, 'reports', `${reportId}.pdf`),
  );
  const expectedPath = resolve(
    argument(args, '--expected') ??
      argument(args, '--ground-truth') ??
      join(privateRoot, 'ground-truth', `${reportId}.json`),
  );
  const denseObservationThreshold = argument(args, '--dense-threshold');
  const bandHeight = argument(args, '--band-height');
  const overlap = argument(args, '--overlap');
  const parseNumber = (value: string | undefined, field: string): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`hybrid-${field}-invalid`);
    return parsed;
  };
  return {
    reportPath,
    reportId,
    expectedPath,
    privateRoot,
    ...(argument(args, '--raw-snapshot') === undefined
      ? {}
      : { rawSnapshotPath: resolve(argument(args, '--raw-snapshot')!) }),
    ...(argument(args, '--binding') === undefined
      ? {}
      : { bindingPath: resolve(argument(args, '--binding')!) }),
    ...(argument(args, '--binding-module') === undefined
      ? {}
      : { bindingModulePath: resolve(argument(args, '--binding-module')!) }),
    ...(argument(args, '--paddle-adapter') === undefined
      ? {}
      : { paddleAdapterPath: resolve(argument(args, '--paddle-adapter')!) }),
    ...(argument(args, '--model') === undefined
      ? {}
      : { paddleModelPath: resolve(argument(args, '--model')!) }),
    ...(argument(args, '--projector') === undefined
      ? {}
      : { paddleProjectorPath: resolve(argument(args, '--projector')!) }),
    ...(argument(args, '--runtime') === undefined
      ? {}
      : { paddleRuntimePath: resolve(argument(args, '--runtime')!) }),
    ...(argument(args, '--run-id') === undefined ? {} : { runId: argument(args, '--run-id')! }),
    ...(denseObservationThreshold === undefined
      ? {}
      : { denseObservationThreshold: parseNumber(denseObservationThreshold, 'dense-threshold') }),
    ...(bandHeight === undefined ? {} : { bandHeight: parseNumber(bandHeight, 'band-height') }),
    ...(overlap === undefined ? {} : { overlap: parseNumber(overlap, 'overlap') }),
  };
}

function main(): void {
  try {
    const result = runHybridImport(parseCli());
    void result
      .then((value) => {
        process.stdout.write(
          `${JSON.stringify({
            reportId: value.aggregate.reportId,
            pipeline: value.aggregate.pipeline,
            counts: value.aggregate.counts,
            elapsedMs: value.aggregate.elapsedMs,
          })}\n`,
        );
      })
      .catch(() => {
        process.stderr.write('hybrid-import-failed\n');
        process.exitCode = 1;
      });
  } catch {
    process.stderr.write('hybrid-import-failed\n');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('/hybrid-import-runner.ts') === true) main();
