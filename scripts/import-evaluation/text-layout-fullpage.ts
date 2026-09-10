/**
 * Evaluation-only full-report plaintext-layout runner.
 *
 * Poppler supplies the complete selectable text for each page. A local llama-cli process proposes
 * field strings, which remain separate from source-grounded measurements. No ground truth or
 * catalogue filtering is used in the model input.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  readJsonFile,
  sha256File,
  writeJsonFile,
  writePrivateTextFile,
  type PipelineResult,
} from './contract';
import {
  decodeTextFieldProposals,
  groundTextFieldProposals,
  TEXT_FIELD_PROPOSALS_MAIN_GROUNDER,
  TEXT_FIELD_PROPOSALS_PROMPT_VERSION,
  type TextFieldProposal,
} from './text-field-proposals';
import {
  buildNuExtractPrompt,
  decodeNuExtractProposals,
  NUEXTRACT_DEFAULT_MODEL_PATH,
  NUEXTRACT_MODEL_ID,
  NUEXTRACT_MODEL_SHA256,
  NUEXTRACT_PROMPT_PREFIX,
  NUEXTRACT_PROMPT_VERSION,
} from './nuextract-proposals';
import { verifyRawSnapshotBinding, type RawSnapshotEnvelope } from './raw-snapshot-binding';
import type { VisionPage } from './qwen35-grounding';

const SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
const PIPELINE_IDS = {
  qwen35: 'alyte-qwen35-text-layout-full-report',
  nuextract: 'alyte-nuextract-2.0-2b-text-layout-full-report',
} as const;
const PIPELINE_VERSIONS = {
  v1: 'qwen3.5-text-layout-field-proposals.v1',
  v2: 'qwen3.5-text-layout-field-proposals.v2',
} as const;
export type PlainLayoutPromptVersion = keyof typeof PIPELINE_VERSIONS;
export type PlainLayoutModelAdapter = 'qwen35' | 'nuextract';
const DEFAULT_MODEL_ID = 'qwen3.5-2b-q4_k_m' as const;
const DEFAULT_MODEL_SHA256 =
  '0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc' as const;
const DEFAULT_MODEL_PATH =
  '/Users/ignas/.cache/lm-studio/models/lmstudio-community/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf' as const;
const DEFAULT_MODEL_BINARY = '/opt/homebrew/bin/llama-cli' as const;
const DEFAULT_PDFINFO_BINARY = '/opt/homebrew/bin/pdfinfo' as const;
const DEFAULT_PDFTOTEXT_BINARY = '/opt/homebrew/bin/pdftotext' as const;
const PAGE_TIMEOUT_MS = 120_000;
const MODEL_CONTEXT_SIZE = 12_288;
const MODEL_OUTPUT_SIZE = 4_096;
const MODEL_HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 512 * 1024;
const RUNNER_SOURCE_PATH = fileURLToPath(import.meta.url);
const PROPOSAL_DECODER_SOURCE_PATH = join(dirname(RUNNER_SOURCE_PATH), 'text-field-proposals.ts');
const NUEXTRACT_SOURCE_PATH = join(dirname(RUNNER_SOURCE_PATH), 'nuextract-proposals.ts');
const PLAIN_LAYOUT_PROMPT_PREFIX =
  'Extract every laboratory result from this report page as a JSON array with label, value, unit, reference, flag. Copy printed text; absent optional fields are null. Include numeric, bounded and categorical results.\n';

type Arguments = {
  readonly report: string;
  readonly reportId: string;
  readonly output: string;
  readonly privateRoot: string;
  readonly model: string;
  readonly modelId: string;
  readonly modelSha256: string;
  readonly modelBinary: string;
  readonly adapter: PlainLayoutModelAdapter;
  readonly pdfinfoBinary: string;
  readonly pdftotextBinary: string;
  readonly pages?: readonly number[];
  readonly promptVersion: PlainLayoutPromptVersion;
  readonly vision?: string;
  readonly binding?: string;
};

type ModelRun = {
  readonly raw: string;
  readonly elapsedMs: number;
  readonly status: 'complete' | 'failed' | 'timed-out';
  readonly cliError: boolean;
  readonly outputTruncated: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
};

export function classifyModelStatus(
  layoutStatus: string,
  runStatus: ModelRun['status'],
  modelResponseValid: boolean,
  cliError: boolean,
  outputTruncated: boolean,
): string {
  if (layoutStatus === 'failed') return 'skipped-layout-failed';
  if (modelResponseValid) return 'complete';
  if (outputTruncated) return 'output-truncated';
  if (cliError) return 'cli-error';
  if (runStatus === 'complete') return 'malformed-json';
  return runStatus;
}

type PageResult = {
  readonly page: number;
  readonly layoutPath: string;
  readonly layoutSha256: string;
  readonly promptPath: string;
  readonly promptSha256: string;
  readonly modelRawPath: string;
  readonly modelRawSha256: string;
  readonly proposalPath: string;
  readonly proposalSha256: string;
  readonly layoutElapsedMs: number;
  readonly modelElapsedMs: number;
  readonly groundingElapsedMs: number;
  readonly layoutStatus: string;
  readonly modelStatus: string;
  readonly proposalCount: number;
  readonly groundedCount: number;
  readonly droppedIncompleteRows: number;
  readonly cliError: boolean;
  readonly outputTruncated: boolean;
};

function argument(args: readonly string[], name: string, required = true): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    if (required) throw new Error('text-layout-fullpage-arguments-invalid');
    return undefined;
  }
  return value;
}

function modelHashInChunks(path: string, chunkBytes = MODEL_HASH_CHUNK_BYTES): string {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1)
    throw new Error('text-layout-fullpage-hash-chunk-invalid');
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let position = 0;
  try {
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export function parsePageCount(pdfInfo: string): number {
  const match = /^Pages:\s+(\d+)\s*$/mu.exec(pdfInfo);
  const count = match === null ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    throw new Error('text-layout-fullpage-page-count-invalid');
  return count;
}

const PLAIN_LAYOUT_PROMPT_V2_PREFIX = `${PLAIN_LAYOUT_PROMPT_PREFIX}Identify the laboratory test name from the complete test-name or label column and the observed result from the Current Result column. Use the headers on this page to distinguish the full test-name, Current Result, Unit, Reference Interval, and Flag columns from administrative columns. Copy the full printed test name and current result exactly. Ignore Previous or Prior Result and columns for accreditation, method, staff, location, specimen, identifiers, demographics, and administration. Exclude guidance, instructions, reference-only tables, and headers. Return only observed laboratory results; if this page has no observed laboratory result, return {"rows":[]}.\n`;

export function buildPlainLayoutPrompt(
  layout: string,
  version: PlainLayoutPromptVersion = 'v1',
): string {
  return `${version === 'v2' ? PLAIN_LAYOUT_PROMPT_V2_PREFIX : PLAIN_LAYOUT_PROMPT_PREFIX}${layout}`;
}

function buildAdapterPrompt(
  layout: string,
  adapter: PlainLayoutModelAdapter,
  version: PlainLayoutPromptVersion,
): string {
  return adapter === 'nuextract'
    ? buildNuExtractPrompt(layout)
    : buildPlainLayoutPrompt(layout, version);
}

function decodeAdapterProposals(
  raw: string,
  adapter: PlainLayoutModelAdapter,
): {
  readonly proposals: readonly TextFieldProposal[];
  readonly valid: boolean;
  readonly droppedIncompleteRows: number;
} {
  if (adapter === 'nuextract') return decodeNuExtractProposals(raw);
  const decoded = decodeTextFieldProposals(raw);
  return { ...decoded, droppedIncompleteRows: 0 };
}

export function parsePageSelection(value: string): readonly number[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^\d+$/u.test(part))) {
    throw new Error('text-layout-fullpage-pages-invalid');
  }
  const pages = [...new Set(parts.map(Number))].toSorted((left, right) => left - right);
  if (pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error('text-layout-fullpage-pages-invalid');
  }
  return pages;
}

function parseArguments(args: readonly string[]): Arguments {
  const report = argument(args, '--report');
  const reportId = argument(args, '--report-id');
  const output = argument(args, '--output');
  const privateRoot = argument(args, '--private-root');
  const adapterArgument = argument(args, '--adapter', false) ?? 'qwen35';
  const adapter = adapterArgument as PlainLayoutModelAdapter;
  const model =
    argument(args, '--model', false) ??
    (adapter === 'nuextract' ? NUEXTRACT_DEFAULT_MODEL_PATH : DEFAULT_MODEL_PATH);
  const modelId =
    argument(args, '--model-id', false) ??
    (adapter === 'nuextract' ? NUEXTRACT_MODEL_ID : DEFAULT_MODEL_ID);
  const modelSha256 =
    argument(args, '--model-sha256', false) ??
    (adapter === 'nuextract' ? NUEXTRACT_MODEL_SHA256 : DEFAULT_MODEL_SHA256);
  const modelBinary = argument(args, '--model-binary', false) ?? DEFAULT_MODEL_BINARY;
  const pdfinfoBinary = argument(args, '--pdfinfo-binary', false) ?? DEFAULT_PDFINFO_BINARY;
  const pdftotextBinary = argument(args, '--pdftotext-binary', false) ?? DEFAULT_PDFTOTEXT_BINARY;
  const pagesArgument = argument(args, '--pages', false);
  const promptVersionArgument = argument(args, '--prompt-version', false) ?? 'v1';
  const promptVersion = promptVersionArgument as PlainLayoutPromptVersion;
  const vision = argument(args, '--vision', false);
  const binding = argument(args, '--binding', false);
  if (
    report === undefined ||
    reportId === undefined ||
    output === undefined ||
    privateRoot === undefined ||
    (adapter !== 'qwen35' && adapter !== 'nuextract') ||
    !Object.hasOwn(PIPELINE_VERSIONS, promptVersion) ||
    (vision === undefined) !== (binding === undefined)
  ) {
    throw new Error(
      'usage: text-layout-fullpage --report path --report-id id --output path --private-root root [--adapter qwen35|nuextract] [--prompt-version v1|v2] [--pages 3[,4,...]] [--model path] [--model-id id] [--model-sha256 sha256] [--model-binary path] [--pdfinfo-binary path] [--pdftotext-binary path] [--vision bound-native.json --binding bound-native.binding.json]',
    );
  }
  if (!/^[a-z][a-z0-9_-]*$/u.test(reportId))
    throw new Error('text-layout-fullpage-report-id-invalid');
  if (!/^\S+$/u.test(modelId)) throw new Error('text-layout-fullpage-model-id-invalid');
  if (!/^[a-f0-9]{64}$/u.test(modelSha256))
    throw new Error('text-layout-fullpage-model-hash-invalid');
  return {
    report: resolve(report),
    reportId,
    output: resolve(output),
    privateRoot: resolve(privateRoot),
    model: resolve(model),
    modelId,
    modelSha256,
    modelBinary: resolve(modelBinary),
    adapter,
    pdfinfoBinary: resolve(pdfinfoBinary),
    pdftotextBinary: resolve(pdftotextBinary),
    ...(pagesArgument === undefined ? {} : { pages: parsePageSelection(pagesArgument) }),
    promptVersion,
    ...(vision === undefined ? {} : { vision: resolve(vision) }),
    ...(binding === undefined ? {} : { binding: resolve(binding) }),
  };
}

function runChild(binary: string, args: readonly string[], timeoutMs: number): Promise<ModelRun> {
  return new Promise<ModelRun>((settle) => {
    const started = performance.now();
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const capture = (target: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - current);
      if (chunk.length > remaining) outputTruncated = true;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      return current + Math.min(chunk.length, remaining);
    };
    const finish = (status: ModelRun['status']): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (hardKill !== undefined) clearTimeout(hardKill);
      const raw = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const cliError = /^\s*Error:/mu.test(raw) || /^\s*Error:/mu.test(stderrText);
      settle({
        raw,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        status: status === 'complete' && cliError ? 'failed' : status,
        cliError,
        outputTruncated,
        stdoutBytes,
        stderrBytes,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
    });
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    child.once('error', () => finish(timedOut ? 'timed-out' : 'failed'));
    child.once('close', (code, signal) => {
      finish(timedOut || signal !== null ? 'timed-out' : code === 0 ? 'complete' : 'failed');
    });
  });
}

async function runModel(binary: string, model: string, promptPath: string): Promise<ModelRun> {
  return (await runChild(
    binary,
    [
      '--model',
      model,
      '--file',
      promptPath,
      '--n-predict',
      String(MODEL_OUTPUT_SIZE),
      '--ctx-size',
      String(MODEL_CONTEXT_SIZE),
      '--temp',
      '0',
      '--seed',
      '0',
      '--device',
      'MTL0',
      '--no-perf',
      '--no-display-prompt',
      '--log-disable',
      '--simple-io',
      '--single-turn',
      '--reasoning',
      'off',
      '--chat-template-kwargs',
      '{"enable_thinking":false}',
    ],
    PAGE_TIMEOUT_MS,
  )) as ModelRun;
}

function runBinary(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): { readonly stdout: string; readonly stderr: string } {
  try {
    const result = spawnSync(binary, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
    });
    if (result.error !== undefined || result.status !== 0) throw new Error('binary-failed');
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch {
    throw new Error('text-layout-fullpage-binary-failed');
  }
}

function binaryVersion(binary: string): string {
  try {
    const result = runBinary(binary, ['--version'], 30_000);
    const line = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/gu)
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    return line ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function identityFromBinding(value: unknown): {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('text-layout-fullpage-binding-invalid');
  const record = value as Record<string, unknown>;
  const fields = [
    'reportSha256',
    'readerVersion',
    'runtimeVersion',
    'readerBinarySha256',
    'readerSourceSha256',
  ] as const;
  if (fields.some((field) => typeof record[field] !== 'string'))
    throw new Error('text-layout-fullpage-binding-invalid');
  return {
    reportSha256: record.reportSha256 as string,
    readerVersion: record.readerVersion as string,
    runtimeVersion: record.runtimeVersion as string,
    readerBinarySha256: record.readerBinarySha256 as string,
    readerSourceSha256: record.readerSourceSha256 as string,
  };
}

function nativePages(envelope: RawSnapshotEnvelope): readonly VisionPage[] {
  if (!Array.isArray(envelope.pages)) throw new Error('text-layout-fullpage-native-pages-invalid');
  return envelope.pages.map((page) => {
    if (page === null || typeof page !== 'object')
      throw new Error('text-layout-fullpage-native-page-invalid');
    const record = page as Record<string, unknown>;
    const pageIndex = record.pageIndex;
    const result = record.result;
    if (typeof pageIndex !== 'number' || result === null || typeof result !== 'object')
      throw new Error('text-layout-fullpage-native-page-invalid');
    const observations = (result as Record<string, unknown>).observations;
    if (!Array.isArray(observations)) throw new Error('text-layout-fullpage-native-page-invalid');
    return {
      pageIndex,
      observations: observations
        .filter(
          (observation): observation is Record<string, unknown> =>
            observation !== null && typeof observation === 'object' && !Array.isArray(observation),
        )
        .map((observation) => ({
          id: String(observation.id ?? ''),
          text: String(observation.text ?? ''),
          pageIndex,
          ...(observation.boundingBox !== null && typeof observation.boundingBox === 'object'
            ? {
                boundingBox:
                  observation.boundingBox as VisionPage['observations'][number]['boundingBox'],
              }
            : {}),
          ...(observation.structure !== null && typeof observation.structure === 'object'
            ? {
                structure: observation.structure as VisionPage['observations'][number]['structure'],
              }
            : {}),
          ...(Array.isArray(observation.spans)
            ? { spans: observation.spans as VisionPage['observations'][number]['spans'] }
            : {}),
          ...(typeof observation.sourceStart === 'number'
            ? { sourceStart: observation.sourceStart }
            : {}),
          ...(typeof observation.sourceEnd === 'number'
            ? { sourceEnd: observation.sourceEnd }
            : {}),
        })),
    };
  });
}

function countProposalNumbers(proposals: readonly TextFieldProposal[]): number {
  return proposals.filter((proposal) => typeof proposal.rawValue === 'number').length;
}

function pageArtifactPath(root: string, runStem: string, page: number, suffix: string): string {
  return join(root, `${runStem}-page-${String(page).padStart(3, '0')}.${suffix}`);
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const root = parsed.privateRoot;
  const reportPath = assertPrivatePath(parsed.report, root);
  const outputPath = assertPrivatePath(parsed.output, root);
  if (parsed.vision !== undefined) assertPrivatePath(parsed.vision, root);
  if (parsed.binding !== undefined) assertPrivatePath(parsed.binding, root);

  // Hash before creating output directories so a wrong model artifact cannot produce a result.
  const modelSha256 = modelHashInChunks(parsed.model);
  if (modelSha256 !== parsed.modelSha256)
    throw new Error('text-layout-fullpage-model-hash-mismatch');

  ensurePrivateDirectory(dirname(outputPath));
  const runRoot = join(dirname(outputPath), `${parsed.reportId}-text-layout-artifacts`);
  ensurePrivateDirectory(runRoot);
  const reportSha256 = sha256File(reportPath);
  const pageCountText = runBinary(parsed.pdfinfoBinary, [reportPath], 30_000).stdout;
  const pageCount = parsePageCount(pageCountText);
  const selectedPages = parsed.pages ?? Array.from({ length: pageCount }, (_, index) => index + 1);
  if (selectedPages.some((page) => page > pageCount))
    throw new Error('text-layout-fullpage-pages-out-of-range');
  const pdfinfoVersion = binaryVersion(parsed.pdfinfoBinary);
  const pdftotextVersion = binaryVersion(parsed.pdftotextBinary);
  const modelBinaryVersion = binaryVersion(parsed.modelBinary);
  const sourceHashes = {
    runner: sha256File(RUNNER_SOURCE_PATH),
    proposalDecoder: sha256File(
      parsed.adapter === 'nuextract' ? NUEXTRACT_SOURCE_PATH : PROPOSAL_DECODER_SOURCE_PATH,
    ),
    grounder: sha256File(TEXT_FIELD_PROPOSALS_MAIN_GROUNDER),
  } as const;

  let nativeByPage = new Map<number, VisionPage>();
  let sourceBinding: Record<string, unknown> | null = null;
  if (parsed.vision !== undefined && parsed.binding !== undefined) {
    const nativeText = readFileSync(parsed.vision, 'utf8');
    const bindingValue = readJsonFile(parsed.binding);
    const identity = identityFromBinding(bindingValue);
    const envelope = verifyRawSnapshotBinding(nativeText, bindingValue, {
      ...identity,
      reportSha256,
    });
    nativeByPage = new Map(nativePages(envelope).map((page) => [page.pageIndex, page]));
    sourceBinding = {
      schemaVersion: (bindingValue as Record<string, unknown>).schemaVersion,
      snapshotSha256: (bindingValue as Record<string, unknown>).snapshotSha256,
      bindingSha256: sha256File(parsed.binding),
      nativeSnapshotSha256: sha256File(parsed.vision),
      reportSha256: identity.reportSha256,
      readerVersion: identity.readerVersion,
      runtimeVersion: identity.runtimeVersion,
      readerBinarySha256: identity.readerBinarySha256,
      readerSourceSha256: identity.readerSourceSha256,
    };
  }

  const stem =
    parsed.output
      .split('/')
      .pop()
      ?.replace(/\.json$/u, '') ?? parsed.reportId;
  const pageResults: PageResult[] = [];
  const allProposals: Array<TextFieldProposal & { readonly page: number }> = [];
  const allMeasurements: PipelineResult['measurements'][number][] = [];

  for (const page of selectedPages) {
    const layoutPath = pageArtifactPath(runRoot, stem, page, 'layout.txt');
    const promptPath = pageArtifactPath(runRoot, stem, page, 'prompt.txt');
    const modelRawPath = pageArtifactPath(runRoot, stem, page, 'raw.txt');
    const proposalPath = pageArtifactPath(runRoot, stem, page, 'proposals.json');
    for (const path of [layoutPath, promptPath, modelRawPath, proposalPath])
      assertPrivatePath(path, root);

    const layoutStarted = performance.now();
    let layout = '';
    let layoutStatus = 'complete';
    try {
      layout = runBinary(
        parsed.pdftotextBinary,
        ['-layout', '-f', String(page), '-l', String(page), '-enc', 'UTF-8', reportPath, '-'],
        30_000,
      ).stdout;
      writePrivateTextFile(layoutPath, layout);
    } catch {
      layoutStatus = 'failed';
      writePrivateTextFile(layoutPath, '');
    }
    const layoutElapsedMs = Math.max(0, Math.round(performance.now() - layoutStarted));

    const prompt = buildAdapterPrompt(layout, parsed.adapter, parsed.promptVersion);
    writePrivateTextFile(promptPath, prompt);
    const modelRun =
      layoutStatus === 'complete'
        ? await runModel(parsed.modelBinary, parsed.model, promptPath)
        : {
            raw: '',
            elapsedMs: 0,
            status: 'failed' as const,
            cliError: false,
            outputTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
          };
    writePrivateTextFile(modelRawPath, modelRun.raw);
    const decoded = decodeAdapterProposals(modelRun.raw, parsed.adapter);
    const modelResponseValid =
      modelRun.status === 'complete' &&
      decoded.valid &&
      !modelRun.cliError &&
      !modelRun.outputTruncated;
    const proposals = modelResponseValid ? decoded.proposals : [];
    writeJsonFile(proposalPath, {
      schemaVersion: SCHEMA_VERSION,
      reportId: parsed.reportId,
      reportSha256,
      page,
      modelResponseValid,
      droppedIncompleteRows: decoded.droppedIncompleteRows,
      proposals,
    });
    allProposals.push(...proposals.map((proposal) => ({ ...proposal, page })));

    const groundingStarted = performance.now();
    const nativePage = nativeByPage.get(page - 1);
    const grounded =
      nativePage === undefined
        ? { measurements: [], diagnostics: { acceptedCount: 0 } }
        : groundTextFieldProposals(proposals, nativePage);
    allMeasurements.push(...grounded.measurements);
    const groundingElapsedMs = Math.max(0, Math.round(performance.now() - groundingStarted));
    pageResults.push({
      page,
      layoutPath,
      layoutSha256: sha256File(layoutPath),
      promptPath,
      promptSha256: sha256File(promptPath),
      modelRawPath,
      modelRawSha256: sha256File(modelRawPath),
      proposalPath,
      proposalSha256: sha256File(proposalPath),
      layoutElapsedMs,
      modelElapsedMs: modelRun.elapsedMs,
      groundingElapsedMs,
      layoutStatus,
      modelStatus: classifyModelStatus(
        layoutStatus,
        modelRun.status,
        modelResponseValid,
        modelRun.cliError,
        modelRun.outputTruncated,
      ),
      proposalCount: proposals.length,
      groundedCount: grounded.measurements.length,
      droppedIncompleteRows: decoded.droppedIncompleteRows,
      cliError: modelRun.cliError,
      outputTruncated: modelRun.outputTruncated,
    });
  }

  const totalElapsedMs = pageResults.reduce(
    (sum, page) => sum + page.layoutElapsedMs + page.modelElapsedMs + page.groundingElapsedMs,
    0,
  );
  const modelFailures = pageResults.filter((page) => page.modelStatus !== 'complete').length;
  const result: PipelineResult & {
    readonly modelProposals: readonly (TextFieldProposal & { readonly page: number })[];
    readonly privatePageResults: readonly PageResult[];
  } = {
    schemaVersion: SCHEMA_VERSION,
    reportId: parsed.reportId,
    reportSha256,
    pipeline: {
      id: PIPELINE_IDS[parsed.adapter],
      version:
        parsed.adapter === 'nuextract'
          ? NUEXTRACT_PROMPT_VERSION
          : PIPELINE_VERSIONS[parsed.promptVersion],
      configuration: {
        adapter:
          parsed.adapter === 'nuextract'
            ? 'pdftotext-layout-nuextract-field-strings'
            : 'pdftotext-layout-qwen35-field-strings',
        modelAdapter: parsed.adapter,
        extraction: 'pdftotext -layout -f PAGE -l PAGE -enc UTF-8',
        promptVersion:
          parsed.adapter === 'nuextract'
            ? NUEXTRACT_PROMPT_VERSION
            : `plain-layout-field-proposals.${parsed.promptVersion}`,
        contextSize: MODEL_CONTEXT_SIZE,
        outputSize: MODEL_OUTPUT_SIZE,
        temperature: 0,
        seed: 0,
        singleTurn: true,
        reasoning: 'off',
        chatTemplateKwargs: { enable_thinking: false },
        pageCount,
        selectedPages,
        pageScope: parsed.pages === undefined ? 'full-report' : 'selected-pages',
        localOnly: true,
        modelStringsAuthoritative: false,
        sourceIdsAuthoritative: false,
        sourceBinding,
        modelId: parsed.modelId,
        modelSha256,
        modelPath: parsed.model,
        binary: parsed.modelBinary,
        binarySha256: sha256File(parsed.modelBinary),
        binaryVersion: modelBinaryVersion,
        pageTimeoutMs: PAGE_TIMEOUT_MS,
        promptPrefixSha256: createHash('sha256')
          .update(
            parsed.adapter === 'nuextract' ? NUEXTRACT_PROMPT_PREFIX : PLAIN_LAYOUT_PROMPT_PREFIX,
            'utf8',
          )
          .digest('hex'),
        sourceHashes,
        proposalDecoderPromptVersion:
          parsed.adapter === 'nuextract'
            ? NUEXTRACT_PROMPT_VERSION
            : TEXT_FIELD_PROPOSALS_PROMPT_VERSION,
        grounderSourcePath: TEXT_FIELD_PROPOSALS_MAIN_GROUNDER,
      },
      runtime: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
        pdfinfoBinary: parsed.pdfinfoBinary,
        pdfinfoBinarySha256: sha256File(parsed.pdfinfoBinary),
        pdfinfoVersion,
        pdftotextBinary: parsed.pdftotextBinary,
        pdftotextBinarySha256: sha256File(parsed.pdftotextBinary),
        pdftotextVersion,
      },
    },
    stages: [
      {
        name: 'poppler-page-layout-text',
        elapsedMs: pageResults.reduce((sum, page) => sum + page.layoutElapsedMs, 0),
        inputCount: selectedPages.length,
        outputCount: pageResults.filter((page) => page.layoutStatus === 'complete').length,
        status: pageResults.every((page) => page.layoutStatus === 'complete')
          ? 'complete'
          : 'partial',
      },
      {
        name:
          parsed.adapter === 'nuextract'
            ? 'nuextract-2.0-plain-layout-inference'
            : 'qwen35-plain-layout-inference',
        elapsedMs: pageResults.reduce((sum, page) => sum + page.modelElapsedMs, 0),
        inputCount: selectedPages.length,
        outputCount: allProposals.length,
        status: modelFailures === 0 ? 'complete' : 'partial',
      },
      {
        name: 'source-grounding',
        elapsedMs: pageResults.reduce((sum, page) => sum + page.groundingElapsedMs, 0),
        inputCount: allProposals.length,
        outputCount: allMeasurements.length,
        status: parsed.vision === undefined ? 'unavailable' : 'complete',
      },
    ],
    elapsedMs: totalElapsedMs,
    modelProposals: allProposals,
    measurements: allMeasurements,
    diagnostics: {
      counts: {
        pages: pageCount,
        selectedPages: selectedPages.length,
        layoutPages: pageResults.filter((page) => page.layoutStatus === 'complete').length,
        modelPages: pageResults.filter((page) => page.modelStatus === 'complete').length,
        modelFailures,
        modelProposals: allProposals.length,
        droppedIncompleteRows: pageResults.reduce(
          (sum, page) => sum + page.droppedIncompleteRows,
          0,
        ),
        modelNumericValueProposals: countProposalNumbers(allProposals),
        groundedMeasurements: allMeasurements.length,
        nativePages: nativeByPage.size,
        cliErrors: pageResults.filter((page) => page.cliError).length,
        truncatedOutputs: pageResults.filter((page) => page.outputTruncated).length,
      },
      limitations: [
        'Evaluation-only plaintext layout model proposals; they remain separate from source truth.',
        'Grounding is available only when a report-bound native snapshot and binding are supplied.',
        'No ground truth, catalogue filter, or report-specific rule is used in model input.',
      ],
    },
    privatePageResults: pageResults,
  };
  writeJsonFile(outputPath, result);
  process.stdout.write(
    `${JSON.stringify({
      status: 'complete',
      reportId: parsed.reportId,
      pages: pageCount,
      selectedPages: selectedPages.length,
      adapter: parsed.adapter,
      promptVersion: parsed.promptVersion,
      modelProposals: allProposals.length,
      groundedMeasurements: allMeasurements.length,
      modelFailures,
      output: outputPath,
    })}\n`,
  );
}

if (process.argv[1]?.endsWith('text-layout-fullpage.ts') === true) {
  void main().catch(() => {
    process.stderr.write('text-layout-fullpage-failed\n');
    process.exitCode = 1;
  });
}
