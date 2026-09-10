import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  parsePipelineResult,
  readJsonFile,
  sha256File,
  writeJsonFile,
  type PipelineResult,
} from './contract';
import { groundVisionProposals, type GroundingResult, type VisionPage } from './qwen35-grounding';
import {
  verifyRawSnapshotBinding,
  type RawSnapshotBinding,
  type RawSnapshotEnvelope,
  type RawSnapshotIdentity,
} from './raw-snapshot-binding';
import {
  applyCollectionDateMetadata,
  COLLECTION_DATE_METADATA_ALGORITHM_VERSION,
  COLLECTION_DATE_METADATA_SCHEMA_VERSION,
} from './metadata-attachment';
import { proposeCollectionDateMetadata, type MetadataObservation } from './metadata-proposals';

export const GROUNDING_SCRIPT_VERSION = 'qwen35-grounding-run.v2' as const;

type RawVisionPage = {
  readonly pageIndex: number;
  readonly result?: { readonly observations?: readonly Record<string, unknown>[] };
};

type RawVisionArtifact = { readonly pages?: readonly RawVisionPage[] };

type VerifiedRawVision = {
  readonly envelope: RawSnapshotEnvelope;
  readonly binding: RawSnapshotBinding;
};

function argument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function usage(): never {
  throw new Error(
    'usage: qwen35-grounding-run --proposals path --vision path [--binding path] [--metadata-proposals path] --output path --private-root path',
  );
}

function defaultBindingPath(visionPath: string): string {
  return visionPath.endsWith('.json')
    ? visionPath.replace(/\.json$/u, '.binding.json')
    : `${visionPath}.binding.json`;
}

function defaultMetadataProposalsPath(outputPath: string): string {
  return outputPath.endsWith('.json')
    ? outputPath.replace(/\.json$/u, '.collection-date-metadata.json')
    : `${outputPath}.collection-date-metadata.json`;
}

function identityFromBinding(value: unknown): RawSnapshotIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('grounding-binding-invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    reportSha256: record.reportSha256 as string,
    readerVersion: record.readerVersion as string,
    runtimeVersion: record.runtimeVersion as string,
    readerBinarySha256: record.readerBinarySha256 as string,
    readerSourceSha256: record.readerSourceSha256 as string,
  };
}

function verifiedRawVision(
  visionPath: string,
  bindingPath: string,
  privateRoot: string,
  proposalReportSha256: string,
): VerifiedRawVision {
  assertPrivatePath(visionPath, privateRoot);
  assertPrivatePath(bindingPath, privateRoot);
  if (!exists(visionPath)) throw new Error('grounding-vision-missing');
  if (!exists(bindingPath)) throw new Error('grounding-binding-missing');

  let rawText: string;
  try {
    rawText = readFileSync(visionPath, 'utf8');
  } catch {
    throw new Error('grounding-vision-read-failed');
  }
  let bindingValue: unknown;
  try {
    bindingValue = readJsonFile(bindingPath);
  } catch {
    throw new Error('grounding-binding-invalid');
  }

  const identity = identityFromBinding(bindingValue);
  let envelope: RawSnapshotEnvelope;
  try {
    envelope = verifyRawSnapshotBinding(rawText, bindingValue, identity);
  } catch (error) {
    if (error instanceof Error && /^raw-snapshot-[a-z-]+$/u.test(error.message)) {
      throw new Error(`grounding-${error.message}`);
    }
    throw new Error('grounding-binding-invalid');
  }
  if (envelope.reportSha256 !== proposalReportSha256) {
    throw new Error('grounding-report-binding-mismatch');
  }

  const record = bindingValue as Record<string, unknown>;
  return {
    envelope,
    binding: {
      schemaVersion: record.schemaVersion as RawSnapshotBinding['schemaVersion'],
      ...identity,
      snapshotSha256: record.snapshotSha256 as string,
    },
  };
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function groundingScriptProvenance(): Record<string, string> {
  const scriptPath = fileURLToPath(import.meta.url);
  return {
    version: GROUNDING_SCRIPT_VERSION,
    scriptSha256: sha256File(scriptPath),
    algorithmSha256: sha256File(resolve(dirname(scriptPath), 'qwen35-grounding.ts')),
  };
}

function visionPages(value: unknown): readonly VisionPage[] {
  if (
    value === null ||
    typeof value !== 'object' ||
    !Array.isArray((value as RawVisionArtifact).pages)
  ) {
    throw new Error('invalid Vision artifact');
  }
  return (value as RawVisionArtifact).pages!.map((page) => ({
    pageIndex: page.pageIndex,
    observations: (page.result?.observations ?? []).map((observation) => ({
      id: String(observation.id ?? ''),
      text: String(observation.text ?? ''),
      pageIndex: page.pageIndex,
      structure:
        observation.structure !== null && typeof observation.structure === 'object'
          ? (observation.structure as VisionPage['observations'][number]['structure'])
          : undefined,
      boundingBox:
        observation.boundingBox !== null && typeof observation.boundingBox === 'object'
          ? (observation.boundingBox as VisionPage['observations'][number]['boundingBox'])
          : undefined,
      spans: Array.isArray(observation.spans)
        ? (observation.spans as VisionPage['observations'][number]['spans'])
        : undefined,
      sourceStart:
        typeof observation.sourceStart === 'number' ? observation.sourceStart : undefined,
      sourceEnd: typeof observation.sourceEnd === 'number' ? observation.sourceEnd : undefined,
    })),
  }));
}

function metadataObservations(pages: readonly VisionPage[]): readonly MetadataObservation[] {
  return pages.flatMap((page) =>
    page.observations.flatMap((observation) => {
      if (observation.id.length === 0 || observation.boundingBox === undefined) return [];
      return [
        {
          id: observation.id,
          text: observation.text,
          pageIndex: page.pageIndex,
          boundingBox: observation.boundingBox,
          locale: null,
          structure: observation.structure,
          spans: observation.spans,
        },
      ];
    }),
  );
}

const REPLAY_STAGE_NAMES = new Set([
  'source-binding-verification',
  'source-grounding',
  'metadata-proposals',
  'metadata-attachment',
]);
const REPLAY_CONFIGURATION_KEYS = new Set([
  'source',
  'sourceSnapshot',
  'groundingScript',
  'modelRowsAuthoritative',
  'maxSpanGap',
  'lineGap',
  'numericMatching',
  'crossLineAssociation',
  'resultColumn',
  'unitMatching',
  'collectionDateMetadata',
]);

function prepareReplayInput(input: PipelineResult): PipelineResult {
  const stages = input.stages.filter((stage) => !REPLAY_STAGE_NAMES.has(stage.name));
  const removedElapsedMs = input.stages
    .filter((stage) => REPLAY_STAGE_NAMES.has(stage.name))
    .reduce((total, stage) => total + stage.elapsedMs, 0);
  const configuration = Object.fromEntries(
    Object.entries(input.pipeline.configuration).filter(
      ([key]) => !REPLAY_CONFIGURATION_KEYS.has(key),
    ),
  );
  const counts = Object.fromEntries(
    Object.entries(input.diagnostics.counts).filter(
      ([key]) => !key.startsWith('sourceGrounding') && !key.startsWith('collectionDateMetadata'),
    ),
  );
  const limitations = input.diagnostics.limitations.filter(
    (limitation) =>
      limitation !==
        'Evaluation-only grounding accepts model label/value pairs only when native observations provide one unique row or contiguous span.' &&
      limitation !==
        'Collection date, specimen, and biomarker mapping remain unresolved without explicit source evidence.' &&
      limitation !==
        'Collection-date metadata attaches only a unique source-grounded page context; collectionGroup remains unresolved.',
  );
  return {
    ...input,
    pipeline: {
      ...input.pipeline,
      id: input.pipeline.id.replace(/(?:\.grounded)+$/u, ''),
      version: input.pipeline.version.replace(/(?:\+source-grounded)+$/u, ''),
      configuration,
    },
    stages,
    elapsedMs: Math.max(0, input.elapsedMs - removedElapsedMs),
    diagnostics: { counts, limitations },
  };
}

function executeGrounding(options: {
  readonly proposalsPath: string;
  readonly visionPath: string;
  readonly bindingPath?: string;
  readonly metadataProposalsPath?: string;
  readonly outputPath: string;
  readonly privateRoot: string;
}): { readonly result: PipelineResult; readonly grounded: GroundingResult } {
  const proposalsPath = resolve(options.proposalsPath);
  const visionPath = resolve(options.visionPath);
  const outputPath = resolve(options.outputPath);
  const privateRoot = resolve(options.privateRoot);
  const bindingPath = resolve(options.bindingPath ?? defaultBindingPath(visionPath));
  const metadataProposalsPath = resolve(
    options.metadataProposalsPath ?? defaultMetadataProposalsPath(outputPath),
  );
  if (
    metadataProposalsPath === outputPath ||
    metadataProposalsPath === proposalsPath ||
    metadataProposalsPath === visionPath ||
    metadataProposalsPath === bindingPath
  ) {
    throw new Error('grounding-metadata-output-conflict');
  }
  assertPrivatePath(proposalsPath, privateRoot);
  assertPrivatePath(visionPath, privateRoot);
  assertPrivatePath(bindingPath, privateRoot);
  assertPrivatePath(metadataProposalsPath, privateRoot);
  assertPrivatePath(outputPath, privateRoot);
  ensurePrivateDirectory(dirname(outputPath));
  ensurePrivateDirectory(dirname(metadataProposalsPath));

  const proposals = prepareReplayInput(parsePipelineResult(readJsonFile(proposalsPath)));
  const bindingStarted = performance.now();
  const verified = verifiedRawVision(visionPath, bindingPath, privateRoot, proposals.reportSha256);
  const vision = visionPages(verified.envelope);
  const bindingElapsedMs = Math.max(0, performance.now() - bindingStarted);
  const groundingStarted = performance.now();
  const grounded = groundVisionProposals(proposals.measurements, vision);
  const groundingElapsedMs = Math.max(0, performance.now() - groundingStarted);
  const metadataInput = metadataObservations(vision);
  const metadataProposalStarted = performance.now();
  const metadata = proposeCollectionDateMetadata(metadataInput);
  const metadataProposalElapsedMs = Math.max(0, performance.now() - metadataProposalStarted);
  const metadataAttachmentStarted = performance.now();
  const metadataApplication = applyCollectionDateMetadata(
    grounded.measurements,
    metadata,
    metadataInput.length,
  );
  const metadataAttachmentElapsedMs = Math.max(0, performance.now() - metadataAttachmentStarted);
  const sourceSnapshot = {
    schemaVersion: verified.binding.schemaVersion,
    snapshotSha256: verified.binding.snapshotSha256,
    reportSha256: verified.binding.reportSha256,
    readerVersion: verified.binding.readerVersion,
    runtimeVersion: verified.binding.runtimeVersion,
    readerBinarySha256: verified.binding.readerBinarySha256,
    readerSourceSha256: verified.binding.readerSourceSha256,
  };
  const metadataAlgorithmSha256 = sha256File(
    resolve(dirname(fileURLToPath(import.meta.url)), 'metadata-proposals.ts'),
  );
  const metadataAttachmentAlgorithmSha256 = sha256File(
    resolve(dirname(fileURLToPath(import.meta.url)), 'metadata-attachment.ts'),
  );
  const metadataArtifact = {
    schemaVersion: COLLECTION_DATE_METADATA_SCHEMA_VERSION,
    reportId: proposals.reportId,
    reportSha256: proposals.reportSha256,
    sourceSnapshot,
    algorithm: {
      version: COLLECTION_DATE_METADATA_ALGORITHM_VERSION,
      proposalSha256: metadataAlgorithmSha256,
      attachmentSha256: metadataAttachmentAlgorithmSha256,
      sha256: metadataAlgorithmSha256,
    },
    timingMs: {
      proposal: metadataProposalElapsedMs,
      attachment: metadataAttachmentElapsedMs,
    },
    observations: metadataInput.length,
    metadata,
    diagnostics: metadataApplication.diagnostics,
  };
  writeJsonFile(metadataProposalsPath, metadataArtifact);
  const metadataArtifactSha256 = sha256File(metadataProposalsPath);
  const result: PipelineResult = {
    ...proposals,
    pipeline: {
      ...proposals.pipeline,
      id: `${proposals.pipeline.id}.grounded`,
      version: `${proposals.pipeline.version}+source-grounded`,
      configuration: {
        ...proposals.pipeline.configuration,
        source: 'native-vision-observations',
        sourceSnapshot,
        groundingScript: groundingScriptProvenance(),
        modelRowsAuthoritative: false,
        maxSpanGap: 0.018,
        lineGap: 0.009,
        numericMatching: 'complete-source-token-v2',
        crossLineAssociation: 'contiguous-source-span-only',
        resultColumn: 'header-anchored-when-available',
        unitMatching: 'case-sensitive-native-equivalent-v2',
        collectionDateMetadata: {
          schemaVersion: COLLECTION_DATE_METADATA_SCHEMA_VERSION,
          algorithmVersion: COLLECTION_DATE_METADATA_ALGORITHM_VERSION,
          algorithmSha256: metadataAlgorithmSha256,
          attachmentAlgorithmSha256: metadataAttachmentAlgorithmSha256,
          artifactSha256: metadataArtifactSha256,
          sourceSnapshot,
          timingMs: {
            proposal: metadataProposalElapsedMs,
            attachment: metadataAttachmentElapsedMs,
          },
          attachedMeasurementCount: metadataApplication.diagnostics.attachedMeasurementCount,
          conflictCount: metadataApplication.diagnostics.conflictCount,
        },
      },
    },
    elapsedMs:
      proposals.elapsedMs +
      bindingElapsedMs +
      groundingElapsedMs +
      metadataProposalElapsedMs +
      metadataAttachmentElapsedMs,
    stages: [
      ...proposals.stages,
      {
        name: 'source-binding-verification',
        elapsedMs: bindingElapsedMs,
        inputCount: 1,
        outputCount: vision.length,
        status: 'complete',
      },
      {
        name: 'source-grounding',
        elapsedMs: groundingElapsedMs,
        inputCount: proposals.measurements.length,
        outputCount: grounded.measurements.length,
        status: 'complete',
      },
      {
        name: 'metadata-proposals',
        elapsedMs: metadataProposalElapsedMs,
        inputCount: metadataInput.length,
        outputCount: metadata.proposals.length,
        status: 'complete',
      },
      {
        name: 'metadata-attachment',
        elapsedMs: metadataAttachmentElapsedMs,
        inputCount: grounded.measurements.length,
        outputCount: metadataApplication.measurements.length,
        status: 'complete',
      },
    ],
    measurements: metadataApplication.measurements,
    diagnostics: {
      counts: {
        ...proposals.diagnostics.counts,
        sourceGroundingProposals: grounded.diagnostics.proposalCount,
        sourceGroundingAccepted: grounded.diagnostics.acceptedCount,
        sourceGroundingRejected: grounded.diagnostics.rejectedCount,
        sourceGroundingUnitFromNative: grounded.diagnostics.sourceFieldCounts.unit,
        sourceGroundingReferenceFromNative:
          grounded.diagnostics.sourceFieldCounts.referenceInterval,
        sourceGroundingFlagFromNative: grounded.diagnostics.sourceFieldCounts.flag,
        collectionDateMetadataObservations: metadataApplication.diagnostics.inputObservationCount,
        collectionDateMetadataProposals: metadataApplication.diagnostics.proposalCount,
        collectionDateMetadataKnownPageContexts:
          metadataApplication.diagnostics.knownPageContextCount,
        collectionDateMetadataAttached: metadataApplication.diagnostics.attachedMeasurementCount,
        collectionDateMetadataMatched: metadataApplication.diagnostics.matchingMeasurementCount,
        collectionDateMetadataConflicts: metadataApplication.diagnostics.conflictCount,
        collectionDateMetadataSkipped: metadataApplication.diagnostics.skippedMeasurementCount,
      },
      limitations: [
        ...proposals.diagnostics.limitations,
        'Evaluation-only grounding accepts model label/value pairs only when native observations provide one unique row or contiguous span.',
        'Collection date, specimen, and biomarker mapping remain unresolved without explicit source evidence.',
        'Collection-date metadata attaches only a unique source-grounded page context; collectionGroup remains unresolved.',
      ],
    },
  };
  writeJsonFile(outputPath, result);
  return { result, grounded };
}

export function runGrounding(options: {
  readonly proposalsPath: string;
  readonly visionPath: string;
  readonly bindingPath?: string;
  readonly metadataProposalsPath?: string;
  readonly outputPath: string;
  readonly privateRoot: string;
}): PipelineResult {
  return executeGrounding(options).result;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const proposalsPath = resolve(argument(args, '--proposals'));
  const visionPath = resolve(argument(args, '--vision'));
  const bindingPath = args.includes('--binding')
    ? resolve(argument(args, '--binding'))
    : defaultBindingPath(visionPath);
  const outputPath = resolve(argument(args, '--output'));
  const privateRoot = resolve(argument(args, '--private-root'));
  const { result, grounded } = executeGrounding({
    proposalsPath,
    visionPath,
    bindingPath,
    metadataProposalsPath: args.includes('--metadata-proposals')
      ? resolve(argument(args, '--metadata-proposals'))
      : undefined,
    outputPath,
    privateRoot,
  });
  process.stdout.write(
    `${JSON.stringify({
      proposals: grounded.diagnostics.proposalCount,
      accepted: grounded.diagnostics.acceptedCount,
      rejected: grounded.diagnostics.rejectedCount,
      rejectedByReason: grounded.diagnostics.rejectedByReason,
      acceptedByPage: grounded.diagnostics.acceptedByPage,
      rejectedByPage: grounded.diagnostics.rejectedByPage,
      sourceFields: grounded.diagnostics.sourceFieldCounts,
      metadata: {
        observations: result.diagnostics.counts.collectionDateMetadataObservations,
        proposals: result.diagnostics.counts.collectionDateMetadataProposals,
        knownPageContexts: result.diagnostics.counts.collectionDateMetadataKnownPageContexts,
        attached: result.diagnostics.counts.collectionDateMetadataAttached,
        matched: result.diagnostics.counts.collectionDateMetadataMatched,
        conflicts: result.diagnostics.counts.collectionDateMetadataConflicts,
        skipped: result.diagnostics.counts.collectionDateMetadataSkipped,
      },
    })}\n`,
  );
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath?.endsWith('/qwen35-grounding-run.ts') === true) main();
