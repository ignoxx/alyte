/**
 * Replays source grounding against a persisted PaddleOCR-VL result.
 *
 * This is deliberately a cached-only evaluation adapter. It never invokes PaddleOCR-VL, Vision,
 * OCR, a language model, a network service, or a catalogue. Paddle's linear rows are untrusted
 * proposals; a row is retained only when the bound native Vision snapshot provides one unique
 * same-page label/value row or bounded contiguous span. Source fields are rebuilt from Vision so
 * that model text cannot silently become measured source truth.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  readJsonFile,
  securePrivateFile,
  sha256File,
  writeJsonFile,
  type PipelineResult,
  type EvaluationMeasurement,
} from './contract';
import { groundVisionProposals, type VisionPage, type VisionObservation } from './qwen35-grounding';
import {
  verifyRawSnapshotBinding,
  type RawSnapshotBinding,
  type RawSnapshotEnvelope,
  type RawSnapshotIdentity,
} from './raw-snapshot-binding';
import { scoreFiles, type SafeAggregate } from './score';

export const CACHED_GROUNDING_VERSION = 'paddleocr-vl16-cached-vision-grounding.v1' as const;

type RawVisionPage = {
  readonly pageIndex: number;
  readonly result?: { readonly observations?: readonly Record<string, unknown>[] };
};

type RawVisionArtifact = {
  readonly pages?: readonly RawVisionPage[];
};

export type CachedGroundingOptions = {
  readonly proposalsPath: string;
  readonly visionPath: string;
  readonly bindingPath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly reportPath?: string;
  readonly expectedPath?: string;
  readonly scoreOutputPath?: string;
  readonly aggregateOutputPath?: string;
};

export type CachedGroundingResult = {
  readonly result: PipelineResult;
  readonly aggregate?: SafeAggregate;
};

/** Apply the bounded same-page source-evidence gate to already persisted Paddle proposals. */
export function groundCachedProposals(
  proposals: readonly EvaluationMeasurement[],
  pages: readonly VisionPage[],
) {
  return groundVisionProposals(proposals, pages);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`cached-grounding-${name}-invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`cached-grounding-${name}-invalid`);
  }
  return value;
}

function bindingIdentity(value: unknown): RawSnapshotIdentity {
  const row = record(value, 'binding');
  return {
    reportSha256: requiredString(row.reportSha256, 'report-hash'),
    readerVersion: requiredString(row.readerVersion, 'reader-version'),
    runtimeVersion: requiredString(row.runtimeVersion, 'runtime-version'),
    readerBinarySha256: requiredString(row.readerBinarySha256, 'reader-binary-hash'),
    readerSourceSha256: requiredString(row.readerSourceSha256, 'reader-source-hash'),
  };
}

function checkedBinding(value: unknown): RawSnapshotBinding {
  const row = record(value, 'binding');
  const identity = bindingIdentity(value);
  const snapshotSha256 = requiredString(row.snapshotSha256, 'snapshot-hash');
  if (row.schemaVersion !== 'alyte.import-eval.raw-snapshot-binding.v1') {
    throw new Error('cached-grounding-binding-schema-invalid');
  }
  return {
    schemaVersion: row.schemaVersion,
    ...identity,
    snapshotSha256,
  };
}

function asObservation(value: Record<string, unknown>, pageIndex: number): VisionObservation {
  const id = typeof value.id === 'string' ? value.id : '';
  const text = typeof value.text === 'string' ? value.text : '';
  const structure =
    value.structure !== null && typeof value.structure === 'object'
      ? (value.structure as VisionObservation['structure'])
      : undefined;
  const boundingBox =
    value.boundingBox !== null && typeof value.boundingBox === 'object'
      ? (value.boundingBox as VisionObservation['boundingBox'])
      : undefined;
  const spans = Array.isArray(value.spans)
    ? (value.spans as VisionObservation['spans'])
    : undefined;
  return {
    id,
    text,
    pageIndex,
    structure,
    boundingBox,
    spans,
    sourceStart: typeof value.sourceStart === 'number' ? value.sourceStart : undefined,
    sourceEnd: typeof value.sourceEnd === 'number' ? value.sourceEnd : undefined,
  };
}

export function visionPages(value: unknown): readonly VisionPage[] {
  const artifact = record(value, 'vision-envelope') as RawVisionArtifact;
  if (!Array.isArray(artifact.pages)) throw new Error('cached-grounding-pages-invalid');
  return artifact.pages.map((page) => {
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) {
      throw new Error('cached-grounding-page-index-invalid');
    }
    const observations = page.result?.observations ?? [];
    if (!Array.isArray(observations)) throw new Error('cached-grounding-observations-invalid');
    return {
      pageIndex: page.pageIndex,
      observations: observations.map((observation) =>
        asObservation(record(observation, 'observation'), page.pageIndex),
      ),
    };
  });
}

function sourceSnapshot(binding: RawSnapshotBinding): Record<string, string> {
  return {
    schemaVersion: binding.schemaVersion,
    snapshotSha256: binding.snapshotSha256,
    reportSha256: binding.reportSha256,
    readerVersion: binding.readerVersion,
    runtimeVersion: binding.runtimeVersion,
    readerBinarySha256: binding.readerBinarySha256,
    readerSourceSha256: binding.readerSourceSha256,
  };
}

function verifyVisionSnapshot(options: {
  readonly visionPath: string;
  readonly bindingPath: string;
  readonly privateRoot: string;
  readonly reportSha256: string;
}): { readonly envelope: RawSnapshotEnvelope; readonly binding: RawSnapshotBinding } {
  const visionPath = assertPrivatePath(options.visionPath, options.privateRoot);
  const bindingPath = assertPrivatePath(options.bindingPath, options.privateRoot);
  securePrivateFile(visionPath);
  securePrivateFile(bindingPath);
  const rawText = readFileSync(visionPath, 'utf8');
  const binding = checkedBinding(readJsonFile(bindingPath));
  let envelope: RawSnapshotEnvelope;
  try {
    envelope = verifyRawSnapshotBinding(rawText, binding, binding);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `cached-grounding-${error.message}`
        : 'cached-grounding-binding-invalid',
    );
  }
  if (envelope.reportSha256 !== options.reportSha256) {
    throw new Error('cached-grounding-report-binding-mismatch');
  }
  return { envelope, binding };
}

function provenance(): Record<string, string> {
  const scriptPath = fileURLToPath(import.meta.url);
  return {
    version: CACHED_GROUNDING_VERSION,
    scriptSha256: sha256File(scriptPath),
    algorithmSha256: sha256File(resolve(dirname(scriptPath), 'qwen35-grounding.ts')),
  };
}

function replayPipeline(
  input: PipelineResult,
  grounded: ReturnType<typeof groundVisionProposals>,
  binding: RawSnapshotBinding,
  bindingElapsedMs: number,
  groundingElapsedMs: number,
  visionPageCount: number,
): PipelineResult {
  const source = sourceSnapshot(binding);
  const oldConfiguration = input.pipeline.configuration;
  return {
    ...input,
    pipeline: {
      ...input.pipeline,
      id: 'paddleocr-vl16-cached-grounded',
      version: `${input.pipeline.version}+${CACHED_GROUNDING_VERSION}`,
      configuration: {
        ...oldConfiguration,
        source: 'persisted-paddleocr-vl-text+bound-native-vision',
        sourceSnapshot: source,
        grounding: provenance(),
        modelRowsAuthoritative: false,
        samePageOnly: true,
        uniqueLabelValueEvidence: true,
        visionPageCount,
      },
    },
    stages: [
      ...input.stages,
      {
        name: 'source-binding-verification',
        elapsedMs: bindingElapsedMs,
        inputCount: 1,
        outputCount: visionPageCount,
        status: 'success',
      },
      {
        name: 'source-grounding',
        elapsedMs: groundingElapsedMs,
        inputCount: input.measurements.length,
        outputCount: grounded.measurements.length,
        status: 'success',
      },
    ],
    elapsedMs: input.elapsedMs + bindingElapsedMs + groundingElapsedMs,
    measurements: grounded.measurements,
    diagnostics: {
      counts: {
        ...input.diagnostics.counts,
        sourceGroundingProposals: grounded.diagnostics.proposalCount,
        sourceGroundingAccepted: grounded.diagnostics.acceptedCount,
        sourceGroundingRejected: grounded.diagnostics.rejectedCount,
        sourceGroundingRejectedLabelNotFound:
          grounded.diagnostics.rejectedByReason['label-not-found'],
        sourceGroundingRejectedValueNotFound:
          grounded.diagnostics.rejectedByReason['value-not-found'],
        sourceGroundingRejectedNotSameRowOrSpan:
          grounded.diagnostics.rejectedByReason['not-same-row-or-span'],
        sourceGroundingRejectedAmbiguous:
          grounded.diagnostics.rejectedByReason['ambiguous-source-span'],
        sourceGroundingRejectedDuplicate:
          grounded.diagnostics.rejectedByReason['duplicate-occurrence'],
      },
      limitations: [
        ...input.diagnostics.limitations,
        'Paddle proposals were retained only with one unique same-page native Vision label/value row or bounded contiguous span.',
        'Collection date, specimen, canonical mapping, and trend eligibility remain unresolved unless present in the source-grounded contract.',
      ],
    },
  };
}

export function runCachedGrounding(options: CachedGroundingOptions): CachedGroundingResult {
  const proposalsPath = assertPrivatePath(resolve(options.proposalsPath), options.privateRoot);
  const outputPath = assertPrivatePath(resolve(options.outputPath), options.privateRoot);
  assertPrivatePath(options.visionPath, options.privateRoot);
  assertPrivatePath(options.bindingPath, options.privateRoot);
  securePrivateFile(proposalsPath);
  ensurePrivateDirectory(dirname(outputPath));
  const input = parsePipelineResult(readJsonFile(proposalsPath));
  const bindingStarted = performance.now();
  const verified = verifyVisionSnapshot({
    visionPath: resolve(options.visionPath),
    bindingPath: resolve(options.bindingPath),
    privateRoot: resolve(options.privateRoot),
    reportSha256: input.reportSha256,
  });
  const bindingElapsedMs = Math.max(0, performance.now() - bindingStarted);
  const pages = visionPages(verified.envelope);
  const groundingStarted = performance.now();
  const grounded = groundCachedProposals(input.measurements, pages);
  const groundingElapsedMs = Math.max(0, performance.now() - groundingStarted);
  const result = replayPipeline(
    input,
    grounded,
    verified.binding,
    bindingElapsedMs,
    groundingElapsedMs,
    pages.length,
  );
  writeJsonFile(outputPath, result);

  if (
    options.reportPath !== undefined ||
    options.expectedPath !== undefined ||
    options.scoreOutputPath !== undefined ||
    options.aggregateOutputPath !== undefined
  ) {
    if (options.reportPath === undefined || options.expectedPath === undefined) {
      throw new Error('cached-grounding-score-inputs-required');
    }
    const score = scoreFiles({
      reportPath: options.reportPath,
      reportId: input.reportId,
      expectedPath: options.expectedPath,
      pipelinePath: outputPath,
      privateRoot: options.privateRoot,
      ...(options.scoreOutputPath === undefined ? {} : { outputPath: options.scoreOutputPath }),
      ...(options.aggregateOutputPath === undefined
        ? {}
        : { aggregateOutputPath: options.aggregateOutputPath }),
    });
    return { result, aggregate: score.aggregate };
  }
  return { result };
}

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error(`cached-grounding-${name.replace(/^--/u, '')}-required`);
  }
  return value;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : argument(args, name);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: paddleocr-vl16-cached-grounding --proposals <json> --vision <json> --binding <json> --output <json> --private-root <dir> [--report <pdf> --expected <json> --score-output <json> --aggregate-output <json>]\n',
    );
    return;
  }
  const proposals = argument(args, '--proposals');
  const vision = argument(args, '--vision');
  const binding = argument(args, '--binding');
  const output = argument(args, '--output');
  const privateRoot = argument(args, '--private-root');
  const report = optionalArgument(args, '--report');
  const expected = optionalArgument(args, '--expected');
  const scoreOutput = optionalArgument(args, '--score-output');
  const aggregateOutput = optionalArgument(args, '--aggregate-output');
  const { aggregate } = runCachedGrounding({
    proposalsPath: proposals,
    visionPath: vision,
    bindingPath: binding,
    outputPath: output,
    privateRoot,
    ...(report === undefined ? {} : { reportPath: report }),
    ...(expected === undefined ? {} : { expectedPath: expected }),
    ...(scoreOutput === undefined ? {} : { scoreOutputPath: scoreOutput }),
    ...(aggregateOutput === undefined ? {} : { aggregateOutputPath: aggregateOutput }),
  });
  // Keep source labels, values, and detailed diffs out of ordinary output.
  process.stdout.write(
    `${JSON.stringify(
      aggregate === undefined
        ? { status: 'complete' }
        : {
            status: aggregate.status,
            reportId: aggregate.reportId,
            pipeline: aggregate.pipeline,
            counts: aggregate.counts,
            criticalAssociation: aggregate.criticalAssociation,
            labelValueAssociation: aggregate.labelValueAssociation,
            elapsedMs: aggregate.elapsedMs,
          },
    )}\n`,
  );
}

if (process.argv[1]?.endsWith('/paddleocr-vl16-cached-grounding.ts') === true) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'cached grounding failed');
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}
