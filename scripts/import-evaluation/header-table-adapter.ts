/**
 * Evaluation-only adapter for the source-owned header table extractor.
 *
 * The adapter accepts a bound native reader snapshot. It intentionally does not fall back to a
 * filename convention: using an unbound snapshot would make a score impossible to reproduce or
 * prove against the selected report.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
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
  type HeaderTableDateLocale,
  type HeaderTableObservation,
  type HeaderTablePage,
} from './header-table';

type RawEnvelope = {
  readonly readerVersion?: unknown;
  readonly reportSha256?: unknown;
  readonly runtimeVersion?: unknown;
  readonly pages?: readonly unknown[];
};

type RawSnapshotIdentity = {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

type BindingModule = {
  readonly verifyRawSnapshotBinding: (
    rawText: string,
    binding: unknown,
    expected: RawSnapshotIdentity,
  ) => RawEnvelope;
};

const SHA256 = /^[a-f0-9]{64}$/u;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function dateLocaleArgument(): HeaderTableDateLocale | undefined {
  const value = argument('--date-locale');
  if (value === undefined) return undefined;
  if (value !== 'en-US' && value !== 'lt-LT' && value !== 'de-DE' && value !== 'de-CH') {
    throw new Error('header-table-date-locale-invalid');
  }
  return value;
}

function requiredHash(value: unknown, error: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(error);
  return value;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error);
  return value;
}

function bindingIdentity(value: unknown): RawSnapshotIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('header-table-binding-invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    reportSha256: requiredHash(record.reportSha256, 'header-table-binding-report-invalid'),
    readerVersion: requiredString(record.readerVersion, 'header-table-binding-reader-invalid'),
    runtimeVersion: requiredString(record.runtimeVersion, 'header-table-binding-runtime-invalid'),
    readerBinarySha256: requiredHash(
      record.readerBinarySha256,
      'header-table-binding-reader-binary-invalid',
    ),
    readerSourceSha256: requiredHash(
      record.readerSourceSha256,
      'header-table-binding-reader-source-invalid',
    ),
  };
}

function bindingSnapshotHash(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('header-table-binding-invalid');
  }
  return requiredHash(
    (value as Record<string, unknown>).snapshotSha256,
    'header-table-binding-snapshot-invalid',
  );
}

function rawPages(envelope: RawEnvelope): readonly HeaderTablePage[] {
  if (!Array.isArray(envelope.pages)) throw new Error('header-table-pages-invalid');
  return envelope.pages.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('header-table-page-invalid');
    }
    const page = item as Record<string, unknown>;
    const pageIndex = page.pageIndex;
    const width = page.width;
    const height = page.height;
    if (
      typeof pageIndex !== 'number' ||
      !Number.isSafeInteger(pageIndex) ||
      pageIndex !== index ||
      typeof width !== 'number' ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== 'number' ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      throw new Error('header-table-page-geometry-invalid');
    }
    const result = page.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('header-table-page-result-invalid');
    }
    const observations = (result as Record<string, unknown>).observations;
    if (!Array.isArray(observations)) throw new Error('header-table-observations-invalid');
    return {
      pageIndex,
      width,
      height,
      observations: observations as HeaderTableObservation[],
    };
  });
}

async function loadBoundSnapshot(options: {
  readonly reportPath: string;
  readonly snapshotPath: string;
  readonly bindingPath: string;
  readonly bindingModulePath: string;
  readonly privateRoot: string;
}): Promise<{
  readonly envelope: RawEnvelope;
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
  const bindingModule = (await import(
    pathToFileURL(resolve(options.bindingModulePath)).href
  )) as BindingModule;
  if (typeof bindingModule.verifyRawSnapshotBinding !== 'function') {
    throw new Error('header-table-binding-module-invalid');
  }
  const envelope = bindingModule.verifyRawSnapshotBinding(rawText, binding, identity);
  if (envelope.reportSha256 !== reportSha256 || envelope.readerVersion !== identity.readerVersion) {
    throw new Error('header-table-report-binding-mismatch');
  }
  if (sha256File(snapshotPath) !== snapshotSha256) throw new Error('header-table-snapshot-mutated');
  return { envelope, reportSha256, identity, snapshotSha256 };
}

export async function runHeaderTableAdapter(options: {
  readonly reportPath: string;
  readonly reportId: string;
  readonly snapshotPath: string;
  readonly bindingPath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly bindingModulePath: string;
  readonly dateLocale?: HeaderTableDateLocale;
}): Promise<PipelineResult> {
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
    privateRoot,
  });
  const pages = rawPages(loaded.envelope);
  const readElapsedMs = Math.max(0, Math.round(performance.now() - started));
  const extracted = extractHeaderTablePages(pages, { dateLocale: options.dateLocale });
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  if (sha256File(reportPath) !== loaded.reportSha256)
    throw new Error('header-table-report-mutated');
  if (sha256File(snapshotPath) !== loaded.snapshotSha256) {
    throw new Error('header-table-snapshot-mutated');
  }
  ensurePrivateDirectory(dirname(outputPath));
  const result: PipelineResult = {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId: options.reportId,
    reportSha256: loaded.reportSha256,
    pipeline: {
      id: 'alyte-header-table',
      version: HEADER_TABLE_PIPELINE_VERSION,
      configuration: {
        modelEnabled: false,
        source: 'bound-native-observations',
        rawReaderVersion: loaded.identity.readerVersion,
        rawSnapshotSha256: loaded.snapshotSha256,
        rawSnapshotSchemaVersion: 'alyte.import-eval.raw-snapshot-binding.v1',
        readerBinarySha256: loaded.identity.readerBinarySha256,
        readerSourceSha256: loaded.identity.readerSourceSha256,
        readerRuntimeVersion: loaded.identity.runtimeVersion,
        dateLocale: options.dateLocale ?? null,
        timingScope: 'bound-snapshot-read-and-header-extraction',
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
        name: 'header-owned-table-extraction',
        elapsedMs: Math.max(0, elapsedMs - readElapsedMs),
        inputCount: pages.length,
        outputCount: extracted.measurements.length,
        status: 'success',
      },
    ],
    elapsedMs,
    measurements: extracted.measurements,
    diagnostics: {
      counts: extracted.counts,
      limitations: [
        'Only rows owned by multilingual current-result headers are admitted.',
        'Source labels and values retain native source IDs; no footnote text is silently removed.',
        'Rows without safe header or cell ownership remain unresolved for later review.',
      ],
    },
  };
  writeJsonFile(outputPath, result);
  return result;
}

async function main(): Promise<void> {
  const report = argument('--report');
  const reportId = argument('--report-id');
  const snapshot = argument('--raw-snapshot');
  const binding = argument('--binding');
  const output = argument('--output');
  const privateRoot = argument('--private-root');
  const bindingModule = argument('--binding-module');
  if (!report || !reportId || !snapshot || !binding || !output || !privateRoot || !bindingModule) {
    throw new Error('header-table-bound-arguments-invalid');
  }
  const result = await runHeaderTableAdapter({
    reportPath: report,
    reportId,
    snapshotPath: snapshot,
    bindingPath: binding,
    outputPath: output,
    privateRoot,
    bindingModulePath: bindingModule,
    dateLocale: dateLocaleArgument(),
  });
  process.stdout.write(
    `${JSON.stringify({ elapsedMs: result.elapsedMs, measurements: result.measurements.length })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('header-table-adapter failed\n');
    process.exitCode = 1;
  });
}
