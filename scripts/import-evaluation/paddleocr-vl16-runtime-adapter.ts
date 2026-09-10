/**
 * Concrete evaluation-only runtime for the PaddleOCR-VL 1.6 Q8 seam.
 *
 * This wrapper owns local PDF rendering and llama-mtmd invocation. The proven v2 parser remains
 * the only row admission path: every accepted response is persisted below the private root and
 * passed through `runPaddleOcrAdapter`, which preserves collection-date handling, conflict
 * deferral, band provenance, and overlap deduplication.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join, resolve } from 'node:path';
import {
  IMPORT_EVALUATION_SCHEMA_VERSION,
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  securePrivateFile,
  sha256File,
  writeJsonFile,
  writePrivateTextFile,
  type PipelineResult,
} from './contract';
import { parsePaddleOcrPage, runPaddleOcrAdapter } from './paddleocr-vl16-adapter';
import {
  HYBRID_BAND_RETRY_VERSION,
  type HybridFallbackPage,
  type HybridRetryPlan,
  type NormalizedBand,
} from './hybrid-band-retry';
import { PADDLE_OCR_VL_SEAM_VERSION } from './paddle-ocr-vl-seam';

export const PADDLE_OCR_VL16_RUNTIME_ADAPTER_VERSION =
  'alyte.paddleocr-vl1.6-q8-runtime-adapter.v2' as const;
export const PADDLE_OCR_VL16_RUNTIME_PIPELINE_VERSION =
  'paddleocr-vl1.6-q8-llama-mtmd-runtime.v3' as const;
export const PADDLE_OCR_VL16_PROMPT = 'OCR:' as const;
export const PADDLE_OCR_VL16_RENDER_HEIGHT = 1800 as const;
export const PADDLE_OCR_VL16_RENDERER_VERSION = 'poppler-pdftoppm-height-1800.v2' as const;

const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,80}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RAW_RESPONSE_CHARS = 250_000;
const MAX_RAW_LINES = 500;
const MAX_RAW_LINE_CHARS = 1_000;
const MAX_INFERENCE_MS = 30_000;
const DEFAULT_RUNTIME_PATH = '/opt/homebrew/bin/llama-mtmd-cli';
const DEFAULT_RENDERER_PATH = '/opt/homebrew/bin/pdftoppm';
const DEFAULT_CROP_TOOL_PATH = '/opt/homebrew/bin/magick';
const DEFAULT_CONTEXT_SIZE = 8192;
const DEFAULT_MAX_TOKENS = 4096;

export type PaddleRenderedImage = {
  readonly imagePath: string;
  readonly width: number;
  readonly height: number;
};

export type PaddleRenderRequest = {
  readonly reportPath: string;
  readonly privateRoot: string;
  readonly pageIndex: number;
  readonly attemptIndex: number;
  readonly band: NormalizedBand;
  readonly outputPath: string;
};

export type PaddleRenderer = (
  request: PaddleRenderRequest,
) => PaddleRenderedImage | Promise<PaddleRenderedImage>;

export type PaddleInferenceRequest = {
  readonly reportId: string;
  readonly privateRoot: string;
  readonly pageIndex: number;
  readonly attemptIndex: number;
  readonly imagePath: string;
  readonly modelPath: string;
  readonly projectorPath: string;
  readonly runtimePath: string;
  readonly prompt: typeof PADDLE_OCR_VL16_PROMPT;
  readonly args: readonly string[];
};

export type PaddleInferenceResult = {
  readonly stdout: string;
  readonly stderr?: string;
};

export type PaddleInference = (
  request: PaddleInferenceRequest,
) => PaddleInferenceResult | Promise<PaddleInferenceResult>;

export type PaddleAttemptTiming = {
  readonly pageIndex: number;
  readonly attemptIndex: number;
  readonly band: NormalizedBand;
  readonly elapsedMs: number;
  readonly status: 'complete' | 'render-failed' | 'inference-failed' | 'pathological';
};

export type PaddlePageTiming = {
  readonly pageIndex: number;
  readonly elapsedMs: number;
  readonly attempts: number;
  readonly status: 'complete' | 'partial' | 'failed';
};

export type PaddleRuntimeAdapterOptions = {
  readonly reportPath: string;
  readonly reportId: string;
  readonly privateRoot: string;
  readonly outputPath: string;
  readonly plan: HybridRetryPlan;
  readonly retry: boolean;
  readonly modelPath: string | null;
  readonly projectorPath: string | null;
  readonly runtimePath: string | null;
  /** Optional pdftoppm path for deterministic local tests or a pinned evaluation binary. */
  readonly rendererPath?: string;
  readonly renderHelperPath?: string;
  readonly renderer?: PaddleRenderer;
  readonly infer?: PaddleInference;
};

export type PaddleRuntimeAdapterResult = {
  readonly pipeline: PipelineResult;
  readonly pageTimings: readonly PaddlePageTiming[];
  readonly attemptTimings: readonly PaddleAttemptTiming[];
  readonly repetitionDetectedPageIndexes: readonly number[];
};

type PaddleRendererProvenance = {
  readonly kind: 'poppler-pdftoppm' | 'custom-helper' | 'injected';
  readonly path: string | null;
  readonly version: string | null;
  readonly sha256: string | null;
  readonly cropToolPath: string | null;
  readonly cropToolSha256: string | null;
  readonly config: {
    readonly format: 'png' | 'jpeg';
    readonly dpi: number | null;
    readonly targetHeightPixels: number | null;
    readonly pageNumbering: 'one-based';
    readonly crop: 'normalized-top-left';
  };
};

type PaddleRendererDescriptor = {
  readonly render: PaddleRenderer;
  readonly provenance: PaddleRendererProvenance;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function existingFile(path: string, error: string): void {
  try {
    if (!lstatSync(path).isFile()) throw new Error(error);
  } catch (cause) {
    if (cause instanceof Error && cause.message === error) throw cause;
    throw new Error(error);
  }
}

function hash(path: string | null, field: string): string | null {
  if (path === null) return null;
  existingFile(path, `paddle-${field}-missing`);
  const value = sha256File(path);
  if (!SHA256.test(value)) throw new Error(`paddle-${field}-hash-invalid`);
  return value;
}

function reportId(value: string): string {
  if (!SAFE_COMPONENT.test(value)) throw new Error('paddle-report-id-invalid');
  return value;
}

function validateBand(value: unknown): value is NormalizedBand {
  if (!isRecord(value)) return false;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  return (
    x === 0 &&
    width === 1 &&
    finite(y) &&
    finite(height) &&
    y >= 0 &&
    height > 0 &&
    y + height <= 1 + 1e-6
  );
}

function validatePlan(plan: HybridRetryPlan): void {
  if (!isRecord(plan) || plan.schemaVersion !== HYBRID_BAND_RETRY_VERSION)
    throw new Error('paddle-plan-schema-invalid');
  if (plan.reason !== 'initial' && plan.reason !== 'repetition-detected')
    throw new Error('paddle-plan-reason-invalid');
  if (
    !finite(plan.overlap) ||
    !finite(plan.bandHeight) ||
    !Number.isSafeInteger(plan.denseObservationThreshold) ||
    plan.overlap < 0 ||
    plan.overlap >= plan.bandHeight ||
    plan.bandHeight <= 0 ||
    plan.bandHeight > 1 ||
    plan.denseObservationThreshold < 1 ||
    !Array.isArray(plan.pages)
  )
    throw new Error('paddle-plan-settings-invalid');
  const seenPages = new Set<number>();
  for (const pageValue of plan.pages as readonly unknown[]) {
    if (!isRecord(pageValue)) throw new Error('paddle-plan-page-invalid');
    const pageIndex = pageValue.pageIndex;
    const pageNumber = pageValue.pageNumber;
    const observationCount = pageValue.observationCount;
    const routeReason = pageValue.routeReason;
    const bands = pageValue.bands;
    if (
      !safeInteger(pageIndex) ||
      pageIndex < 0 ||
      pageNumber !== pageIndex + 1 ||
      !safeInteger(observationCount) ||
      observationCount < 0 ||
      typeof routeReason !== 'string' ||
      !Array.isArray(bands) ||
      bands.some((band) => !validateBand(band))
    ) {
      throw new Error('paddle-plan-page-invalid');
    }
    if (seenPages.has(pageIndex)) throw new Error('paddle-plan-page-duplicate');
    seenPages.add(pageIndex);
    if (plan.reason === 'initial' && bands.length > 0)
      throw new Error('paddle-initial-plan-band-invalid');
    if (plan.reason === 'repetition-detected' && bands.length === 0)
      throw new Error('paddle-retry-plan-band-missing');
  }
}

function attemptsFor(page: HybridFallbackPage): readonly NormalizedBand[] {
  return page.bands.length === 0 ? [{ x: 0, y: 0, width: 1, height: 1 }] : page.bands;
}

function deterministicArgs(
  modelPath: string,
  projectorPath: string,
  imagePath: string,
): readonly string[] {
  return [
    '-m',
    modelPath,
    '--mmproj',
    projectorPath,
    '--image',
    imagePath,
    '-p',
    PADDLE_OCR_VL16_PROMPT,
    '--temp',
    '0',
    '--top-p',
    '1',
    '--top-k',
    '1',
    '--seed',
    '0',
    '-n',
    String(DEFAULT_MAX_TOKENS),
    '--ctx-size',
    String(DEFAULT_CONTEXT_SIZE),
    '--threads',
    '4',
    '--threads-batch',
    '4',
    '--no-warmup',
    '--no-perf',
    '--repeat-penalty',
    '1.15',
    '--jinja',
  ];
}

function createLlamaInference(): PaddleInference {
  return (request) => {
    const child = spawnSync(request.runtimePath, request.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_RAW_RESPONSE_CHARS * 2,
      timeout: MAX_INFERENCE_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        ALYTE_IMPORT_EVALUATION: '1',
        ALYTE_PADDLE_OCR_VL: '1',
      },
    });
    if (child.error || child.status !== 0) throw new Error('paddle-llama-inference-failed');
    return {
      stdout: typeof child.stdout === 'string' ? child.stdout : '',
      stderr: typeof child.stderr === 'string' ? child.stderr : '',
    };
  };
}

function pngDimensions(path: string): { readonly width: number; readonly height: number } {
  const header = readFileSync(path).subarray(0, 24);
  if (
    header.length < 24 ||
    !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.readUInt32BE(8) !== 13 ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('paddle-render-png-invalid');
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('paddle-render-png-empty');
  return { width, height };
}

function popplerVersion(path: string): string {
  const result = spawnSync(path, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const output = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`;
  const match = output.match(/pdftoppm version ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/u);
  if (result.error || match === null) throw new Error('paddle-renderer-version-failed');
  return match[1];
}

function cropPixels(
  band: NormalizedBand,
  width: number,
  height: number,
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const left = Math.round(band.x * width);
  const top = Math.round(band.y * height);
  const right = Math.round((band.x + band.width) * width);
  const bottom = Math.round((band.y + band.height) * height);
  const cropWidth = Math.max(1, right - left);
  const cropHeight = Math.max(1, bottom - top);
  if (left < 0 || top < 0 || right > width || bottom > height) {
    throw new Error('paddle-render-crop-out-of-bounds');
  }
  return { left, top, width: cropWidth, height: cropHeight };
}

function createPopplerRenderer(options: {
  readonly privateRoot: string;
  readonly rendererPath?: string;
}): PaddleRendererDescriptor {
  const rendererPath = realpathSync(
    resolve(options.rendererPath ?? process.env.ALYTE_PADDLE_RENDERER ?? DEFAULT_RENDERER_PATH),
  );
  existingFile(rendererPath, 'paddle-renderer-missing');
  const cropToolPath = realpathSync(resolve(DEFAULT_CROP_TOOL_PATH));
  existingFile(cropToolPath, 'paddle-render-crop-tool-missing');
  const provenance: PaddleRendererProvenance = {
    kind: 'poppler-pdftoppm',
    path: rendererPath,
    version: popplerVersion(rendererPath),
    sha256: hash(rendererPath, 'renderer'),
    cropToolPath,
    cropToolSha256: hash(cropToolPath, 'crop-tool'),
    config: {
      format: 'png',
      dpi: null,
      targetHeightPixels: PADDLE_OCR_VL16_RENDER_HEIGHT,
      pageNumbering: 'one-based',
      crop: 'normalized-top-left',
    },
  };
  return {
    provenance,
    render: (request) => {
      assertPrivatePath(request.reportPath, request.privateRoot);
      assertPrivatePath(request.outputPath, request.privateRoot);
      ensurePrivateDirectory(dirname(request.outputPath));
      const scratchDirectory = join(request.privateRoot, 'rendered', 'paddleocr-vl16');
      ensurePrivateDirectory(scratchDirectory);
      const scratchPrefix = join(
        scratchDirectory,
        `page-${request.pageIndex + 1}-attempt-${request.attemptIndex}`,
      );
      const scratchOutput = `${scratchPrefix}.png`;
      const child = spawnSync(
        rendererPath,
        [
          '-f',
          String(request.pageIndex + 1),
          '-l',
          String(request.pageIndex + 1),
          '-scale-to-y',
          String(PADDLE_OCR_VL16_RENDER_HEIGHT),
          '-scale-to-x',
          '-1',
          '-png',
          '-singlefile',
          request.reportPath,
          scratchPrefix,
        ],
        { stdio: 'ignore' },
      );
      if (child.error || child.status !== 0 || !existsSync(scratchOutput)) {
        throw new Error('paddle-render-failed');
      }
      assertPrivatePath(scratchOutput, request.privateRoot);
      securePrivateFile(scratchOutput);
      const full = pngDimensions(scratchOutput);
      const crop = cropPixels(request.band, full.width, full.height);
      assertPrivatePath(request.outputPath, request.privateRoot);
      if (
        crop.left === 0 &&
        crop.top === 0 &&
        crop.width === full.width &&
        crop.height === full.height
      ) {
        renameSync(scratchOutput, request.outputPath);
      } else {
        const cropped = spawnSync(
          cropToolPath,
          [
            scratchOutput,
            '-crop',
            `${crop.width}x${crop.height}+${crop.left}+${crop.top}`,
            '+repage',
            request.outputPath,
          ],
          { stdio: 'ignore' },
        );
        unlinkSync(scratchOutput);
        if (cropped.error || cropped.status !== 0 || !existsSync(request.outputPath)) {
          throw new Error('paddle-render-crop-failed');
        }
      }
      assertPrivatePath(request.outputPath, request.privateRoot);
      securePrivateFile(request.outputPath);
      if (statSync(request.outputPath).size <= 0) throw new Error('paddle-render-empty');
      const dimensions = pngDimensions(request.outputPath);
      return { imagePath: request.outputPath, ...dimensions };
    },
  };
}

function createCustomHelperRenderer(options: {
  readonly privateRoot: string;
  readonly renderHelperPath: string;
}): PaddleRendererDescriptor {
  const helper = resolve(options.renderHelperPath);
  existingFile(helper, 'paddle-render-helper-missing');
  return {
    provenance: {
      kind: 'custom-helper',
      path: helper,
      version: null,
      sha256: hash(helper, 'render-helper'),
      cropToolPath: null,
      cropToolSha256: null,
      config: {
        format: 'jpeg',
        dpi: null,
        targetHeightPixels: null,
        pageNumbering: 'one-based',
        crop: 'normalized-top-left',
      },
    },
    render: (request) => {
      assertPrivatePath(request.reportPath, request.privateRoot);
      assertPrivatePath(request.outputPath, request.privateRoot);
      ensurePrivateDirectory(dirname(request.outputPath));
      const child = spawnSync(
        helper,
        [
          '--report',
          request.reportPath,
          '--page',
          String(request.pageIndex),
          '--rect',
          `${request.band.x},${request.band.y},${request.band.width},${request.band.height}`,
          '--output',
          request.outputPath,
          '--private-root',
          request.privateRoot,
        ],
        { stdio: 'ignore' },
      );
      if (child.error || child.status !== 0 || !existsSync(request.outputPath))
        throw new Error('paddle-render-failed');
      assertPrivatePath(request.outputPath, request.privateRoot);
      securePrivateFile(request.outputPath);
      if (statSync(request.outputPath).size <= 0) throw new Error('paddle-render-empty');
      return { imagePath: request.outputPath, width: 0, height: 0 };
    },
  };
}

function rawDirectory(root: string, id: string, retry: boolean): string {
  const path = join(root, 'raw', 'paddleocr-vl16-runtime', id, retry ? 'retry' : 'initial');
  ensurePrivateDirectory(path);
  return path;
}

function rawPath(root: string, id: string, retry: boolean, page: number, attempt: number): string {
  const directory = join(rawDirectory(root, id, retry), `page-${page}`);
  ensurePrivateDirectory(directory);
  const tag = retry ? `band${attempt + 1}` : 'full';
  return join(directory, `paddleocr-vl16-q8-${id}-page${String(page)}-${tag}-v1.raw.txt`);
}

function stderrPath(stdoutPath: string): string {
  return stdoutPath.replace(/\.raw\.txt$/u, '.stderr.txt');
}

function repeatedBlock(lines: readonly string[]): boolean {
  if (lines.length < 6) return false;
  const normalized = lines.map((line) =>
    line.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(),
  );
  for (let size = 2; size <= Math.floor(normalized.length / 2); size += 1) {
    if (normalized.slice(0, size).join('\n') === normalized.slice(size, size * 2).join('\n'))
      return true;
  }
  return false;
}

function responseIsPathological(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    raw.length > MAX_RAW_RESPONSE_CHARS ||
    lines.length > MAX_RAW_LINES ||
    lines.some((line) => line.length > MAX_RAW_LINE_CHARS) ||
    repeatedBlock(lines)
  );
}

function emptyBasePipeline(reportId: string, reportSha256: string): PipelineResult {
  return {
    schemaVersion: IMPORT_EVALUATION_SCHEMA_VERSION,
    reportId,
    reportSha256,
    pipeline: {
      id: 'paddleocr-vl16',
      version: 'paddleocr-vl16-text-adapter.v2',
      configuration: { source: 'no-admitted-paddleocr-responses', groundTruthAccess: false },
      runtime: { node: process.version, platform: `${process.platform}-${process.arch}` },
    },
    stages: [],
    elapsedMs: 0,
    measurements: [],
    diagnostics: {
      counts: {},
      limitations: ['No non-pathological PaddleOCR-VL response was admitted.'],
    },
  };
}

function wrapPipeline(options: {
  readonly base: PipelineResult;
  readonly reportId: string;
  readonly reportSha256: string;
  readonly retry: boolean;
  readonly plan: HybridRetryPlan;
  readonly modelSha256: string | null;
  readonly projectorSha256: string | null;
  readonly runtimeSha256: string | null;
  readonly renderHelperSha256: string | null;
  readonly renderer: PaddleRendererProvenance;
  readonly rawFiles: readonly string[];
  readonly pageTimings: readonly PaddlePageTiming[];
  readonly attemptTimings: readonly PaddleAttemptTiming[];
  readonly repetitionDetectedPageIndexes: readonly number[];
  readonly stageTimings: {
    readonly renderMs: number;
    readonly inferenceMs: number;
    readonly pathologyMs: number;
  };
  readonly counts: Readonly<Record<string, number>>;
  readonly elapsedMs: number;
}): PipelineResult {
  const baseConfig = options.base.pipeline.configuration;
  const baseRuntime = options.base.pipeline.runtime;
  return {
    ...options.base,
    reportId: options.reportId,
    reportSha256: options.reportSha256,
    pipeline: {
      id: options.base.pipeline.id,
      version: PADDLE_OCR_VL16_RUNTIME_PIPELINE_VERSION,
      configuration: {
        ...baseConfig,
        seamVersion: PADDLE_OCR_VL_SEAM_VERSION,
        adapterVersion: PADDLE_OCR_VL16_RUNTIME_ADAPTER_VERSION,
        model: 'PaddleOCR-VL-1.6',
        modelFormat: 'GGUF',
        quantization: 'Q8',
        modelSha256: options.modelSha256,
        projectorSha256: options.projectorSha256,
        runtime: 'llama-mtmd-cli',
        runtimeSha256: options.runtimeSha256,
        renderHelperSha256: options.renderHelperSha256,
        renderer: options.renderer.kind,
        rendererPath: options.renderer.path,
        rendererVersion: options.renderer.version,
        rendererSha256: options.renderer.sha256,
        rendererCropToolPath: options.renderer.cropToolPath,
        rendererCropToolSha256: options.renderer.cropToolSha256,
        renderConfig: options.renderer.config,
        prompt: PADDLE_OCR_VL16_PROMPT,
        deterministicDecoder: {
          temperature: 0,
          topP: 1,
          topK: 1,
          seed: 0,
          contextSize: DEFAULT_CONTEXT_SIZE,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
        retry: options.retry,
        retryPlanReason: options.plan.reason,
        plannedPageIndexes: options.plan.pages.map((page) => page.pageIndex),
        rawResponseFiles: options.rawFiles.map((file) => basename(file)),
        pageTimings: options.pageTimings,
        attemptTimings: options.attemptTimings,
        repetitionDetectedPageIndexes: options.repetitionDetectedPageIndexes,
        retryPageIndexes: options.repetitionDetectedPageIndexes,
        groundTruthAccess: false,
      },
      runtime: {
        ...baseRuntime,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        adapter: 'local-render-then-llama-mtmd',
        modelRuntime: 'llama-mtmd-cli',
      },
    },
    stages: [
      ...options.base.stages,
      {
        name: 'paddle-local-pdf-render',
        elapsedMs: options.stageTimings.renderMs,
        inputCount: options.plan.pages.reduce(
          (sum, page) => sum + Math.max(1, page.bands.length),
          0,
        ),
        outputCount: options.counts.renderedImages ?? 0,
        status: (options.counts.renderFailures ?? 0) > 0 ? 'partial' : 'complete',
      },
      {
        name: 'paddle-local-llama-mtmd-inference',
        elapsedMs: options.stageTimings.inferenceMs,
        inputCount: options.counts.renderedImages ?? 0,
        outputCount: options.counts.inferenceResponses ?? 0,
        status: (options.counts.inferenceFailures ?? 0) > 0 ? 'partial' : 'complete',
      },
      {
        name: 'paddle-generic-pathology-detection',
        elapsedMs: options.stageTimings.pathologyMs,
        inputCount: options.counts.inferenceResponses ?? 0,
        outputCount: options.repetitionDetectedPageIndexes.length,
        status: 'complete',
      },
    ],
    elapsedMs: options.elapsedMs,
    diagnostics: {
      counts: {
        ...options.base.diagnostics.counts,
        ...options.counts,
        repetitionDetectedPages: options.repetitionDetectedPageIndexes.length,
      },
      limitations: [
        ...options.base.diagnostics.limitations,
        'The local model receives only rendered pages or the overlapping bands in the private retry plan.',
        'Model output is parsed by the proven PaddleOCR-VL v2 structural adapter before scoring.',
        'Full-page responses marked repetitive or pathological are omitted from the parser input and replaced by overlapping retry bands.',
        'The runtime adapter does not consult ground truth, perform mapping, or perform unit conversion.',
      ],
    },
  };
}

/** Run local rendering and PaddleOCR-VL inference with injectable seams for synthetic tests. */
export async function runPaddleOcrV16Runtime(
  options: PaddleRuntimeAdapterOptions,
): Promise<PaddleRuntimeAdapterResult> {
  const id = reportId(options.reportId);
  validatePlan(options.plan);
  const privateRoot = resolve(options.privateRoot);
  ensurePrivateDirectory(privateRoot);
  const reportPath = assertPrivatePath(resolve(options.reportPath), privateRoot);
  const outputPath = assertPrivatePath(resolve(options.outputPath), privateRoot);
  existingFile(reportPath, 'paddle-report-missing');
  if (options.modelPath === null && options.infer === undefined)
    throw new Error('paddle-model-required');
  if (options.projectorPath === null && options.infer === undefined)
    throw new Error('paddle-projector-required');
  if (options.runtimePath === null && options.infer === undefined)
    throw new Error('paddle-runtime-required');
  const reportSha256 = sha256File(reportPath);
  const modelSha256 = hash(options.modelPath, 'model');
  const projectorSha256 = hash(options.projectorPath, 'projector');
  const runtimeSha256 = hash(options.runtimePath, 'runtime');
  const rendererDescriptor: PaddleRendererDescriptor =
    options.renderer === undefined
      ? options.renderHelperPath === undefined
        ? createPopplerRenderer({ privateRoot, rendererPath: options.rendererPath })
        : createCustomHelperRenderer({
            privateRoot,
            renderHelperPath: options.renderHelperPath,
          })
      : {
          render: options.renderer,
          provenance: {
            kind: 'injected',
            path: null,
            version: null,
            sha256: null,
            cropToolPath: null,
            cropToolSha256: null,
            config: {
              format: 'png',
              dpi: null,
              targetHeightPixels: null,
              pageNumbering: 'one-based',
              crop: 'normalized-top-left',
            },
          },
        };
  const renderer = rendererDescriptor.render;
  const renderHelperSha256 =
    rendererDescriptor.provenance.kind === 'custom-helper'
      ? rendererDescriptor.provenance.sha256
      : null;
  const infer = options.infer ?? createLlamaInference();
  const started = performance.now();
  const attemptTimings: PaddleAttemptTiming[] = [];
  const pageTimings: PaddlePageTiming[] = [];
  const acceptedRaw: { readonly page: number; readonly path: string }[] = [];
  const repeatedPages = new Set<number>();
  const counts: Record<string, number> = {
    plannedPages: options.plan.pages.length,
    plannedAttempts: options.plan.pages.reduce(
      (sum, page) => sum + Math.max(1, page.bands.length),
      0,
    ),
    renderedImages: 0,
    renderFailures: 0,
    inferenceResponses: 0,
    inferenceFailures: 0,
    pathologicalResponses: 0,
    parsedRows: 0,
  };
  let inferenceElapsedMs = 0;
  let pathologyElapsedMs = 0;
  let renderElapsedMs = 0;

  for (const page of options.plan.pages) {
    const pageStarted = performance.now();
    let pageSuccesses = 0;
    for (const [attemptIndex, band] of attemptsFor(page).entries()) {
      const attemptStarted = performance.now();
      const stdoutPath = rawPath(privateRoot, id, options.retry, page.pageNumber, attemptIndex);
      const imagePath = stdoutPath.replace(
        /\.raw\.txt$/u,
        rendererDescriptor.provenance.config.format === 'jpeg' ? '.jpg' : '.png',
      );
      let status: PaddleAttemptTiming['status'] = 'complete';
      let renderedPath: string | null = null;
      try {
        const renderAttemptStarted = performance.now();
        const rendered = await renderer({
          reportPath,
          privateRoot,
          pageIndex: page.pageIndex,
          attemptIndex,
          band,
          outputPath: imagePath,
        });
        renderedPath = assertPrivatePath(resolve(rendered.imagePath), privateRoot);
        existingFile(renderedPath, 'paddle-rendered-image-missing');
        securePrivateFile(renderedPath);
        renderElapsedMs += Math.max(0, Math.round(performance.now() - renderAttemptStarted));
        counts.renderedImages += 1;
        const modelPath = options.modelPath ?? '';
        const projectorPath = options.projectorPath ?? '';
        const runtimePath = options.runtimePath ?? '';
        const inferenceStarted = performance.now();
        let inference: PaddleInferenceResult;
        try {
          inference = await infer({
            reportId: id,
            privateRoot,
            pageIndex: page.pageIndex,
            attemptIndex,
            imagePath: renderedPath,
            modelPath,
            projectorPath,
            runtimePath,
            prompt: PADDLE_OCR_VL16_PROMPT,
            args: deterministicArgs(modelPath, projectorPath, renderedPath),
          });
        } finally {
          inferenceElapsedMs += Math.max(0, Math.round(performance.now() - inferenceStarted));
        }
        counts.inferenceResponses += 1;
        const raw = typeof inference.stdout === 'string' ? inference.stdout : '';
        const stderr = typeof inference.stderr === 'string' ? inference.stderr : '';
        writePrivateTextFile(stdoutPath, raw);
        writePrivateTextFile(stderrPath(stdoutPath), stderr);
        const pathologyStarted = performance.now();
        const parsed = parsePaddleOcrPage(raw, page.pageNumber);
        counts.parsedRows += parsed.measurements.length;
        const pathological = responseIsPathological(raw);
        pathologyElapsedMs += Math.max(0, Math.round(performance.now() - pathologyStarted));
        if (pathological) {
          status = 'pathological';
          counts.pathologicalResponses += 1;
          repeatedPages.add(page.pageIndex);
        } else {
          acceptedRaw.push({ page: page.pageNumber, path: stdoutPath });
          pageSuccesses += 1;
        }
      } catch {
        if (renderedPath === null) {
          status = 'render-failed';
          counts.renderFailures += 1;
        } else {
          status = 'inference-failed';
          counts.inferenceFailures += 1;
        }
      }
      attemptTimings.push({
        pageIndex: page.pageIndex,
        attemptIndex,
        band,
        elapsedMs: Math.max(0, Math.round(performance.now() - attemptStarted)),
        status,
      });
    }
    const pageAttempts = attemptsFor(page).length;
    const pageStatuses = attemptTimings.filter((timing) => timing.pageIndex === page.pageIndex);
    const failed = pageStatuses.filter(
      (timing) => timing.status === 'render-failed' || timing.status === 'inference-failed',
    ).length;
    pageTimings.push({
      pageIndex: page.pageIndex,
      elapsedMs: Math.max(0, Math.round(performance.now() - pageStarted)),
      attempts: pageAttempts,
      status: pageSuccesses === 0 ? 'failed' : failed > 0 ? 'partial' : 'complete',
    });
  }
  const base =
    acceptedRaw.length === 0
      ? emptyBasePipeline(id, reportSha256)
      : runPaddleOcrAdapter({
          reportPath,
          reportId: id,
          outputPath,
          privateRoot,
          rawPaths: acceptedRaw,
        });
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  counts.acceptedRawResponses = acceptedRaw.length;
  counts.omittedPathologicalResponses = counts.pathologicalResponses;
  counts.uniqueRows = base.measurements.length;
  const wrapped = wrapPipeline({
    base,
    reportId: id,
    reportSha256,
    retry: options.retry,
    plan: options.plan,
    modelSha256,
    projectorSha256,
    runtimeSha256,
    renderHelperSha256,
    renderer: rendererDescriptor.provenance,
    rawFiles: acceptedRaw.map((item) => item.path),
    pageTimings,
    attemptTimings,
    repetitionDetectedPageIndexes: [...repeatedPages].toSorted((left, right) => left - right),
    stageTimings: {
      renderMs: renderElapsedMs,
      inferenceMs: inferenceElapsedMs,
      pathologyMs: pathologyElapsedMs,
    },
    counts,
    elapsedMs,
  });
  if (sha256File(reportPath) !== reportSha256) throw new Error('paddle-report-mutated');
  ensurePrivateDirectory(dirname(outputPath));
  writeJsonFile(outputPath, wrapped);
  securePrivateFile(outputPath);
  const checked = parsePipelineResult(JSON.parse(readFileSync(outputPath, 'utf8')) as unknown);
  return {
    pipeline: checked,
    pageTimings,
    attemptTimings,
    repetitionDetectedPageIndexes: [...repeatedPages].toSorted((left, right) => left - right),
  };
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function requiredArgument(args: readonly string[], name: string): string {
  const value = argument(args, name);
  if (value === undefined) throw new Error(`paddle-${name.slice(2)}-missing`);
  return value;
}

function loadPlan(path: string, privateRoot: string): HybridRetryPlan {
  const absolute = assertPrivatePath(resolve(path), privateRoot);
  existingFile(absolute, 'paddle-plan-missing');
  securePrivateFile(absolute);
  const decoded = JSON.parse(readFileSync(absolute, 'utf8')) as HybridRetryPlan;
  validatePlan(decoded);
  return decoded;
}

function main(): void {
  const args = process.argv.slice(2);
  const privateRoot = resolve(requiredArgument(args, '--private-root'));
  const reportPath = resolve(requiredArgument(args, '--report'));
  const id = requiredArgument(args, '--report-id');
  const outputPath = resolve(requiredArgument(args, '--output'));
  const planPath = resolve(requiredArgument(args, '--plan'));
  const seamVersion = requiredArgument(args, '--seam-version');
  if (seamVersion !== PADDLE_OCR_VL_SEAM_VERSION) throw new Error('paddle-seam-version-invalid');
  const retry = requiredArgument(args, '--retry');
  if (retry !== '0' && retry !== '1') throw new Error('paddle-retry-invalid');
  const modelPath = argument(args, '--model') ?? process.env.ALYTE_PADDLE_MODEL ?? null;
  const projectorPath = argument(args, '--projector') ?? process.env.ALYTE_PADDLE_PROJECTOR ?? null;
  const runtimePath =
    argument(args, '--runtime') ?? process.env.ALYTE_PADDLE_RUNTIME ?? DEFAULT_RUNTIME_PATH;
  const renderHelperPath = argument(args, '--render-helper');
  const plan = loadPlan(planPath, privateRoot);
  const run = runPaddleOcrV16Runtime({
    reportPath,
    reportId: id,
    privateRoot,
    outputPath,
    plan,
    retry: retry === '1',
    modelPath,
    projectorPath,
    runtimePath,
    ...(renderHelperPath === undefined ? {} : { renderHelperPath }),
  });
  void run
    .then((value) => {
      process.stdout.write(
        `${JSON.stringify({
          reportId: value.pipeline.reportId,
          pages: value.pipeline.diagnostics.counts.plannedPages ?? 0,
          attempts: value.pipeline.diagnostics.counts.plannedAttempts ?? 0,
          rows: value.pipeline.measurements.length,
          repetitionDetectedPages: value.repetitionDetectedPageIndexes.length,
          elapsedMs: value.pipeline.elapsedMs,
        })}\n`,
      );
    })
    .catch(() => {
      process.stderr.write('paddle-runtime-adapter-failed\n');
      process.exitCode = 1;
    });
}

if (process.argv[1]?.endsWith('/paddleocr-vl16-runtime-adapter.ts') === true) main();
