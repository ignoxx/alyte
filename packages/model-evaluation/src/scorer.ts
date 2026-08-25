import type { SemanticEvaluationFixture } from './fixtures';
import { qwenEvaluationManifest, type EvaluationManifest } from './manifest';
import {
  countFailures,
  validateEvaluationOutput,
  type AcceptedProposal,
  type ValidationFailureCode,
} from './validator';

export type FixtureScore = {
  readonly fixtureId: string;
  readonly language: string;
  readonly expectedRows: number;
  readonly modelReferencedRows: number;
  readonly acceptedProposals: number;
  readonly correctAcceptedProposals: number;
  readonly modelRecall: number;
  readonly acceptedEndToEndPrecision: number;
  readonly exactSourceValueUnitIntervalPreservation: number;
  readonly exactSourceFactsPreserved: number;
  readonly rowsNeedingReview: number;
  readonly reviewBurdenRate: number;
  readonly failureCounts: Readonly<Record<ValidationFailureCode, number>>;
};

export type AggregateQuality = {
  readonly fixtureCount: number;
  readonly languageCount: number;
  readonly expectedRows: number;
  readonly modelReferencedRows: number;
  readonly acceptedProposals: number;
  readonly correctAcceptedProposals: number;
  readonly modelRecall: number;
  readonly acceptedEndToEndPrecision: number;
  readonly exactSourceValueUnitIntervalPreservation: number;
  readonly exactSourceFactsPreserved: number;
  readonly rowsNeedingReview: number;
  readonly reviewBurdenRate: number;
  readonly failureCounts: Readonly<Record<ValidationFailureCode, number>>;
};

export type DeviceMetricSnapshot = {
  readonly deviceClass: 'current' | 'floor';
  readonly deviceModel: string;
  readonly osVersion: string;
  readonly coldLoadMs: number | null;
  readonly warmInferenceMsP50: number | null;
  readonly warmInferenceMsP95: number | null;
  readonly peakMemoryBytes: number | null;
  readonly thermalState: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  readonly packBytes: number;
  readonly runtimeBytes: number;
  readonly capturedAt: string;
};

export type EvaluationAggregateReport = {
  readonly reportVersion:
    'alyte.qwen-evaluation.aggregate.v1' | 'alyte.model-evaluation.aggregate.v1';
  readonly provenance: {
    readonly manifestVersion: string;
    readonly modelId: string;
    readonly modelRepository: string;
    readonly modelRevision: string;
    readonly modelFilename: string;
    readonly modelSha256: string;
    readonly runtimeId: string;
    readonly runtimeRepository: string;
    readonly runtimeRevision: string;
    readonly schemaVersion: string;
    readonly ocrChunkVersion: string;
    readonly catalogueVersion: string;
    readonly contextWindowTokens: number;
    readonly outputTokenLimit: number;
    readonly maxOutputBytes: number;
    readonly temperature: number;
    readonly thinking: boolean;
  };
  readonly quality: AggregateQuality;
  readonly devices: readonly DeviceMetricSnapshot[];
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function lenientReferencedRows(fixture: SemanticEvaluationFixture, raw: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new Set();
  const proposals = (raw as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposals)) return new Set();
  const sourceRows = new Map(
    fixture.observations.map((observation) => [observation.id, observation.rowId]),
  );
  const referenced = new Set<string>();
  for (const proposal of proposals) {
    if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) continue;
    const ids = (proposal as { sourceObservationIds?: unknown }).sourceObservationIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const rowId = sourceRows.get(id);
      if (rowId !== undefined) referenced.add(rowId);
    }
  }
  return referenced;
}

function correctAcceptedCount(
  fixture: SemanticEvaluationFixture,
  accepted: readonly AcceptedProposal[],
): number {
  return accepted.filter((proposal) => {
    const expected = fixture.expected.find((candidate) => candidate.rowId === proposal.rowId);
    return (
      expected !== undefined &&
      proposal.role === expected.role &&
      proposal.specimenType === expected.specimenType &&
      proposal.biomarkerId === expected.biomarkerId
    );
  }).length;
}

function exactSourceFactsPreservedCount(
  fixture: SemanticEvaluationFixture,
  accepted: readonly AcceptedProposal[],
): number {
  return accepted.filter((proposal) => {
    const expected = fixture.expected.find((candidate) => candidate.rowId === proposal.rowId);
    return (
      expected !== undefined &&
      expected.sourceFactObservationIds.every((id) => proposal.sourceObservationIds.includes(id))
    );
  }).length;
}

export function scoreEvaluationFixture(
  fixture: SemanticEvaluationFixture,
  rawModelOutput: unknown,
  manifest: EvaluationManifest = qwenEvaluationManifest,
): FixtureScore {
  const validation = validateEvaluationOutput(rawModelOutput, fixture.observations, manifest);
  const modelReferencedRows = lenientReferencedRows(fixture, rawModelOutput);
  const correctAcceptedProposals = correctAcceptedCount(fixture, validation.accepted);
  const exactSourceFactsPreserved = exactSourceFactsPreservedCount(fixture, validation.accepted);
  const failureCounts = countFailures(validation.failures);
  const rowsNeedingReview = Math.max(0, fixture.expected.length - correctAcceptedProposals);
  return {
    fixtureId: fixture.id,
    language: fixture.language,
    expectedRows: fixture.expected.length,
    modelReferencedRows: modelReferencedRows.size,
    acceptedProposals: validation.accepted.length,
    correctAcceptedProposals,
    modelRecall: ratio(modelReferencedRows.size, fixture.expected.length),
    acceptedEndToEndPrecision: ratio(correctAcceptedProposals, validation.accepted.length),
    exactSourceValueUnitIntervalPreservation: ratio(
      exactSourceFactsPreserved,
      validation.accepted.length,
    ),
    exactSourceFactsPreserved,
    rowsNeedingReview,
    reviewBurdenRate: ratio(rowsNeedingReview, fixture.expected.length),
    failureCounts,
  };
}

function sumFailureCounts(
  scores: readonly FixtureScore[],
): Readonly<Record<ValidationFailureCode, number>> {
  const result = Object.fromEntries(
    Object.keys(scores[0]?.failureCounts ?? {}).map((code) => [code, 0]),
  ) as Record<ValidationFailureCode, number>;
  for (const score of scores) {
    for (const [code, count] of Object.entries(score.failureCounts)) {
      result[code as ValidationFailureCode] = (result[code as ValidationFailureCode] ?? 0) + count;
    }
  }
  return Object.freeze(result);
}

export function aggregateFixtureScores(scores: readonly FixtureScore[]): AggregateQuality {
  const expectedRows = scores.reduce((sum, score) => sum + score.expectedRows, 0);
  const modelReferencedRows = scores.reduce((sum, score) => sum + score.modelReferencedRows, 0);
  const acceptedProposals = scores.reduce((sum, score) => sum + score.acceptedProposals, 0);
  const correctAcceptedProposals = scores.reduce(
    (sum, score) => sum + score.correctAcceptedProposals,
    0,
  );
  const exactSourceFactsPreserved = scores.reduce(
    (sum, score) => sum + score.exactSourceFactsPreserved,
    0,
  );
  const rowsNeedingReview = scores.reduce((sum, score) => sum + score.rowsNeedingReview, 0);
  return {
    fixtureCount: scores.length,
    languageCount: new Set(scores.map((score) => score.language)).size,
    expectedRows,
    modelReferencedRows,
    acceptedProposals,
    correctAcceptedProposals,
    modelRecall: ratio(modelReferencedRows, expectedRows),
    acceptedEndToEndPrecision: ratio(correctAcceptedProposals, acceptedProposals),
    exactSourceValueUnitIntervalPreservation: ratio(exactSourceFactsPreserved, acceptedProposals),
    exactSourceFactsPreserved,
    rowsNeedingReview,
    reviewBurdenRate: ratio(rowsNeedingReview, expectedRows),
    failureCounts: sumFailureCounts(scores),
  };
}

export function buildAggregateReport(
  scores: readonly FixtureScore[],
  devices: readonly DeviceMetricSnapshot[] = [],
  manifest: EvaluationManifest = qwenEvaluationManifest,
): EvaluationAggregateReport {
  const reportVersion =
    manifest.manifestVersion === qwenEvaluationManifest.manifestVersion
      ? 'alyte.qwen-evaluation.aggregate.v1'
      : 'alyte.model-evaluation.aggregate.v1';
  return {
    reportVersion,
    provenance: {
      manifestVersion: manifest.manifestVersion,
      modelId: manifest.model.id,
      modelRepository: manifest.model.repository,
      modelRevision: manifest.model.revision,
      modelFilename: manifest.model.filename,
      modelSha256: manifest.model.sha256,
      runtimeId: manifest.runtime.id,
      runtimeRepository: manifest.runtime.repository,
      runtimeRevision: manifest.runtime.revision,
      schemaVersion: manifest.prompt.schemaVersion,
      ocrChunkVersion: manifest.prompt.ocrChunkVersion,
      catalogueVersion: manifest.prompt.catalogueVersion,
      contextWindowTokens: manifest.prompt.contextWindowTokens,
      outputTokenLimit: manifest.prompt.outputTokenLimit,
      maxOutputBytes: manifest.prompt.maxOutputBytes,
      temperature: manifest.prompt.temperature,
      thinking: manifest.prompt.thinking,
    },
    quality: aggregateFixtureScores(scores),
    devices,
  };
}

export function serializeAggregateReport(report: EvaluationAggregateReport): string {
  return JSON.stringify(report);
}
