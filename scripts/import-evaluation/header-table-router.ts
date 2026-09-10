/**
 * Evaluation-only route gate for the deterministic header-table fast path.
 *
 * Routing is based on the bound reader's source provenance. Selectable text from the Poppler
 * word/line reader has a synthetic source stream whose offsets and boxes can be grounded; Vision
 * OCR observations, including inferred table cells, remain deferred to a later model path.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  readJsonFile,
  securePrivateFile,
  sha256File,
  writeJsonFile,
  IMPORT_EVALUATION_SCHEMA_VERSION,
  type PipelineResult,
} from './contract';
import {
  extractHeaderTablePages,
  HEADER_TABLE_PIPELINE_VERSION,
  type HeaderTableObservation,
  type HeaderTablePage,
} from './header-table';

export const HEADER_TABLE_ROUTER_VERSION = 'alyte.header-table-router.v1' as const;
const SELECTABLE_TEXT_READER_VERSION = 'alyte.mac.poppler-layout-reader.v1' as const;

export type HeaderTableRouteKind = 'structured-text-table' | 'unstructured-or-image';

export type HeaderTableRoute = {
  readonly pageIndex: number;
  readonly kind: HeaderTableRouteKind;
  readonly reason:
    | 'bound-selectable-text-source'
    | 'empty-source-text'
    | 'mixed-or-unknown-provenance'
    | 'no-selectable-text-provenance'
    | 'empty-observations';
  readonly observationCount: number;
  readonly structuredObservationCount: number;
  readonly tableCount: number;
  readonly rowCount: number;
  readonly columnCount: number;
};

type RawEnvelope = {
  readonly readerVersion?: unknown;
  readonly reportSha256?: unknown;
  readonly runtimeVersion?: unknown;
  readonly sourceTextConstruction?: unknown;
  readonly sourceOffsetKind?: unknown;
  readonly pages?: readonly unknown[];
};

export type RoutedHeaderTablePage = HeaderTablePage & {
  readonly readerVersion: string | null;
  readonly sourceText: string | null;
  readonly sourceTextConstruction: string | null;
  readonly sourceOffsetKind: string | null;
};

type RawSnapshotIdentity = {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

export type HeaderTableBindingModule = {
  readonly verifyRawSnapshotBinding: (
    rawText: string,
    binding: unknown,
    expected: RawSnapshotIdentity,
  ) => RawEnvelope;
};

export type HeaderTableRouteResult = {
  readonly pipeline: PipelineResult;
  readonly routes: readonly HeaderTableRoute[];
  readonly deferredPageIndexes: readonly number[];
  readonly elapsedMs: number;
};

const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown, error: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error);
  return value;
}

function requiredHash(value: unknown, error: string): string {
  const result = requiredString(value, error);
  if (!SHA256.test(result)) throw new Error(error);
  return result;
}

function bindingIdentity(value: unknown): RawSnapshotIdentity {
  const input = record(value, 'header-table-binding-invalid');
  return {
    reportSha256: requiredHash(input.reportSha256, 'header-table-binding-report-invalid'),
    readerVersion: requiredString(input.readerVersion, 'header-table-binding-reader-invalid'),
    runtimeVersion: requiredString(input.runtimeVersion, 'header-table-binding-runtime-invalid'),
    readerBinarySha256: requiredHash(
      input.readerBinarySha256,
      'header-table-binding-reader-binary-invalid',
    ),
    readerSourceSha256: requiredHash(
      input.readerSourceSha256,
      'header-table-binding-reader-source-invalid',
    ),
  };
}

function bindingSnapshotHash(value: unknown): string {
  const input = record(value, 'header-table-binding-invalid');
  return requiredHash(input.snapshotSha256, 'header-table-binding-snapshot-invalid');
}

function validBox(value: unknown): boolean {
  const box = record(value, 'header-table-box-invalid');
  return (
    typeof box.x === 'number' &&
    Number.isFinite(box.x) &&
    typeof box.y === 'number' &&
    Number.isFinite(box.y) &&
    typeof box.width === 'number' &&
    Number.isFinite(box.width) &&
    box.width > 0 &&
    typeof box.height === 'number' &&
    Number.isFinite(box.height) &&
    box.height > 0
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function pageMetadata(
  page: Record<string, unknown>,
  envelope: RawEnvelope,
  key: 'readerVersion' | 'sourceTextConstruction' | 'sourceOffsetKind',
): string | null {
  if (Object.prototype.hasOwnProperty.call(page, key)) return optionalString(page[key]);
  return optionalString(envelope[key]);
}

function snapshotPages(envelope: RawEnvelope): readonly RoutedHeaderTablePage[] {
  if (!Array.isArray(envelope.pages)) throw new Error('header-table-pages-invalid');
  return envelope.pages.map((item, index) => {
    const page = record(item, 'header-table-page-invalid');
    if (
      typeof page.pageIndex !== 'number' ||
      !Number.isSafeInteger(page.pageIndex) ||
      page.pageIndex !== index ||
      typeof page.width !== 'number' ||
      !Number.isFinite(page.width) ||
      page.width <= 0 ||
      typeof page.height !== 'number' ||
      !Number.isFinite(page.height) ||
      page.height <= 0
    ) {
      throw new Error('header-table-page-geometry-invalid');
    }
    const result = record(page.result, 'header-table-page-result-invalid');
    if (!Array.isArray(result.observations)) throw new Error('header-table-observations-invalid');
    for (const observationValue of result.observations) {
      const observation = record(observationValue, 'header-table-observation-invalid');
      if (
        typeof observation.id !== 'string' ||
        observation.id.length === 0 ||
        typeof observation.text !== 'string' ||
        !validBox(observation.boundingBox)
      ) {
        throw new Error('header-table-observation-invalid');
      }
    }
    return {
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      observations: result.observations as HeaderTableObservation[],
      readerVersion: pageMetadata(page, envelope, 'readerVersion'),
      sourceText: Object.prototype.hasOwnProperty.call(page, 'sourceText')
        ? optionalString(page.sourceText)
        : null,
      sourceTextConstruction: pageMetadata(page, envelope, 'sourceTextConstruction'),
      sourceOffsetKind: pageMetadata(page, envelope, 'sourceOffsetKind'),
    };
  });
}

function deferredRoute(
  page: RoutedHeaderTablePage,
  reason: HeaderTableRoute['reason'],
): HeaderTableRoute {
  return {
    pageIndex: page.pageIndex,
    kind: 'unstructured-or-image',
    reason,
    observationCount: page.observations.length,
    structuredObservationCount: 0,
    tableCount: 0,
    rowCount: 0,
    columnCount: 0,
  };
}

export function classifyHeaderTablePage(page: RoutedHeaderTablePage): HeaderTableRoute {
  if (page.observations.length === 0) return deferredRoute(page, 'empty-observations');
  if (page.sourceText !== null && page.sourceText.trim().length === 0) {
    return deferredRoute(page, 'empty-source-text');
  }
  if (
    page.sourceText === null ||
    page.readerVersion === null ||
    page.sourceTextConstruction === null ||
    page.sourceOffsetKind === null
  ) {
    return deferredRoute(page, 'mixed-or-unknown-provenance');
  }
  if (
    page.readerVersion !== SELECTABLE_TEXT_READER_VERSION ||
    page.sourceTextConstruction !== 'poppler-word-lines.v1' ||
    page.sourceOffsetKind !== 'synthetic-page-text-utf16'
  ) {
    return deferredRoute(page, 'no-selectable-text-provenance');
  }
  return {
    pageIndex: page.pageIndex,
    kind: 'structured-text-table',
    reason: 'bound-selectable-text-source',
    observationCount: page.observations.length,
    structuredObservationCount: 0,
    tableCount: 0,
    rowCount: 0,
    columnCount: 0,
  };
}

export function classifyHeaderTablePages(
  pages: readonly RoutedHeaderTablePage[],
): readonly HeaderTableRoute[] {
  return pages.map(classifyHeaderTablePage);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadBoundSnapshot(options: {
  readonly reportPath: string;
  readonly snapshotPath: string;
  readonly bindingPath: string;
  readonly bindingModulePath?: string;
  readonly bindingModule?: HeaderTableBindingModule;
  readonly privateRoot: string;
}): Promise<{
  readonly envelope: RawEnvelope;
  readonly rawText: string;
  readonly reportSha256: string;
  readonly identity: RawSnapshotIdentity;
  readonly snapshotSha256: string;
}> {
  const reportPath = assertPrivatePath(options.reportPath, options.privateRoot);
  const snapshotPath = assertPrivatePath(options.snapshotPath, options.privateRoot);
  const bindingPath = assertPrivatePath(options.bindingPath, options.privateRoot);
  securePrivateFile(reportPath);
  securePrivateFile(snapshotPath);
  securePrivateFile(bindingPath);
  const reportSha256 = sha256File(reportPath);
  const rawText = readFileSync(snapshotPath, 'utf8');
  const binding = readJsonFile(bindingPath);
  const identity = bindingIdentity(binding);
  if (identity.reportSha256 !== reportSha256)
    throw new Error('header-table-report-binding-mismatch');
  const snapshotSha256 = bindingSnapshotHash(binding);
  const module = options.bindingModule
    ? options.bindingModule
    : ((await import(
        pathToFileURL(resolve(options.bindingModulePath!)).href
      )) as HeaderTableBindingModule);
  if (typeof module.verifyRawSnapshotBinding !== 'function') {
    throw new Error('header-table-binding-module-invalid');
  }
  const envelope = module.verifyRawSnapshotBinding(rawText, binding, identity);
  if (envelope.reportSha256 !== reportSha256 || envelope.readerVersion !== identity.readerVersion) {
    throw new Error('header-table-report-binding-mismatch');
  }
  if (hashText(rawText) !== snapshotSha256) throw new Error('header-table-snapshot-mutated');
  return { envelope, rawText, reportSha256, identity, snapshotSha256 };
}

export async function runRoutedHeaderTable(options: {
  readonly reportPath: string;
  readonly reportId: string;
  readonly snapshotPath: string;
  readonly bindingPath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly bindingModulePath?: string;
  readonly bindingModule?: HeaderTableBindingModule;
}): Promise<HeaderTableRouteResult> {
  const privateRoot = resolve(options.privateRoot);
  const reportPath = assertPrivatePath(options.reportPath, privateRoot);
  const snapshotPath = assertPrivatePath(options.snapshotPath, privateRoot);
  const bindingPath = assertPrivatePath(options.bindingPath, privateRoot);
  const outputPath = assertPrivatePath(options.outputPath, privateRoot);
  if (new Set([reportPath, snapshotPath, bindingPath]).has(outputPath)) {
    throw new Error('header-table-output-collides-with-input');
  }
  const started = performance.now();
  const loaded = await loadBoundSnapshot({
    reportPath,
    snapshotPath,
    bindingPath,
    bindingModulePath: options.bindingModulePath,
    bindingModule: options.bindingModule,
    privateRoot,
  });
  const pages = snapshotPages(loaded.envelope);
  const readElapsedMs = Math.max(0, Math.round(performance.now() - started));
  const routeStarted = performance.now();
  const routes = classifyHeaderTablePages(pages);
  const routeElapsedMs = Math.max(0, Math.round(performance.now() - routeStarted));
  const fastPages = pages.filter(
    (page) => routes[page.pageIndex]?.kind === 'structured-text-table',
  );
  const extractionStarted = performance.now();
  const extracted = extractHeaderTablePages(fastPages);
  const extractionElapsedMs = Math.max(0, Math.round(performance.now() - extractionStarted));
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  if (sha256File(reportPath) !== loaded.reportSha256)
    throw new Error('header-table-report-mutated');
  if (sha256File(snapshotPath) !== loaded.snapshotSha256)
    throw new Error('header-table-snapshot-mutated');
  const structuredPageCount = routes.filter(
    (route) => route.kind === 'structured-text-table',
  ).length;
  const deferredPageIndexes = routes
    .filter((route) => route.kind === 'unstructured-or-image')
    .map((route) => route.pageIndex);
  const routeReasonCounts = routes.reduce<Record<string, number>>((counts, route) => {
    counts[route.reason] = (counts[route.reason] ?? 0) + 1;
    return counts;
  }, {});
  ensurePrivateDirectory(dirname(outputPath));
  const result: PipelineResult = {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: options.reportId,
    reportSha256: loaded.reportSha256,
    pipeline: {
      id: 'alyte-header-table-routed',
      version: `${HEADER_TABLE_PIPELINE_VERSION}.routed.v1`,
      configuration: {
        modelEnabled: false,
        routerVersion: HEADER_TABLE_ROUTER_VERSION,
        routePolicy: 'bound-selectable-text-source-only',
        rawReaderVersion: loaded.identity.readerVersion,
        rawSnapshotSha256: loaded.snapshotSha256,
        rawSnapshotSchemaVersion: 'alyte.import-eval.raw-snapshot-binding.v1',
        readerBinarySha256: loaded.identity.readerBinarySha256,
        readerSourceSha256: loaded.identity.readerSourceSha256,
        readerRuntimeVersion: loaded.identity.runtimeVersion,
        timingScope: 'bound-snapshot-read-route-and-header-extraction',
        structuredPageCount,
        deferredPageCount: deferredPageIndexes.length,
        deferredPageIndexes,
        routeDecisions: routes,
        routeReasonCounts,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        readerVersion: loaded.identity.readerVersion,
        readerRuntimeVersion: loaded.identity.runtimeVersion,
        cachedInput: true,
      },
    },
    stages: [
      {
        name: 'read-bound-native-snapshot',
        elapsedMs: readElapsedMs,
        outputCount: pages.length,
        status: 'success',
      },
      {
        name: 'route-native-table-fast-path',
        elapsedMs: routeElapsedMs,
        inputCount: pages.length,
        outputCount: structuredPageCount,
        status: 'success',
      },
      {
        name: 'header-owned-table-extraction',
        elapsedMs: extractionElapsedMs,
        inputCount: fastPages.length,
        outputCount: extracted.measurements.length,
        status: 'success',
      },
    ],
    elapsedMs,
    measurements: extracted.measurements,
    diagnostics: {
      counts: {
        ...extracted.counts,
        routerStructuredPages: structuredPageCount,
        routerDeferredPages: deferredPageIndexes.length,
      },
      limitations: [
        'Only pages with bound selectable-text provenance from the compatible Poppler word-line reader are admitted to the deterministic fast path.',
        'Deferred pages remain available for a later model fallback; this runner does not implement that fallback.',
        'Source labels and values retain native source IDs; no footnote text is silently removed.',
      ],
    },
  };
  writeJsonFile(outputPath, result);
  return { pipeline: result, routes, deferredPageIndexes, elapsedMs };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function defaultBindingPath(sourcePath: string): string {
  return sourcePath.endsWith('.json')
    ? sourcePath.replace(/\.json$/u, '.binding.json')
    : `${sourcePath}.binding.json`;
}

async function main(): Promise<void> {
  const report = argument('--report');
  const reportId = argument('--report-id');
  const snapshot = argument('--raw-snapshot');
  const output = argument('--output');
  const privateRoot = argument('--private-root');
  const binding =
    argument('--binding') ??
    (snapshot === undefined ? undefined : defaultBindingPath(resolve(snapshot)));
  const bindingModule = argument('--binding-module');
  if (!report || !reportId || !snapshot || !binding || !output || !privateRoot || !bindingModule) {
    throw new Error('header-table-router-arguments-invalid');
  }
  const result = await runRoutedHeaderTable({
    reportPath: report,
    reportId,
    snapshotPath: snapshot,
    bindingPath: binding,
    outputPath: output,
    privateRoot,
    bindingModulePath: bindingModule,
  });
  process.stdout.write(
    `${JSON.stringify({
      elapsedMs: result.elapsedMs,
      measurements: result.pipeline.measurements.length,
      structuredPages: result.routes.filter((route) => route.kind === 'structured-text-table')
        .length,
      deferredPages: result.deferredPageIndexes.length,
    })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('header-table-router failed\n');
    process.exitCode = 1;
  });
}
