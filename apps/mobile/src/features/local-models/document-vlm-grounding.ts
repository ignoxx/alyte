import {
  parseGeometryCandidateVariantAsProvisional,
  type ExtractionAliasEntry,
  type ExtractionDateContext,
  type ExtractionDraftRow,
  type GeometryCandidateWindowGroup,
  type GeometryCandidateWindowRow,
  type LabDateState,
  type LabSourceArtifact,
} from '@alyte/domain';
import type { DocumentVLMRow } from './document-vlm';

export type GroundDocumentVLMRowsResult = {
  readonly rows: readonly ExtractionDraftRow[];
  readonly matchedPhysicalRowIds: ReadonlySet<string>;
  readonly matchedPhysicalRows: number;
  readonly ambiguousPhysicalRows: number;
  readonly unmatchedProposals: number;
};

type GroundingOptions = {
  readonly locale: string;
  readonly collectionDate: LabDateState;
  readonly collectionDateDefaulted: boolean;
  readonly collectionDateContexts: readonly ExtractionDateContext[];
  readonly aliases: readonly ExtractionAliasEntry[];
  readonly artifact: LabSourceArtifact;
  readonly existingSourceObservationIds?: ReadonlySet<string>;
};

function comparable(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function sourceText(variant: GeometryCandidateWindowRow, sourceID: string | null): string | null {
  if (sourceID === null) return null;
  return variant.observations.find((observation) => observation.id === sourceID)?.text ?? null;
}

function labelMatches(proposal: string, source: string | null): boolean {
  if (source === null) return false;
  const left = comparable(proposal);
  const right = comparable(source);
  return left === right || (left.length >= 3 && right.includes(left));
}

function exactFieldMatches(proposal: string | null, source: string | null): boolean {
  return proposal === null || (source !== null && comparable(proposal) === comparable(source));
}

function variantMatches(row: DocumentVLMRow, variant: GeometryCandidateWindowRow): boolean {
  const fields = variant.provisionalSourceFields;
  return (
    row.value !== null &&
    labelMatches(row.label, sourceText(variant, fields.label)) &&
    exactFieldMatches(row.value, sourceText(variant, fields.value)) &&
    exactFieldMatches(row.unit, sourceText(variant, fields.unit)) &&
    exactFieldMatches(row.referenceInterval, sourceText(variant, fields.referenceInterval)) &&
    exactFieldMatches(row.flag, sourceText(variant, fields.flag))
  );
}

/**
 * Uses model output only as a selector over pre-existing, exact source variants. Model-authored
 * strings are discarded; the returned row is rebuilt by the domain parser from source IDs.
 */
export function groundDocumentVLMRows(
  proposalsByPage: ReadonlyMap<number, readonly DocumentVLMRow[]>,
  groups: readonly GeometryCandidateWindowGroup[],
  options: GroundingOptions,
): GroundDocumentVLMRowsResult {
  const admitted: ExtractionDraftRow[] = [];
  const admittedPhysicalRows = new Set<string>();
  let ambiguousPhysicalRows = 0;
  let unmatchedProposals = 0;

  for (const [pageIndex, proposals] of proposalsByPage) {
    const pageGroups = groups.filter(
      (group) => group.context.pageIndex === pageIndex && group.withinInputBounds,
    );
    for (const proposal of proposals) {
      const matches = pageGroups.flatMap((group) =>
        admittedPhysicalRows.has(group.physicalRowId) ||
        group.sourceObservationIds.some((id) => options.existingSourceObservationIds?.has(id))
          ? []
          : group.variants
              .filter((variant) => variantMatches(proposal, variant))
              .map((variant) => ({ group, variant })),
      );
      const uniquePhysicalRows = new Set(matches.map(({ group }) => group.physicalRowId));
      if (matches.length !== 1 || uniquePhysicalRows.size !== 1) {
        if (matches.length > 1) ambiguousPhysicalRows += 1;
        else unmatchedProposals += 1;
        continue;
      }
      const match = matches[0]!;
      const provisional = parseGeometryCandidateVariantAsProvisional(match.variant, {
        locale: options.locale,
        collectionDate: options.collectionDate,
        collectionDateDefaulted: options.collectionDateDefaulted,
        collectionDateContexts: options.collectionDateContexts,
        specimenType: 'unknown',
        aliases: options.aliases,
        artifact: options.artifact,
      });
      if (provisional === null) {
        unmatchedProposals += 1;
        continue;
      }
      admittedPhysicalRows.add(match.group.physicalRowId);
      admitted.push({
        ...provisional.row,
        reviewState: 'needs-review',
        decision: 'preserve',
        editState: 'automatic',
      });
    }
  }
  return {
    rows: admitted,
    matchedPhysicalRowIds: admittedPhysicalRows,
    matchedPhysicalRows: admittedPhysicalRows.size,
    ambiguousPhysicalRows,
    unmatchedProposals,
  };
}
