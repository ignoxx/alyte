/**
 * Evaluation-only full-page transcription ceiling for the cached Qwen3.5-2B pack.
 *
 * The production prompt/grammar is still owned by qwen35-mac-cli. This path deliberately does
 * not pass ground truth or OCR text to the model. Its returned strings are scored privately and
 * are never eligible for production admission because they have no source-observation IDs.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  assertPrivateEvaluationPath,
  ensurePrivateDirectory,
  ensurePrivateFile,
} from './qwen-mac-cli';
import { recoverDocumentVLMRows } from './document-vlm-recovery';

const SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
const FULL_PAGE_MAX_OUTPUT_TOKENS = 8_192;
const FULL_PAGE_CONTEXT_TOKENS = 12_288;
const FULL_PAGE_TIMEOUT_MS = 120_000;

type FullPageAdapter = {
  readonly createQwenMacDocumentVLM: (options: {
    readonly paths: {
      readonly privateRoot: string;
      readonly binary?: string;
      readonly model?: string;
      readonly mmproj?: string;
    };
    readonly provenance?: {
      readonly modelId?: string;
      readonly modelRevision?: string;
      readonly modelExpectedSha256?: string;
      readonly projectorExpectedSha256?: string;
      readonly runtimeRevision?: string;
    };
    readonly maxOutputTokens?: number;
    readonly contextTokens?: number;
    readonly timeoutMs?: number;
    readonly onRawOutput?: (raw: string) => void;
  }) => Promise<{
    readonly extractor: {
      readonly prepare: () => Promise<{ readonly release: () => Promise<void> }>;
      readonly extract: (request: {
        readonly pageIndex: number;
        readonly imageURI: string;
        readonly locale: string;
        readonly timeoutMs: number;
        readonly maxOutputTokens: number;
      }) => Promise<
        readonly {
          readonly label: string;
          readonly value: string | null;
          readonly unit: string | null;
          readonly referenceInterval: string | null;
          readonly flag: string | null;
        }[]
      >;
    };
    readonly provenance: Record<string, unknown>;
  }>;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const value = argument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('qwen35-fullpage-page-count-invalid');
  }
  return parsed;
}

export function parsePageSelection(value: string): readonly number[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^\d+$/u.test(part))) {
    throw new Error('qwen35-fullpage-pages-invalid');
  }
  const pages = [...new Set(parts.map(Number))].toSorted((left, right) => left - right);
  if (pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error('qwen35-fullpage-pages-invalid');
  }
  return pages;
}

export function resolveSelectedPages(
  pageCount: number,
  selection: string | undefined,
): readonly number[] {
  const pages =
    selection === undefined
      ? Array.from({ length: pageCount }, (_, index) => index + 1)
      : parsePageSelection(selection);
  if (pages.some((page) => page > pageCount)) {
    throw new Error('qwen35-fullpage-pages-out-of-range');
  }
  return pages;
}

export function parseLocaleArgument(locale: string | undefined): string {
  const value = locale ?? 'en-US';
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(value)) {
    throw new Error('qwen35-fullpage-locale-invalid');
  }
  return value;
}

function localeArgument(): string {
  return parseLocaleArgument(argument('--locale'));
}

function pagesArgument(): string | undefined {
  const index = process.argv.indexOf('--pages');
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('qwen35-fullpage-pages-invalid');
  }
  return value;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function numericValue(value: string | null): number | string | null {
  if (value === null) return null;
  const normalized = value.replace(/,/gu, '.').replace(/\s+/gu, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : value;
}

function valueType(value: string | null): 'numeric' | 'bounded' | 'text' | 'unknown' {
  if (value === null) return 'unknown';
  return /^(?:[<>≤≥]=?|=)?\s*[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/u.test(value)
    ? /^(?:[<>≤≥])/u.test(value.trim())
      ? 'bounded'
      : 'numeric'
    : 'text';
}

function comparator(value: string | null): '<' | '>' | '<=' | '>=' | '=' | null {
  const token = value?.trim().match(/^(<=|>=|<|>|=|≤|≥)/u)?.[1];
  if (token === undefined) return null;
  if (token === '≤') return '<=';
  if (token === '≥') return '>=';
  return token as '<' | '>' | '<=' | '>=' | '=';
}

function measurement(
  row: {
    readonly label: string;
    readonly value: string | null;
    readonly unit: string | null;
    readonly referenceInterval: string | null;
    readonly flag: string | null;
  },
  pageIndex: number,
  rowIndex: number,
) {
  const type = valueType(row.value);
  return {
    id: `qwen35-page-${String(pageIndex + 1).padStart(2, '0')}-row-${String(rowIndex + 1).padStart(3, '0')}`,
    sourceLabel: row.label,
    valueString: row.value,
    valueType: type,
    parsedValue: type === 'numeric' || type === 'bounded' ? numericValue(row.value) : null,
    comparator: type === 'numeric' || type === 'bounded' ? comparator(row.value) : null,
    unit: row.unit,
    referenceInterval: row.referenceInterval,
    flag: row.flag,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: pageIndex + 1,
    location: null,
    ambiguousFields: ['sourceIds', 'collectionDate', 'specimen'],
    canonicalBiomarkerId: null,
    trendEligible: null,
    unresolvedFields: ['sourceIds', 'collectionDate', 'specimen'],
    sourceIds: [],
  } as const;
}

function renderPage(
  binary: string,
  report: string,
  output: string,
  pageIndex: number,
  privateRoot: string,
): void {
  const metadata = JSON.parse(
    execFileSync(
      binary,
      [
        '--report',
        report,
        '--page',
        String(pageIndex),
        '--rect',
        '0,0,1,1',
        '--output',
        output,
        '--private-root',
        privateRoot,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
    ),
  ) as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 'alyte.import-eval.crop.v1' ||
    metadata.reportSha256 !== sha256(report) ||
    metadata.pageIndex !== pageIndex ||
    metadata.outputPath !== output ||
    !statSync(output).isFile()
  )
    throw new Error('qwen35-fullpage-render-invalid');
  chmodSync(output, 0o600);
}

async function main(): Promise<void> {
  const report = argument('--report');
  const reportId = argument('--report-id');
  const privateRoot = argument('--private-root');
  const output = argument('--output');
  const renderBinary = argument('--render-binary');
  const sourceImageDir = argument('--source-image-dir');
  const adapterPath = resolve(
    argument('--adapter') ?? join(dirname(new URL(import.meta.url).pathname), 'qwen35-mac-cli.ts'),
  );
  const modelPath = argument('--model');
  const mmprojPath = argument('--mmproj');
  const qwenBinaryPath = argument('--qwen-binary');
  const pageCount = positiveIntegerArgument('--page-count', 14);
  const selectedPages = resolveSelectedPages(pageCount, pagesArgument());
  const fullPageTimeoutMs = Number(argument('--timeout-ms') ?? FULL_PAGE_TIMEOUT_MS);
  if (
    !Number.isSafeInteger(fullPageTimeoutMs) ||
    fullPageTimeoutMs < 1 ||
    fullPageTimeoutMs > FULL_PAGE_TIMEOUT_MS
  ) {
    throw new Error('qwen35-fullpage-timeout-invalid');
  }
  const locale = localeArgument();
  if (!report || !reportId || !privateRoot || !output || (!renderBinary && !sourceImageDir))
    throw new Error('qwen35-fullpage-arguments-invalid');
  const root = resolve(privateRoot);
  const reportPath = assertPrivateEvaluationPath(resolve(report), root, 'input');
  const outputPath = assertPrivateEvaluationPath(resolve(output), root, 'output');
  const binaryPath = renderBinary === undefined ? null : resolve(renderBinary);
  const reportHash = sha256(reportPath);
  ensurePrivateDirectory(dirname(outputPath));
  const started = performance.now();
  const adapter = (await import(pathToFileURL(adapterPath).href)) as FullPageAdapter;
  const renderStarted = performance.now();
  const renderedPages: string[] = [];
  const renderRoot = join(root, 'rendered', 'qwen35-full-page');
  ensurePrivateDirectory(renderRoot);
  const imageExtension = sourceImageDir === undefined ? 'jpg' : 'png';
  for (const pageNumber of selectedPages) {
    const pageIndex = pageNumber - 1;
    const path = join(
      renderRoot,
      `${reportHash}-page-${String(pageNumber).padStart(2, '0')}.${imageExtension}`,
    );
    if (sourceImageDir !== undefined) {
      const source = resolve(
        sourceImageDir,
        `${reportId}-${String(pageNumber).padStart(2, '0')}.png`,
      );
      copyFileSync(source, path);
      chmodSync(path, 0o600);
    } else if (binaryPath !== null) {
      renderPage(binaryPath, reportPath, path, pageIndex, root);
    } else {
      throw new Error('qwen35-fullpage-renderer-missing');
    }
    renderedPages.push(path);
  }
  const renderElapsedMs = performance.now() - renderStarted;
  const modelStarted = performance.now();
  const rawRoot = join(root, 'raw', 'qwen35-fullpage-responses');
  ensurePrivateDirectory(rawRoot);
  let activePageNumber: number | null = null;
  const rawResponses = new Map<number, string>();
  const model = await adapter.createQwenMacDocumentVLM({
    paths: {
      privateRoot: root,
      ...(modelPath === undefined ? {} : { model: resolve(modelPath) }),
      ...(mmprojPath === undefined ? {} : { mmproj: resolve(mmprojPath) }),
      ...(qwenBinaryPath === undefined ? {} : { binary: resolve(qwenBinaryPath) }),
    },
    maxOutputTokens: FULL_PAGE_MAX_OUTPUT_TOKENS,
    contextTokens: FULL_PAGE_CONTEXT_TOKENS,
    timeoutMs: fullPageTimeoutMs,
    provenance: {
      ...(argument('--model-id') === undefined ? {} : { modelId: argument('--model-id') }),
      ...(argument('--model-revision') === undefined
        ? {}
        : { modelRevision: argument('--model-revision') }),
      ...(argument('--model-expected-sha256') === undefined
        ? {}
        : { modelExpectedSha256: argument('--model-expected-sha256') }),
      ...(argument('--projector-expected-sha256') === undefined
        ? {}
        : { projectorExpectedSha256: argument('--projector-expected-sha256') }),
      ...(argument('--runtime-revision') === undefined
        ? {}
        : { runtimeRevision: argument('--runtime-revision') }),
    },
    onRawOutput: (raw) => {
      if (activePageNumber !== null) rawResponses.set(activePageNumber, raw);
    },
  });
  const lease = await model.extractor.prepare();
  const measurements = [];
  const pageResults: {
    readonly page: number;
    readonly rows: number;
    readonly elapsedMs: number;
    readonly rawResponsePath: string;
    readonly rawResponseSha256: string;
    readonly responseStatus: 'strict' | 'recovered' | 'invalid';
    readonly rejectedRowObjects: number;
    readonly repetitionDetected: boolean;
    readonly deferredRowObjects: number;
  }[] = [];
  const pageFailures: { readonly page: number; readonly category: string }[] = [];
  let recoveredPages = 0;
  let recoveredRows = 0;
  let repetitionDetectedPages = 0;
  let deferredRowObjects = 0;
  try {
    for (const [selectedIndex, image] of renderedPages.entries()) {
      const pageNumber = selectedPages[selectedIndex]!;
      const pageIndex = pageNumber - 1;
      const pageStarted = performance.now();
      activePageNumber = pageNumber;
      let rows: Awaited<ReturnType<typeof model.extractor.extract>> | null = null;
      let responseStatus: 'strict' | 'recovered' | 'invalid' = 'invalid';
      let rejectedRowObjects = 0;
      let repetitionDetected = false;
      let pageDeferredRowObjects = 0;
      try {
        rows = await model.extractor.extract({
          pageIndex,
          imageURI: pathToFileURL(image).href,
          locale,
          timeoutMs: fullPageTimeoutMs,
          maxOutputTokens: FULL_PAGE_MAX_OUTPUT_TOKENS,
        });
        responseStatus = 'strict';
      } catch (error) {
        const recovery = recoverDocumentVLMRows(rawResponses.get(pageNumber) ?? '');
        responseStatus = recovery.status;
        rejectedRowObjects = recovery.rejectedRowObjects;
        repetitionDetected = recovery.repetitionDetected;
        pageDeferredRowObjects = recovery.deferredRowObjects;
        if (repetitionDetected) repetitionDetectedPages += 1;
        deferredRowObjects += pageDeferredRowObjects;
        if (recovery.status === 'recovered') {
          rows = recovery.rows;
          recoveredPages += 1;
          recoveredRows += recovery.rows.length;
        } else {
          pageFailures.push({
            page: pageNumber,
            category: error instanceof Error ? error.message.replace(/^qwen-mac-/u, '') : 'unknown',
          });
        }
      }
      const rawPath = join(
        rawRoot,
        `${basename(outputPath, '.json')}-page-${String(pageNumber).padStart(2, '0')}.raw.txt`,
      );
      const raw = rawResponses.get(pageNumber) ?? '';
      ensurePrivateFile(rawPath, raw);
      if (rows !== null) {
        measurements.push(...rows.map((row, rowIndex) => measurement(row, pageIndex, rowIndex)));
      }
      pageResults.push({
        page: pageNumber,
        rows: rows?.length ?? 0,
        elapsedMs: performance.now() - pageStarted,
        rawResponsePath: rawPath,
        rawResponseSha256: sha256(rawPath),
        responseStatus,
        rejectedRowObjects,
        repetitionDetected,
        deferredRowObjects: pageDeferredRowObjects,
      });
    }
  } finally {
    activePageNumber = null;
    await lease.release();
  }
  const result = {
    schemaVersion: SCHEMA_VERSION,
    reportId,
    reportSha256: reportHash,
    pipeline: {
      id: 'alyte-qwen35-full-page-eval',
      version: 'qwen3.5-2b-production-document-prompt.v1',
      configuration: {
        locale,
        model: model.provenance,
        pageCount,
        selectedPages,
        pageScope: selectedPages.length === pageCount ? 'full-report' : 'selected-pages',
      },
      runtime: { os: process.platform, arch: process.arch, node: process.version },
    },
    stages: [
      {
        name: 'full-page-render',
        elapsedMs: renderElapsedMs,
        inputCount: selectedPages.length,
        outputCount: renderedPages.length,
        status: 'complete',
      },
      {
        name: 'qwen35-full-page-inference',
        elapsedMs: performance.now() - modelStarted,
        inputCount: selectedPages.length,
        outputCount: measurements.length,
        status: pageFailures.length === 0 ? 'complete' : 'partial',
      },
    ],
    elapsedMs: performance.now() - started,
    measurements,
    diagnostics: {
      counts: {
        pages: pageCount,
        selectedPages: selectedPages.length,
        renderedPages: renderedPages.length,
        returnedRows: measurements.length,
        pageFailures: pageFailures.length,
        recoveredPages,
        recoveredRows,
        repetitionDetectedPages,
        deferredRowObjects,
        strictCandidateRowsAdmitted: 0,
        strictCandidateRowsRejected: measurements.length,
      },
      limitations: [
        'Full-page model strings were scored privately as an evaluation ceiling and were never source-admitted.',
        'No OCR text or ground truth was included in the model prompt.',
        ...pageFailures.map(({ page, category }) => `page-${page}-${category}`),
      ],
    },
    privatePageResults: pageResults,
  };
  ensurePrivateFile(outputPath, `${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  void main().catch((error) => {
    const privateRoot = argument('--private-root');
    if (privateRoot !== undefined) {
      try {
        const failureRoot = join(resolve(privateRoot), 'failures');
        ensurePrivateDirectory(failureRoot);
        ensurePrivateFile(
          join(failureRoot, 'qwen35-fullpage.txt'),
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack ?? ''}\n`
            : 'unknown-error\n',
        );
      } catch {
        // Keep failure diagnostics private without changing the bounded CLI error.
      }
    }
    process.stderr.write('qwen35-fullpage-failed\n');
    process.exitCode = 1;
  });
}
