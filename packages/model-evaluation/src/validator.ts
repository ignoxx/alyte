import {
  qwenEvaluationManifest,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  type EvaluationManifest,
} from './manifest';
import type { FixtureObservation } from './fixtures';
import {
  authoritativeFieldNames,
  catalogueEntryFor,
  isEvaluationOutput,
  isKnownBiomarkerId,
  isSemanticRole,
  isSpecimenType,
  specimenCompatible,
  type EvaluationOutput,
  type EvaluationProposal,
} from './schema';

export const VALIDATION_FAILURE_CODES = [
  'circular-output',
  'oversized-output',
  'malformed-schema',
  'extra-field',
  'authoritative-field',
  'unknown-source-id',
  'unknown-biomarker-id',
  'duplicate-source-observation',
  'duplicate-source-row',
  'invalid-role',
  'invalid-specimen',
  'invalid-biomarker-role',
  'incompatible-specimen',
  'oversized-proposal',
] as const;

export type ValidationFailureCode = (typeof VALIDATION_FAILURE_CODES)[number];

export type ValidationFailure = {
  readonly code: ValidationFailureCode;
  readonly proposalIndex: number | null;
};

export type AcceptedProposal = EvaluationProposal & {
  readonly rowId: string;
};

export type ValidationResult = {
  readonly accepted: readonly AcceptedProposal[];
  readonly failures: readonly ValidationFailure[];
  readonly outputBytes: number | null;
  readonly rejected: boolean;
};

type SerializationResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly code: 'circular-output' | 'malformed-schema' };

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Safely measures untrusted provider output without retaining the raw response. */
function measureCanonicalJson(value: unknown): SerializationResult {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > 24) throw new Error('depth');
    if (candidate === null || typeof candidate !== 'object') {
      if (typeof candidate === 'number' && !Number.isFinite(candidate)) throw new Error('number');
      if (
        typeof candidate === 'undefined' ||
        typeof candidate === 'function' ||
        typeof candidate === 'symbol'
      ) {
        throw new Error('type');
      }
      return candidate;
    }
    if (seen.has(candidate)) throw new Error('cycle');
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const result = candidate.map((item) => visit(item, depth + 1));
      seen.delete(candidate);
      return result;
    }
    const source = candidate as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
      result[key] = visit(source[key], depth + 1);
    }
    seen.delete(candidate);
    return result;
  };

  try {
    const canonical = JSON.stringify(visit(value, 0));
    if (canonical === undefined) return { ok: false, code: 'malformed-schema' };
    return { ok: true, bytes: utf8ByteLength(canonical) };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && error.message === 'cycle'
          ? 'circular-output'
          : 'malformed-schema',
    };
  }
}

function failure(code: ValidationFailureCode, proposalIndex: number | null): ValidationFailure {
  return { code, proposalIndex };
}

function objectKeys(value: object): string[] {
  return Object.keys(value);
}

/**
 * One authoritative boundary for model output. It rejects the complete response for malformed,
 * cyclic, or oversized envelopes, while independently rejecting unsafe proposals and counting why.
 */
export function validateEvaluationOutput(
  raw: unknown,
  observations: readonly FixtureObservation[],
  manifest: EvaluationManifest = qwenEvaluationManifest,
): ValidationResult {
  const measured = measureCanonicalJson(raw);
  if (!measured.ok) {
    return {
      accepted: [],
      failures: [failure(measured.code, null)],
      outputBytes: null,
      rejected: true,
    };
  }
  if (measured.bytes > manifest.prompt.maxOutputBytes) {
    return {
      accepted: [],
      failures: [failure('oversized-output', null)],
      outputBytes: measured.bytes,
      rejected: true,
    };
  }
  if (!isEvaluationOutput(raw)) {
    return {
      accepted: [],
      failures: [failure('malformed-schema', null)],
      outputBytes: measured.bytes,
      rejected: true,
    };
  }

  const output = raw as EvaluationOutput;
  const sourceById = new Map(observations.map((observation) => [observation.id, observation]));
  const consumedRows = new Set<string>();
  const accepted: AcceptedProposal[] = [];
  const failures: ValidationFailure[] = [];
  if (output.proposals.length > manifest.prompt.maxProposals) {
    failures.push(failure('oversized-output', null));
    return { accepted: [], failures, outputBytes: measured.bytes, rejected: true };
  }

  output.proposals.forEach((proposal, proposalIndex) => {
    if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
      failures.push(failure('malformed-schema', proposalIndex));
      return;
    }
    const candidate = proposal as unknown as Record<string, unknown>;
    const keys = objectKeys(candidate);
    const extra = keys.filter(
      (key) => !['sourceObservationIds', 'role', 'specimenType', 'biomarkerId'].includes(key),
    );
    if (extra.length > 0) {
      failures.push(
        ...extra.map((key) =>
          failure(
            authoritativeFieldNames.has(key) ? 'authoritative-field' : 'extra-field',
            proposalIndex,
          ),
        ),
      );
      return;
    }
    if (
      keys.length !== 4 ||
      !('sourceObservationIds' in candidate) ||
      !('role' in candidate) ||
      !('specimenType' in candidate) ||
      !('biomarkerId' in candidate)
    ) {
      failures.push(failure('malformed-schema', proposalIndex));
      return;
    }
    if (!isSemanticRole(candidate.role)) {
      failures.push(failure('invalid-role', proposalIndex));
      return;
    }
    if (!isSpecimenType(candidate.specimenType)) {
      failures.push(failure('invalid-specimen', proposalIndex));
      return;
    }
    if (candidate.biomarkerId !== null && typeof candidate.biomarkerId !== 'string') {
      failures.push(failure('unknown-biomarker-id', proposalIndex));
      return;
    }
    const biomarkerId = candidate.biomarkerId as string | null;
    if (!isKnownBiomarkerId(biomarkerId)) {
      failures.push(failure('unknown-biomarker-id', proposalIndex));
      return;
    }
    if (
      (candidate.role === 'measurement' && biomarkerId === null) ||
      (candidate.role !== 'measurement' && biomarkerId !== null)
    ) {
      failures.push(failure('invalid-biomarker-role', proposalIndex));
      return;
    }
    if (
      !Array.isArray(candidate.sourceObservationIds) ||
      candidate.sourceObservationIds.length === 0 ||
      candidate.sourceObservationIds.length > 8 ||
      candidate.sourceObservationIds.some(
        (id) => typeof id !== 'string' || id.length === 0 || id.length > 96,
      )
    ) {
      failures.push(failure('oversized-proposal', proposalIndex));
      return;
    }
    const sourceObservationIds = candidate.sourceObservationIds as string[];
    if (new Set(sourceObservationIds).size !== sourceObservationIds.length) {
      failures.push(failure('duplicate-source-observation', proposalIndex));
      return;
    }
    const sourceRows = sourceObservationIds.map((id) => sourceById.get(id));
    if (sourceRows.some((source) => source === undefined)) {
      failures.push(failure('unknown-source-id', proposalIndex));
      return;
    }
    const rowIds = new Set(sourceRows.map((source) => source!.rowId));
    if (rowIds.size !== 1) {
      failures.push(failure('duplicate-source-row', proposalIndex));
      return;
    }
    const rowId = [...rowIds][0]!;
    if (consumedRows.has(rowId)) {
      failures.push(failure('duplicate-source-row', proposalIndex));
      return;
    }
    if (biomarkerId !== null) {
      const entry = catalogueEntryFor(biomarkerId);
      if (entry === null || !specimenCompatible(entry, candidate.specimenType)) {
        failures.push(failure('incompatible-specimen', proposalIndex));
        return;
      }
    }
    consumedRows.add(rowId);
    accepted.push({
      sourceObservationIds,
      role: candidate.role,
      specimenType: candidate.specimenType,
      biomarkerId,
      rowId,
    });
  });

  return { accepted, failures, outputBytes: measured.bytes, rejected: failures.length > 0 };
}

export function countFailures(
  failures: readonly ValidationFailure[],
): Readonly<Record<ValidationFailureCode, number>> {
  return Object.freeze(
    Object.fromEntries(
      VALIDATION_FAILURE_CODES.map((code) => [
        code,
        failures.filter((failure) => failure.code === code).length,
      ]),
    ) as Record<ValidationFailureCode, number>,
  );
}

export const validatorMetadata = Object.freeze({ schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION });
