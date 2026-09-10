/**
 * Evaluation-only source-context admission.
 *
 * This opt-in wrapper applies the page-level source-context signal after a pipeline has already
 * grounded measurements. Imaging-only pages are excluded from the scored pipeline; unknown and
 * laboratory pages are retained. The excluded rows are written to a private sibling artifact so
 * this experiment cannot silently destroy a prior result.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  readJsonFile,
  securePrivateFile,
  sha256File,
  writeJsonFile,
  type EvaluationMeasurement,
  type PipelineResult,
} from './contract';
import { classifySourceContext, type SourceContextClassification } from './source-context';
import type { VisionObservation, VisionPage } from './qwen35-grounding';

export const SOURCE_CONTEXT_ADMISSION_VERSION = 'alyte.source-context-admission.v1' as const;

type RawSnapshotIdentity = {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

export type RawSnapshotBinding = RawSnapshotIdentity & {
  readonly schemaVersion: string;
  readonly snapshotSha256: string;
};

type RawSnapshotEnvelope = {
  readonly readerVersion: string;
  readonly reportSha256: string;
  readonly runtimeVersion: string;
  readonly pages?: readonly unknown[];
};

export type RawSnapshotBindingModule = {
  readonly verifyRawSnapshotBinding: (
    rawText: string,
    binding: unknown,
    expected: RawSnapshotIdentity,
  ) => RawSnapshotEnvelope;
};

type SourceSnapshotMetadata = RawSnapshotBinding;

export type SourceContextAdmissionResult = {
  readonly pipeline: PipelineResult;
  readonly excludedMeasurements: readonly EvaluationMeasurement[];
  readonly classifications: readonly {
    readonly pageIndex: number;
    readonly classification: SourceContextClassification;
  }[];
  readonly elapsedMs: number;
};

type RecordValue = Record<string, unknown>;
const SHA256 = /^[a-f0-9]{64}$/u;

function record(value: unknown, name: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`source-context-${name}-invalid`);
  }
  return value as RecordValue;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`source-context-${name}-invalid`);
  }
  return value;
}

function requiredHash(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!SHA256.test(result)) throw new Error(`source-context-${name}-invalid`);
  return result;
}

function bindingIdentity(value: unknown): RawSnapshotIdentity {
  const input = record(value, 'binding');
  return {
    reportSha256: requiredHash(input.reportSha256, 'report-hash'),
    readerVersion: requiredString(input.readerVersion, 'reader-version'),
    runtimeVersion: requiredString(input.runtimeVersion, 'runtime-version'),
    readerBinarySha256: requiredHash(input.readerBinarySha256, 'reader-binary-hash'),
    readerSourceSha256: requiredHash(input.readerSourceSha256, 'reader-source-hash'),
  };
}

function bindingRecord(value: unknown): RawSnapshotBinding {
  const input = record(value, 'binding');
  return {
    schemaVersion: requiredString(input.schemaVersion, 'schema-version'),
    ...bindingIdentity(input),
    snapshotSha256: requiredHash(input.snapshotSha256, 'snapshot-hash'),
  };
}

function optionalRecord(value: unknown): RecordValue | undefined {
  return value === null || value === undefined ? undefined : record(value, 'field');
}

function rawVisionPages(value: RawSnapshotEnvelope): readonly VisionPage[] {
  if (!Array.isArray(value.pages)) throw new Error('source-context-pages-invalid');
  const seen = new Set<number>();
  return value.pages.map((item, index) => {
    const page = record(item, 'page');
    if (
      typeof page.pageIndex !== 'number' ||
      !Number.isSafeInteger(page.pageIndex) ||
      page.pageIndex < 0 ||
      page.pageIndex !== index ||
      seen.has(page.pageIndex)
    ) {
      throw new Error('source-context-page-index-invalid');
    }
    seen.add(page.pageIndex);
    const result = optionalRecord(page.result);
    const observationsValue = result?.observations ?? [];
    if (!Array.isArray(observationsValue)) throw new Error('source-context-observations-invalid');
    const pageIndex = page.pageIndex;
    return {
      pageIndex,
      observations: observationsValue.map((item) => {
        const observation = record(item, 'observation');
        if (
          typeof observation.id !== 'string' ||
          typeof observation.text !== 'string' ||
          observation.id.length === 0
        ) {
          throw new Error('source-context-observation-invalid');
        }
        const structure = optionalRecord(observation.structure) as
          VisionObservation['structure'] | undefined;
        const boundingBox = optionalRecord(observation.boundingBox) as
          VisionObservation['boundingBox'] | undefined;
        return {
          id: observation.id,
          text: observation.text,
          pageIndex,
          ...(structure === undefined ? {} : { structure }),
          ...(boundingBox === undefined ? {} : { boundingBox }),
          ...(Array.isArray(observation.spans) ? { spans: observation.spans } : {}),
          ...(typeof observation.sourceStart === 'number'
            ? { sourceStart: observation.sourceStart }
            : {}),
          ...(typeof observation.sourceEnd === 'number'
            ? { sourceEnd: observation.sourceEnd }
            : {}),
        };
      }),
    };
  });
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function excludedOutputPath(outputPath: string): string {
  return outputPath.endsWith('.json')
    ? outputPath.replace(/\.json$/u, '.excluded.json')
    : `${outputPath}.excluded.json`;
}

export function applySourceContextAdmission(options: {
  readonly pipeline: PipelineResult;
  readonly pages: readonly VisionPage[];
  readonly sourceSnapshot: SourceSnapshotMetadata;
  readonly classifierSha256: string;
}): SourceContextAdmissionResult {
  if (!SHA256.test(options.classifierSha256)) {
    throw new Error('source-context-classifier-hash-invalid');
  }
  const started = performance.now();
  const classifications = options.pages.map((page) => ({
    pageIndex: page.pageIndex,
    classification: classifySourceContext(page),
  }));
  const classificationByPage = new Map(
    classifications.map((entry) => [entry.pageIndex, entry.classification.kind]),
  );
  const excludedMeasurements: EvaluationMeasurement[] = [];
  const retainedMeasurements = options.pipeline.measurements.filter((measurement) => {
    const pageIndex = measurement.page === null ? null : measurement.page - 1;
    if (pageIndex !== null && classificationByPage.get(pageIndex) === 'imaging-narrative') {
      excludedMeasurements.push(measurement);
      return false;
    }
    return true;
  });
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const imagingPages = classifications.filter(
    (entry) => entry.classification.kind === 'imaging-narrative',
  ).length;
  const laboratoryPages = classifications.filter(
    (entry) => entry.classification.kind === 'laboratory-table',
  ).length;
  const unknownPages = classifications.filter(
    (entry) => entry.classification.kind === 'unknown',
  ).length;
  const sourceContextConfig = {
    version: SOURCE_CONTEXT_ADMISSION_VERSION,
    classifierSha256: options.classifierSha256,
    sourceSnapshotSha256: options.sourceSnapshot.snapshotSha256,
    sourceSnapshotSchemaVersion: options.sourceSnapshot.schemaVersion,
    sourceReportSha256: options.sourceSnapshot.reportSha256,
    readerVersion: options.sourceSnapshot.readerVersion,
    readerRuntimeVersion: options.sourceSnapshot.runtimeVersion,
    readerBinarySha256: options.sourceSnapshot.readerBinarySha256,
    readerSourceSha256: options.sourceSnapshot.readerSourceSha256,
    timingScope: 'grounded-pipeline-plus-context-admission',
    contextStageElapsedMs: elapsedMs,
    inputMeasurementCount: options.pipeline.measurements.length,
    retainedMeasurementCount: retainedMeasurements.length,
    excludedMeasurementCount: excludedMeasurements.length,
    imagingPageCount: imagingPages,
    laboratoryPageCount: laboratoryPages,
    unknownPageCount: unknownPages,
  } as const;
  const output: PipelineResult = {
    ...options.pipeline,
    pipeline: {
      ...options.pipeline.pipeline,
      version: `${options.pipeline.pipeline.version}.source-context-admission.v1`,
      configuration: {
        ...options.pipeline.pipeline.configuration,
        sourceContextAdmission: sourceContextConfig,
      },
    },
    stages: [
      ...options.pipeline.stages,
      {
        name: 'source-context-admission',
        elapsedMs,
        inputCount: options.pipeline.measurements.length,
        outputCount: retainedMeasurements.length,
        status: 'success',
      },
    ],
    elapsedMs: options.pipeline.elapsedMs + elapsedMs,
    measurements: retainedMeasurements,
    diagnostics: {
      ...options.pipeline.diagnostics,
      counts: {
        ...options.pipeline.diagnostics.counts,
        sourceContextImagingPages: imagingPages,
        sourceContextLaboratoryPages: laboratoryPages,
        sourceContextUnknownPages: unknownPages,
        sourceContextInputMeasurements: options.pipeline.measurements.length,
        sourceContextRetainedMeasurements: retainedMeasurements.length,
        sourceContextExcludedMeasurements: excludedMeasurements.length,
      },
      limitations: [
        ...options.pipeline.diagnostics.limitations,
        'Source-context admission excludes only pages classified as imaging narrative; unknown pages remain retained.',
      ],
    },
  };
  return { pipeline: output, excludedMeasurements, classifications, elapsedMs };
}

async function loadBindingModule(path: string): Promise<RawSnapshotBindingModule> {
  type ImportedBindingModule = {
    readonly verifyRawSnapshotBinding?: RawSnapshotBindingModule['verifyRawSnapshotBinding'];
  };
  const imported = (await import(pathToFileURL(resolve(path)).href)) as ImportedBindingModule;
  if (typeof imported.verifyRawSnapshotBinding !== 'function') {
    throw new Error('source-context-binding-module-invalid');
  }
  return imported as RawSnapshotBindingModule;
}

export async function runSourceContextAdmission(options: {
  readonly reportPath: string;
  readonly pipelinePath: string;
  readonly sourcePath: string;
  readonly bindingPath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly bindingModulePath?: string;
  readonly bindingModule?: RawSnapshotBindingModule;
}): Promise<SourceContextAdmissionResult> {
  const privateRoot = resolve(options.privateRoot);
  const reportPath = assertPrivatePath(options.reportPath, privateRoot);
  const pipelinePath = assertPrivatePath(options.pipelinePath, privateRoot);
  const sourcePath = assertPrivatePath(options.sourcePath, privateRoot);
  const bindingPath = assertPrivatePath(options.bindingPath, privateRoot);
  const outputPath = assertPrivatePath(options.outputPath, privateRoot);
  const excludedPath = assertPrivatePath(excludedOutputPath(outputPath), privateRoot);
  const inputPaths = [reportPath, pipelinePath, sourcePath, bindingPath];
  const nearestExistingDirectory = (path: string): string => {
    let candidate = dirname(path);
    while (!existsSync(candidate)) {
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error('source-context-private-path-invalid');
      candidate = parent;
    }
    return candidate;
  };
  const realCandidate = (path: string): string => {
    if (existsSync(path)) return realpathSync(path);
    const ancestor = nearestExistingDirectory(path);
    return resolve(realpathSync(ancestor), relative(ancestor, path));
  };
  const inputCandidates = new Set(inputPaths.map(realCandidate));
  if (
    inputCandidates.has(realCandidate(outputPath)) ||
    inputCandidates.has(realCandidate(excludedPath))
  ) {
    throw new Error('source-context-output-collides-with-input');
  }
  if (lstatSync(outputPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('source-context-output-already-exists');
  }
  if (lstatSync(excludedPath, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('source-context-excluded-already-exists');
  }
  securePrivateFile(reportPath);
  securePrivateFile(pipelinePath);
  securePrivateFile(sourcePath);
  securePrivateFile(bindingPath);
  const reportSha256 = sha256File(reportPath);
  const pipeline = parsePipelineResult(readJsonFile(pipelinePath));
  if (pipeline.reportSha256 !== reportSha256) {
    throw new Error('source-context-report-binding-mismatch');
  }
  let rawText: string;
  try {
    rawText = readFileSync(sourcePath, 'utf8');
  } catch {
    throw new Error('source-context-source-read-failed');
  }
  const bindingValue = readJsonFile(bindingPath);
  const snapshotBinding = bindingRecord(bindingValue);
  if (snapshotBinding.reportSha256 !== reportSha256) {
    throw new Error('source-context-report-binding-mismatch');
  }
  const module = options.bindingModule
    ? options.bindingModule
    : await loadBindingModule(
        options.bindingModulePath ??
          resolve(dirname(fileURLToPath(import.meta.url)), 'raw-snapshot-binding.ts'),
      );
  const envelope = module.verifyRawSnapshotBinding(
    rawText,
    bindingValue,
    bindingIdentity(snapshotBinding),
  );
  if (
    envelope.reportSha256 !== reportSha256 ||
    envelope.readerVersion !== snapshotBinding.readerVersion ||
    envelope.runtimeVersion !== snapshotBinding.runtimeVersion
  ) {
    throw new Error('source-context-report-binding-mismatch');
  }
  if (hashText(rawText) !== snapshotBinding.snapshotSha256) {
    throw new Error('source-context-snapshot-content-mismatch');
  }
  const classifierPath = resolve(dirname(fileURLToPath(import.meta.url)), 'source-context.ts');
  const classifierSha256 = sha256File(classifierPath);
  const sourceSnapshot = snapshotBinding;
  const result = applySourceContextAdmission({
    pipeline,
    pages: rawVisionPages(envelope),
    sourceSnapshot,
    classifierSha256,
  });
  if (sha256File(reportPath) !== reportSha256) {
    throw new Error('source-context-report-mutated');
  }
  if (sha256File(sourcePath) !== snapshotBinding.snapshotSha256) {
    throw new Error('source-context-source-mutated');
  }
  ensurePrivateDirectory(dirname(outputPath));
  ensurePrivateDirectory(dirname(excludedPath));
  writeJsonFile(outputPath, result.pipeline);
  writeJsonFile(excludedPath, {
    schemaVersion: 'alyte.import-eval.source-context-excluded.v1',
    reportId: result.pipeline.reportId,
    reportSha256,
    sourceContext: result.pipeline.pipeline.configuration.sourceContextAdmission,
    pages: result.classifications,
    excludedMeasurements: result.excludedMeasurements,
  });
  return result;
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function defaultBindingPath(sourcePath: string): string {
  return sourcePath.endsWith('.json')
    ? sourcePath.replace(/\.json$/u, '.binding.json')
    : `${sourcePath}.binding.json`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reportPath = argument(args, '--report');
  const pipelinePath = argument(args, '--pipeline');
  const sourcePath = argument(args, '--source');
  const outputPath = argument(args, '--output');
  const privateRoot = argument(args, '--private-root');
  if (!reportPath || !pipelinePath || !sourcePath || !outputPath || !privateRoot) {
    throw new Error('--report, --pipeline, --source, --output, and --private-root are required');
  }
  const bindingPath = argument(args, '--binding') ?? defaultBindingPath(resolve(sourcePath));
  const result = await runSourceContextAdmission({
    reportPath,
    pipelinePath,
    sourcePath,
    bindingPath,
    outputPath,
    privateRoot,
    ...(argument(args, '--binding-module') === undefined
      ? {}
      : { bindingModulePath: argument(args, '--binding-module') }),
  });
  process.stdout.write(
    `${JSON.stringify({
      elapsedMs: result.elapsedMs,
      excludedMeasurements: result.excludedMeasurements.length,
      imagingPages: result.classifications.filter(
        (entry) => entry.classification.kind === 'imaging-narrative',
      ).length,
      retainedMeasurements: result.pipeline.measurements.length,
    })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('source-context-admission failed\n');
    process.exitCode = 1;
  });
}
