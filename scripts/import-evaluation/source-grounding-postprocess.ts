/**
 * Replays a complete proposal pipeline against one verified native source snapshot.
 *
 * This is intentionally a thin evaluation adapter. The proposal file is already the output of
 * the full-page model runner; this command only delegates source binding and all-page grounding to
 * the current grounding implementation. It never opens expected truth or changes model rows
 * outside the grounding contract.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPrivatePath, ensurePrivateDirectory, readJsonFile, writeJsonFile } from './contract';

type GroundingOptions = {
  readonly proposalsPath: string;
  readonly visionPath: string;
  readonly bindingPath?: string;
  readonly outputPath: string;
  readonly privateRoot: string;
};

type GroundingModule = {
  readonly runGrounding: (options: GroundingOptions) => unknown;
};

type PipelineArtifact = Record<string, unknown> & {
  readonly modelProposals?: readonly unknown[];
};

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error('source-grounding-arguments-invalid');
  }
  return value;
}

function optionalArgument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return argument(args, name);
}

function defaultBindingPath(sourcePath: string): string {
  return sourcePath.endsWith('.json')
    ? sourcePath.replace(/\.json$/u, '.binding.json')
    : `${sourcePath}.binding.json`;
}

function modulePath(value: string | undefined): string {
  const path = resolve(
    value ?? resolve(dirname(fileURLToPath(import.meta.url)), 'qwen35-grounding-run.ts'),
  );
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error('source-grounding-module-missing');
  }
  return path;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`source-grounding-${name}-invalid`);
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`source-grounding-${name}-invalid`);
  return value;
}

function proposalValue(row: Record<string, unknown>): string | null {
  const value = row.value ?? row.rawValue;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error('source-grounding-proposal-value-invalid');
}

function proposalPage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('source-grounding-proposal-page-invalid');
  }
  return value;
}

/** Convert every full-runner model row while keeping values unresolved until native grounding. */
export function convertModelProposals(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('source-grounding-model-proposals-invalid');
  return value.map((item, index) => {
    const row = record(item, 'model-proposal');
    if (typeof row.label !== 'string' || row.label.length === 0) {
      throw new Error('source-grounding-proposal-label-invalid');
    }
    const page = proposalPage(row.page);
    const reference = row.referenceInterval ?? row.reference;
    return {
      id: `fullrunner-model-proposal-${String(index + 1).padStart(4, '0')}`,
      sourceLabel: row.label,
      valueString: proposalValue(row),
      valueType: 'unknown',
      parsedValue: null,
      comparator: null,
      unit: nullableString(row.unit, 'proposal-unit'),
      referenceInterval: nullableString(reference, 'proposal-reference'),
      flag: nullableString(row.flag, 'proposal-flag'),
      collectionDate: null,
      collectionGroup: null,
      specimen: null,
      page,
      location: null,
      ambiguousFields: ['sourceIds', 'collectionDate', 'specimen'],
      canonicalBiomarkerId: null,
      trendEligible: null,
      unresolvedFields: ['sourceIds', 'collectionDate', 'specimen'],
      sourceIds: [],
    };
  });
}

function modelProposalPipelinePath(outputPath: string): string {
  return outputPath.endsWith('.json')
    ? outputPath.replace(/\.json$/u, '.model-proposals.json')
    : `${outputPath}.model-proposals.json`;
}

function asConvertedPipeline(
  input: PipelineArtifact,
  modelProposals: readonly Record<string, unknown>[],
): PipelineArtifact {
  const isPriorGroundingStage = (stage: unknown): boolean => {
    if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) return false;
    const name = (stage as Record<string, unknown>).name;
    return name === 'source-grounding' || name === 'source-binding-verification';
  };
  const stages = Array.isArray(input.stages)
    ? input.stages.filter((stage) => !isPriorGroundingStage(stage))
    : input.stages;
  const removedElapsedMs = Array.isArray(input.stages)
    ? input.stages.reduce((sum, stage) => {
        if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) return sum;
        const row = stage as Record<string, unknown>;
        return isPriorGroundingStage(stage) && typeof row.elapsedMs === 'number'
          ? sum + (Number.isFinite(row.elapsedMs) ? row.elapsedMs : 0)
          : sum;
      }, 0)
    : 0;
  const elapsedMs =
    typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs)
      ? Math.max(0, input.elapsedMs - removedElapsedMs)
      : input.elapsedMs;
  const diagnostics = record(input.diagnostics, 'diagnostics');
  const diagnosticCounts = record(diagnostics.counts, 'diagnostic-counts');
  const cleanCounts = { ...diagnosticCounts };
  for (const key of Object.keys(cleanCounts)) {
    if (
      key === 'groundedMeasurements' ||
      key.startsWith('sourceGrounding') ||
      key.startsWith('groundingRejected')
    ) {
      delete cleanCounts[key];
    }
  }
  const pipeline = record(input.pipeline, 'pipeline');
  return {
    ...input,
    elapsedMs,
    stages,
    measurements: modelProposals,
    diagnostics: {
      ...diagnostics,
      counts: {
        ...cleanCounts,
        modelProposals: modelProposals.length,
      },
      limitations: [
        ...(Array.isArray(diagnostics.limitations) ? diagnostics.limitations : []),
        'Previous source-grounding output was removed; all model proposals were re-grounded from the bound source snapshot.',
      ],
    },
    pipeline: {
      ...pipeline,
      configuration: {
        ...record(pipeline.configuration, 'pipeline-configuration'),
        modelProposalConversion: 'source-grounding-postprocess.fullrunner.v1',
        modelProposalCount: modelProposals.length,
      },
    },
  };
}

function preparePipeline(options: {
  readonly pipelinePath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
}): {
  readonly proposalsPath: string;
  readonly modelProposals: readonly Record<string, unknown>[] | null;
} {
  assertPrivatePath(options.pipelinePath, options.privateRoot);
  assertPrivatePath(options.outputPath, options.privateRoot);
  const input = record(readJsonFile(options.pipelinePath), 'pipeline') as PipelineArtifact;
  if (!Array.isArray(input.modelProposals)) {
    return { proposalsPath: options.pipelinePath, modelProposals: null };
  }
  const converted = convertModelProposals(input.modelProposals);
  const proposalsPath = modelProposalPipelinePath(options.outputPath);
  assertPrivatePath(proposalsPath, options.privateRoot);
  ensurePrivateDirectory(dirname(proposalsPath));
  writeJsonFile(proposalsPath, asConvertedPipeline(input, converted));
  return { proposalsPath, modelProposals: converted };
}

export async function runSourceGrounding(options: {
  readonly proposalsPath: string;
  readonly sourcePath: string;
  readonly bindingPath?: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly groundingModulePath?: string;
}): Promise<unknown> {
  const prepared = preparePipeline({
    pipelinePath: resolve(options.proposalsPath),
    outputPath: resolve(options.outputPath),
    privateRoot: resolve(options.privateRoot),
  });
  const module = (await import(
    pathToFileURL(modulePath(options.groundingModulePath)).href
  )) as unknown as GroundingModule;
  if (typeof module.runGrounding !== 'function') {
    throw new Error('source-grounding-module-invalid');
  }
  return module.runGrounding({
    proposalsPath: prepared.proposalsPath,
    visionPath: resolve(options.sourcePath),
    bindingPath: options.bindingPath === undefined ? undefined : resolve(options.bindingPath),
    outputPath: resolve(options.outputPath),
    privateRoot: resolve(options.privateRoot),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: source-grounding-postprocess --pipeline <json> --source <json> --output <json> --private-root <dir> [--binding <json>] [--grounder-module <ts>]\n',
    );
    return;
  }
  const pipelinePath = argument(args, '--pipeline');
  const sourcePath = argument(args, '--source');
  const outputPath = argument(args, '--output');
  const privateRoot = argument(args, '--private-root');
  const bindingPath =
    optionalArgument(args, '--binding') ?? defaultBindingPath(resolve(sourcePath));
  const result = await runSourceGrounding({
    proposalsPath: pipelinePath,
    sourcePath,
    bindingPath,
    outputPath,
    privateRoot,
    groundingModulePath: optionalArgument(args, '--grounder-module'),
  });
  const pipeline = result as {
    readonly pipeline?: { readonly id?: unknown; readonly version?: unknown };
    readonly measurements?: readonly unknown[];
  };
  process.stdout.write(
    `${JSON.stringify({
      pipeline:
        typeof pipeline.pipeline?.id === 'string' && typeof pipeline.pipeline.version === 'string'
          ? { id: pipeline.pipeline.id, version: pipeline.pipeline.version }
          : undefined,
      measurements: pipeline.measurements?.length ?? 0,
    })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('source-grounding-postprocess failed\n');
    process.exitCode = 1;
  });
}
