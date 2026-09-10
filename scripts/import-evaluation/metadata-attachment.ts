import type { EvaluationMeasurement } from './contract';
import type {
  CollectionDateMetadataResult,
  CollectionDateProposal,
  MetadataObservation,
} from './metadata-proposals';
import { proposeCollectionDateMetadata } from './metadata-proposals';

export const COLLECTION_DATE_METADATA_SCHEMA_VERSION =
  'alyte.import-eval.collection-date-metadata.v1' as const;
export const COLLECTION_DATE_METADATA_ALGORITHM_VERSION = 'collection-date-page-v1' as const;

export type CollectionDateAttachmentDiagnostics = {
  readonly inputObservationCount: number;
  readonly proposalCount: number;
  readonly knownPageContextCount: number;
  readonly attachedMeasurementCount: number;
  readonly matchingMeasurementCount: number;
  readonly conflictCount: number;
  readonly skippedMeasurementCount: number;
};

export type CollectionDateAttachmentResult = {
  readonly measurements: readonly EvaluationMeasurement[];
  readonly metadata: CollectionDateMetadataResult;
  readonly diagnostics: CollectionDateAttachmentDiagnostics;
};

export type CollectionDateAttachmentApplication = {
  readonly measurements: readonly EvaluationMeasurement[];
  readonly diagnostics: CollectionDateAttachmentDiagnostics;
};

/**
 * Derive collection dates from native source observations and attach only unique page contexts.
 * Collection groups remain untouched because a date alone does not prove event identity.
 */
export function attachCollectionDateMetadata(
  measurements: readonly EvaluationMeasurement[],
  observations: readonly MetadataObservation[],
): CollectionDateAttachmentResult {
  const metadata = proposeCollectionDateMetadata(observations);
  const application = applyCollectionDateMetadata(measurements, metadata, observations.length);
  return { metadata, ...application };
}

export function applyCollectionDateMetadata(
  measurements: readonly EvaluationMeasurement[],
  metadata: CollectionDateMetadataResult,
  inputObservationCount = 0,
): CollectionDateAttachmentApplication {
  const knownPageContexts = metadata.pageContexts.filter(
    (context) => context.reason === 'unique-page-date-pair' && context.state.kind === 'known',
  );
  const contextByPage = new Map(knownPageContexts.map((context) => [context.pageIndex, context]));
  const proposalById = new Map(metadata.proposals.map((proposal) => [proposal.id, proposal]));
  let attachedMeasurementCount = 0;
  let matchingMeasurementCount = 0;
  let conflictCount = 0;
  let skippedMeasurementCount = 0;

  const attached = measurements.map((measurement) => {
    const pageIndex = measurement.page === null ? null : measurement.page - 1;
    const context = pageIndex === null ? undefined : contextByPage.get(pageIndex);
    const proposal = context === undefined ? undefined : pageProposal(context, proposalById);
    if (context === undefined || proposal === undefined || context.state.kind !== 'known') {
      skippedMeasurementCount++;
      return measurement;
    }

    const date = context.state.value;
    if (measurement.collectionDate !== null && measurement.collectionDate !== date) {
      conflictCount++;
      return {
        ...measurement,
        ambiguousFields: addField(measurement.ambiguousFields, 'collectionDate'),
        unresolvedFields: addField(measurement.unresolvedFields ?? [], 'collectionDate'),
      };
    }

    const sourceIds = appendSourceIds(measurement.sourceIds, proposal);
    if (measurement.collectionDate === date) matchingMeasurementCount++;
    else attachedMeasurementCount++;
    return {
      ...measurement,
      collectionDate: date,
      collectionGroup: measurement.collectionGroup,
      sourceIds,
      ambiguousFields: removeField(measurement.ambiguousFields, 'collectionDate'),
      ...(measurement.unresolvedFields === undefined
        ? {}
        : { unresolvedFields: removeField(measurement.unresolvedFields, 'collectionDate') }),
    };
  });

  return {
    measurements: attached,
    diagnostics: {
      inputObservationCount,
      proposalCount: metadata.proposals.length,
      knownPageContextCount: knownPageContexts.length,
      attachedMeasurementCount,
      matchingMeasurementCount,
      conflictCount,
      skippedMeasurementCount,
    },
  };
}

function pageProposal(
  context: CollectionDateMetadataResult['pageContexts'][number],
  proposals: ReadonlyMap<string, CollectionDateProposal>,
): CollectionDateProposal | undefined {
  if (context.proposalIds.length !== 1) return undefined;
  const proposal = proposals.get(context.proposalIds[0]!);
  return proposal?.reason === 'accepted' && proposal.scope.kind === 'page' ? proposal : undefined;
}

function appendSourceIds(
  existing: readonly string[] | undefined,
  proposal: CollectionDateProposal,
): readonly string[] {
  const sourceIds = [...(existing ?? [])];
  for (const id of [proposal.rawDate.observationId, proposal.collectionLabel?.observationId]) {
    if (id !== undefined && id.length > 0 && !sourceIds.includes(id)) sourceIds.push(id);
  }
  return sourceIds;
}

function addField(fields: readonly string[], field: string): readonly string[] {
  return fields.includes(field) ? fields : [...fields, field];
}

function removeField(fields: readonly string[], field: string): readonly string[] {
  return fields.filter((item) => item !== field);
}
