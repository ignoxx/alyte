/**
 * Private macOS adapter for the production document VLM contract.
 *
 * This file deliberately owns the platform seam only. The prompt and decoder come from the
 * production adapter so an experiment cannot silently become a second document-model contract.
 * The llama.cpp CLI is an external, local executable; it is never added to the app dependency
 * graph and this adapter never sends an image or model output over the network.
 */

import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import type { LocalModelService } from '../../apps/mobile/src/features/local-models/native';
import { productionLocalModelManifest } from '../../apps/mobile/src/features/local-models/production-manifest.generated';
import {
  createDocumentVLMPrompt,
  createLocalDocumentVLM,
  decodeDocumentVLMRows,
  DOCUMENT_VLM_PROMPT_VERSION,
  DOCUMENT_VLM_SCHEMA_VERSION,
  type DocumentVLMExtractor,
  type DocumentVLMRow,
} from '../../apps/mobile/src/features/local-models/document-vlm';
import { createEvaluationDocumentVLM } from './evaluation-document-vlm';

// Keep the private runner's public seam tied to the exact production exports.
export {
  createDocumentVLMPrompt,
  decodeDocumentVLMRows,
  DOCUMENT_VLM_PROMPT_VERSION,
  DOCUMENT_VLM_SCHEMA_VERSION,
};

const execFileAsync = promisify(execFile);

export const QWEN_MAC_ADAPTER_VERSION = 'alyte.qwen3-vl.document-extractor.mac-cli.v2' as const;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const DEFAULT_CONTEXT_TOKENS = 4_096;
const MAX_SUPPORTED_OUTPUT_TOKENS = 16_384;
const MAX_SUPPORTED_CONTEXT_TOKENS = 32_768;
export const DEFAULT_PRIVATE_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../.scratch/import-evaluation',
);
export const DEFAULT_BINARY = '/opt/homebrew/bin/llama-mtmd-cli';
export const DEFAULT_MODEL = join(
  homedir(),
  '.cache/alyte-private-eval/models/qwen3-vl-2b-instruct-52d6c8f',
  'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
);
export const DEFAULT_MMPROJ = join(
  homedir(),
  '.cache/alyte-private-eval/models/qwen3-vl-2b-instruct-52d6c8f',
  'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
);

type RuntimeVersion = {
  readonly binary: string;
  readonly binarySha256: string;
  readonly version: string | null;
  readonly node: string;
  readonly os: string;
  readonly arch: string;
};

export type QwenMacPaths = {
  readonly privateRoot: string;
  readonly binary: string;
  readonly model: string;
  readonly mmproj: string;
};

export type QwenMacProvenance = {
  readonly adapterVersion: string;
  readonly schemaVersion: typeof DOCUMENT_VLM_SCHEMA_VERSION;
  readonly promptVersion: typeof DOCUMENT_VLM_PROMPT_VERSION;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly modelSha256: string;
  readonly modelExpectedSha256: string;
  readonly projectorSha256: string;
  readonly projectorExpectedSha256: string;
  readonly runtimeRevision: string;
  readonly cliConfiguration: {
    readonly device: 'auto' | 'none';
    readonly contextTokens: number;
    readonly imageTokens: 1024;
    readonly batchTokens: 256;
    readonly threads: 4;
    readonly maxOutputTokens: number;
    readonly extractorMode: 'production' | 'evaluation-only';
    readonly deterministicSampling: 'temperature-zero';
    readonly computeMode: 'gpu-preferred' | 'cpu-only';
  };
  readonly runtime: RuntimeVersion;
};

export type QwenMacProvenanceOverrides = {
  readonly adapterVersion?: string;
  readonly modelId?: string;
  readonly modelRevision?: string;
  readonly modelExpectedSha256?: string;
  readonly projectorExpectedSha256?: string;
  readonly runtimeRevision?: string;
};

export type QwenMacPageResult = {
  readonly pageIndex: number;
  readonly rows: readonly DocumentVLMRow[];
  readonly elapsedMs: number;
  readonly provenance: QwenMacProvenance;
};

export type QwenMacOptions = {
  readonly paths?: Partial<QwenMacPaths>;
  readonly provenance?: QwenMacProvenanceOverrides;
  readonly timeoutMs?: number;
  readonly recoveryTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  /** Evaluation-only context override; the production default remains 4096. */
  readonly contextTokens?: number;
  readonly computeMode?: 'gpu-preferred' | 'cpu-only';
  /** Evaluation-only hook invoked before the strict production decoder sees the raw response. */
  readonly onRawOutput?: (raw: string) => void;
};

function boundedError(category: string): Error {
  return new Error(`qwen-mac-${category}`);
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpathWithNearestExisting(path: string): string {
  const unresolved: string[] = [];
  let current = resolve(path);
  while (true) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw boundedError('private-path');
      }
      const parent = dirname(current);
      if (parent === current) return current;
      unresolved.unshift(basename(current));
      current = parent;
      continue;
    }
    if (stats.isSymbolicLink()) {
      try {
        return resolve(realpathSync(current), ...unresolved);
      } catch {
        throw boundedError('private-path-symlink');
      }
    }
    return resolve(realpathSync(current), ...unresolved);
  }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function ensurePrivateFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Resolve and realpath-check private evaluation artifacts before spawning a process. */
export function assertPrivateEvaluationPath(
  candidate: string,
  privateRoot: string,
  kind: 'input' | 'output',
): string {
  const root = resolve(privateRoot);
  const rootReal = realpathWithNearestExisting(root);
  const resolved = resolve(candidate);
  if (!pathInside(root, resolved)) throw boundedError(`${kind}-outside-private-root`);
  const candidateReal = realpathWithNearestExisting(resolved);
  if (!pathInside(rootReal, candidateReal)) throw boundedError(`${kind}-symlink-escape`);
  if (kind === 'output') {
    if (extname(resolved) !== '.json') throw boundedError('output-extension');
    if (existsSync(resolved) && !statSync(resolved).isFile()) {
      throw boundedError('output-not-file');
    }
  } else {
    if (!existsSync(resolved)) throw boundedError('input-missing');
    if (!statSync(resolved).isFile()) throw boundedError('input-not-file');
    chmodSync(resolved, 0o600);
  }
  return resolved;
}

/** Validate an adapter-created private artifact before creating its parent path. */
function assertPrivateGeneratedPath(candidate: string, privateRoot: string): string {
  const root = resolve(privateRoot);
  const rootReal = realpathWithNearestExisting(root);
  const resolved = resolve(candidate);
  if (!pathInside(root, resolved)) throw boundedError('generated-outside-private-root');
  const candidateReal = realpathWithNearestExisting(resolved);
  if (!pathInside(rootReal, candidateReal)) throw boundedError('generated-symlink-escape');
  return resolved;
}

function assertRegularFile(path: string, category: string): string {
  if (!existsSync(path)) throw boundedError(`${category}-missing`);
  try {
    if (!statSync(path).isFile()) throw boundedError(`${category}-not-file`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('qwen-mac-')) throw error;
    throw boundedError(`${category}-unreadable`);
  }
  return path;
}

function defaultPaths(overrides: Partial<QwenMacPaths> = {}): QwenMacPaths {
  return {
    privateRoot: resolve(
      overrides.privateRoot ?? process.env.ALYTE_EVAL_PRIVATE_ROOT ?? DEFAULT_PRIVATE_ROOT,
    ),
    binary: resolve(overrides.binary ?? process.env.ALYTE_EVAL_QWEN_BINARY ?? DEFAULT_BINARY),
    model: resolve(overrides.model ?? process.env.ALYTE_EVAL_QWEN_MODEL ?? DEFAULT_MODEL),
    mmproj: resolve(overrides.mmproj ?? process.env.ALYTE_EVAL_QWEN_MMPROJ ?? DEFAULT_MMPROJ),
  };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

function boundedVersionOutput(value: string): string | null {
  const text = value.trim().replace(/\s+/gu, ' ');
  if (text.length === 0) return null;
  return text.slice(0, 512);
}

async function binaryVersion(binary: string): Promise<string | null> {
  try {
    const result = await execFileAsync(binary, ['--version'], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    return boundedVersionOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } catch (error) {
    const result = error as { readonly stdout?: string; readonly stderr?: string };
    return boundedVersionOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}

/** Extract the exact grammar shipped with the iOS runtime rather than maintaining a second one. */
export function readProductionDocumentGrammar(): string {
  const path = resolve(
    dirname(new URL(import.meta.url).pathname),
    '../../apps/mobile/modules/alyte-local-models/ios/AlyteDocumentVLMGrammar.swift',
  );
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    throw boundedError('production-grammar-missing');
  }
  const match = source.match(/static let root = #"""([\s\S]*?)"""#/u);
  if (match === null) throw boundedError('production-grammar-invalid');
  const grammar = match[1]!.replace(/^\n/u, '').replace(/\n$/u, '');
  if (!grammar.startsWith('root ::=') || !grammar.includes('reference_interval')) {
    throw boundedError('production-grammar-invalid');
  }
  return grammar;
}

async function createProvenance(
  paths: QwenMacPaths,
  computeMode: 'gpu-preferred' | 'cpu-only',
  limits: { readonly contextTokens: number; readonly maxOutputTokens: number },
  overrides: QwenMacProvenanceOverrides = {},
): Promise<QwenMacProvenance> {
  const [binarySha256, modelSha256, projectorSha256, version] = await Promise.all([
    sha256File(paths.binary),
    sha256File(paths.model),
    sha256File(paths.mmproj),
    binaryVersion(paths.binary),
  ]);
  const modelExpectedSha256 =
    overrides.modelExpectedSha256 ?? productionLocalModelManifest.pack.artifact.sha256;
  const projectorExpectedSha256 =
    overrides.projectorExpectedSha256 ?? productionLocalModelManifest.pack.projector.sha256;
  if (modelSha256 !== modelExpectedSha256) throw boundedError('model-hash-mismatch');
  if (projectorSha256 !== projectorExpectedSha256) throw boundedError('projector-hash-mismatch');
  return {
    adapterVersion: overrides.adapterVersion ?? QWEN_MAC_ADAPTER_VERSION,
    schemaVersion: DOCUMENT_VLM_SCHEMA_VERSION,
    promptVersion: DOCUMENT_VLM_PROMPT_VERSION,
    modelId: overrides.modelId ?? productionLocalModelManifest.pack.id,
    modelRevision: overrides.modelRevision ?? productionLocalModelManifest.pack.artifact.revision,
    modelSha256,
    modelExpectedSha256,
    projectorSha256,
    projectorExpectedSha256,
    runtimeRevision: overrides.runtimeRevision ?? productionLocalModelManifest.runtime.revision,
    cliConfiguration: {
      device: computeMode === 'cpu-only' ? 'none' : 'auto',
      contextTokens: limits.contextTokens,
      imageTokens: 1024,
      batchTokens: 256,
      threads: 4,
      maxOutputTokens: limits.maxOutputTokens,
      extractorMode:
        limits.maxOutputTokens > DEFAULT_MAX_OUTPUT_TOKENS ? 'evaluation-only' : 'production',
      deterministicSampling: 'temperature-zero',
      computeMode,
    },
    runtime: {
      binary: paths.binary,
      binarySha256,
      version,
      node: process.version,
      os: `${process.platform} ${process.release.name}`,
      arch: process.arch,
    },
  };
}

function imagePathFromURI(imageURI: string, privateRoot: string): string {
  if (!imageURI.startsWith('file://')) throw boundedError('image-uri');
  let path: string;
  try {
    path = decodeURIComponent(imageURI.slice('file://'.length));
  } catch {
    throw boundedError('image-uri');
  }
  return assertPrivateEvaluationPath(path, privateRoot, 'input');
}

function writeGrammar(privateRoot: string): string {
  const grammarPath = assertPrivateGeneratedPath(
    join(privateRoot, 'raw', 'qwen3-vl-document-vlm.gbnf'),
    privateRoot,
  );
  ensurePrivateDirectory(dirname(grammarPath));
  ensurePrivateFile(grammarPath, `${readProductionDocumentGrammar()}\n`);
  return grammarPath;
}

type SpawnRequest = {
  readonly paths: QwenMacPaths;
  readonly grammarPath: string;
  readonly promptPath: string;
  readonly imagePath: string;
  readonly maxOutputTokens: number;
  readonly contextTokens: number;
  readonly timeoutMs: number;
  readonly computeMode: 'gpu-preferred' | 'cpu-only';
  readonly cancel: () => void;
};

function invokeCli(request: Omit<SpawnRequest, 'cancel'>): {
  readonly promise: Promise<string>;
  readonly cancel: () => void;
} {
  const args = [
    '--model',
    request.paths.model,
    '--mmproj',
    request.paths.mmproj,
    '--image',
    request.imagePath,
    '--file',
    request.promptPath,
    '--n-predict',
    String(request.maxOutputTokens),
    '--grammar-file',
    request.grammarPath,
    '--temp',
    '0',
    '--ctx-size',
    String(request.contextTokens),
    '--batch-size',
    '256',
    '--ubatch-size',
    '256',
    '--threads',
    '4',
    '--threads-batch',
    '4',
    '--image-min-tokens',
    '1024',
    '--image-max-tokens',
    '1024',
    '--no-warmup',
    '--no-perf',
    '--no-jinja',
  ] as const;
  const backendArgs =
    request.computeMode === 'cpu-only'
      ? (['--device', 'none', '--no-mmproj-offload'] as const)
      : ([] as const);
  let child: ChildProcess | null = null;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (settled || child === null) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!settled) child?.kill('SIGKILL');
    }, 1_000);
  };
  const promise = new Promise<string>((resolveOutput, rejectOutput) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child = spawn(request.paths.binary, [...args, ...backendArgs], {
      cwd: request.paths.privateRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('error', () => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      rejectOutput(boundedError('runtime-start'));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const total = stdout.reduce((sum, item) => sum + item.length, 0) + chunk.length;
      if (total <= 131_072) stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) + chunk.length <= 16_384)
        stderr.push(chunk);
    });
    child.once('close', (code, signal) => {
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (signal !== null) {
        rejectOutput(boundedError(signal === 'SIGTERM' ? 'cancelled' : 'runtime-killed'));
      } else if (code !== 0) {
        const rawDirectory = assertPrivateGeneratedPath(
          join(request.paths.privateRoot, 'raw'),
          request.paths.privateRoot,
        );
        ensurePrivateDirectory(rawDirectory);
        ensurePrivateFile(
          join(rawDirectory, 'qwen-last-stderr.txt'),
          Buffer.concat(stderr).toString('utf8').slice(-16_384),
        );
        rejectOutput(boundedError('runtime-failed'));
      } else {
        resolveOutput(Buffer.concat(stdout).toString('utf8'));
      }
    });
  });
  return { promise, cancel };
}

function createMacLocalModelService(
  paths: QwenMacPaths,
  grammarPath: string,
  promptPath: string,
  options: {
    readonly maxOutputTokens: number;
    readonly contextTokens: number;
    readonly timeoutMs: number;
    readonly computeMode: 'gpu-preferred' | 'cpu-only';
    readonly onRawOutput?: (raw: string) => void;
  },
): LocalModelService {
  let loaded = false;
  let activeCancel: (() => void) | null = null;
  const expectedBytes = productionLocalModelManifest.pack.bytes;
  const readyState = () => ({
    packId: productionLocalModelManifest.pack.id,
    state: loaded ? ('loaded' as const) : ('ready' as const),
    bytesReceived: expectedBytes,
    expectedBytes,
    progress: 1,
    failure: null,
    storageBytes: expectedBytes,
    loaded,
  });
  return {
    manifest: productionLocalModelManifest,
    getState: async () => readyState(),
    subscribe: () => () => undefined,
    startDownload: async () => readyState(),
    cancelDownload: async () => readyState(),
    load: async () => {
      assertRegularFile(paths.binary, 'binary');
      assertRegularFile(paths.model, 'model');
      assertRegularFile(paths.mmproj, 'projector');
      loaded = true;
      return readyState();
    },
    infer: async () => {
      throw Object.assign(boundedError('text-inference-unsupported'), { failure: 'incompatible' });
    },
    inferImage: async (prompt, imageURI, limits) => {
      if (!loaded)
        throw Object.assign(boundedError('runtime-unavailable'), { failure: 'unavailable' });
      if (
        !Number.isSafeInteger(limits.maxOutputTokens) ||
        limits.maxOutputTokens < 1 ||
        limits.maxOutputTokens > options.maxOutputTokens
      ) {
        throw Object.assign(boundedError('output-limit-mismatch'), { failure: 'incompatible' });
      }
      const imagePath = imagePathFromURI(imageURI, paths.privateRoot);
      const invocation = invokeCli({
        paths,
        grammarPath,
        promptPath,
        imagePath,
        maxOutputTokens: limits.maxOutputTokens,
        contextTokens: options.contextTokens,
        timeoutMs: options.timeoutMs,
        computeMode: options.computeMode,
      });
      activeCancel = invocation.cancel;
      try {
        const raw = await invocation.promise;
        options.onRawOutput?.(raw);
        return raw;
      } finally {
        activeCancel = null;
      }
    },
    cancelInference: () => activeCancel?.(),
    unload: async () => {
      activeCancel?.();
      loaded = false;
      return readyState();
    },
    deletePack: async () => readyState(),
  };
}

/**
 * Construct the exact production DocumentVLMExtractor over a local llama-mtmd-cli process.
 * The returned extractor is suitable for the baseline harness to use page by page.
 */
export async function createQwenMacDocumentVLM(options: QwenMacOptions = {}): Promise<{
  readonly extractor: DocumentVLMExtractor;
  readonly provenance: QwenMacProvenance;
  readonly paths: QwenMacPaths;
}> {
  const paths = defaultPaths(options.paths);
  assertRegularFile(paths.binary, 'binary');
  assertRegularFile(paths.model, 'model');
  assertRegularFile(paths.mmproj, 'projector');
  ensurePrivateDirectory(paths.privateRoot);
  const grammarPath = writeGrammar(paths.privateRoot);
  const promptPath = assertPrivateGeneratedPath(
    join(paths.privateRoot, 'raw', 'qwen3-vl-document-vlm.prompt.txt'),
    paths.privateRoot,
  );
  ensurePrivateFile(promptPath, createDocumentVLMPrompt());
  const computeMode =
    options.computeMode ??
    (process.env.ALYTE_EVAL_QWEN_CPU_ONLY === '1' ? 'cpu-only' : 'gpu-preferred');
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const contextTokens = options.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > MAX_SUPPORTED_OUTPUT_TOKENS
  ) {
    throw boundedError('output-limit');
  }
  if (
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < DEFAULT_CONTEXT_TOKENS ||
    contextTokens > MAX_SUPPORTED_CONTEXT_TOKENS ||
    maxOutputTokens > contextTokens
  ) {
    throw boundedError('context-limit');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw boundedError('timeout');
  const provenance = await createProvenance(
    paths,
    computeMode,
    { contextTokens, maxOutputTokens },
    options.provenance,
  );
  const models = createMacLocalModelService(paths, grammarPath, promptPath, {
    maxOutputTokens,
    contextTokens,
    timeoutMs,
    computeMode,
    onRawOutput: options.onRawOutput,
  });
  const extractor =
    maxOutputTokens > DEFAULT_MAX_OUTPUT_TOKENS
      ? createEvaluationDocumentVLM({ models, timeoutMs, maxOutputTokens })
      : createLocalDocumentVLM({
          models,
          timeoutMs,
          recoveryTimeoutMs: options.recoveryTimeoutMs,
        });
  return { extractor, provenance, paths };
}

export async function extractQwenMacPage(
  options: QwenMacOptions & {
    readonly image: string;
    readonly pageIndex: number;
    readonly locale?: string;
  },
): Promise<QwenMacPageResult> {
  const started = performance.now();
  const { extractor, provenance, paths } = await createQwenMacDocumentVLM(options);
  await extractor.checkAvailability();
  const lease = await extractor.prepare();
  try {
    const image = assertPrivateEvaluationPath(options.image, paths.privateRoot, 'input');
    const rows = await extractor.extract({
      pageIndex: options.pageIndex,
      imageURI: `file://${encodeURI(image)}`,
      locale: options.locale ?? 'en-US',
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.maxOutputTokens,
    });
    return {
      pageIndex: options.pageIndex,
      rows,
      elapsedMs: performance.now() - started,
      provenance,
    };
  } finally {
    await lease.release();
  }
}

type CliArgs = {
  readonly image: string;
  readonly output: string;
  readonly pageIndex: number;
  readonly locale: string;
  readonly options: QwenMacOptions;
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function cliArgs(): CliArgs {
  const image = argument('--image');
  const output = argument('--output');
  const privateRoot = argument('--private-root');
  if (image === undefined || output === undefined) throw boundedError('arguments');
  const pageIndexText = argument('--page-index') ?? '0';
  const pageIndex = Number(pageIndexText);
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw boundedError('page-index');
  const timeoutMs = Number(argument('--timeout-ms') ?? DEFAULT_TIMEOUT_MS);
  const maxOutputTokens = Number(argument('--max-output-tokens') ?? DEFAULT_MAX_OUTPUT_TOKENS);
  const root = resolve(privateRoot ?? DEFAULT_PRIVATE_ROOT);
  return {
    image: resolve(image),
    output: resolve(output),
    pageIndex,
    locale: argument('--locale') ?? 'en-US',
    options: {
      paths: {
        privateRoot: root,
        binary: argument('--binary'),
        model: argument('--model'),
        mmproj: argument('--mmproj'),
      },
      timeoutMs,
      maxOutputTokens,
      computeMode: process.argv.includes('--cpu-only') ? 'cpu-only' : 'gpu-preferred',
    },
  };
}

async function main(): Promise<void> {
  const args = cliArgs();
  const privateRoot = resolve(args.options.paths?.privateRoot ?? DEFAULT_PRIVATE_ROOT);
  const output = assertPrivateEvaluationPath(args.output, privateRoot, 'output');
  const result = await extractQwenMacPage({
    ...args.options,
    image: args.image,
    pageIndex: args.pageIndex,
    locale: args.locale,
  });
  ensurePrivateDirectory(dirname(output));
  ensurePrivateFile(output, `${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error && /^qwen-mac-[a-z-]+$/u.test(error.message)
        ? error.message
        : 'qwen-mac-failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
