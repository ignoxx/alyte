import { generatedCatalogueArtifact } from './generated/catalogue-artifact';
import {
  bloodLiverBiomarkerIds,
  lipidBiomarkerIds,
  metabolicMicronutrientBiomarkerIds,
  type BiomarkerCatalogueEntry,
} from './schema';
import { normalizeCatalogueAlias, validateCatalogueRelease } from './validation';

export * from './schema';
export * from './validation';
export * from './artifact';

// Preserve source/provenance exports used by catalogue review and comparison fixtures. The entry
// arrays below intentionally come from the generated artifact, never from these source modules.
export {
  bloodLiverSources,
  bloodLiverReviewPending,
  medlineplusAltSource,
  medlineplusAstSource,
  medlineplusCompleteBloodCountSource,
  medlineplusGgtSource,
  medlineplusHematocritSource,
  medlineplusHemoglobinSource,
  medlineplusLiverFunctionSource,
  medlineplusMcvSource,
  ifccAltReferenceSource,
  ifccAstReferenceSource,
  ifccGgtReferenceSource,
  nistPercentageDefinitionsSource,
  nistUnitDefinitionsSource,
} from './blood-liver';
export {
  lipidSources,
  reviewPending,
  conversionSource,
  cdcLipidSource,
  nhlbiLipidSource,
} from './lipids';
export {
  metabolicSources,
  metabolicReviewPending,
  cdcDiabetesTestingSource,
  niddkDiabetesConversionsSource,
  ngspIfccSource,
  whoFerritinSource,
  nihVitaminDSource,
  nihVitaminB12Source,
} from './metabolic-micronutrients';

const generatedCatalogueIssues = validateCatalogueRelease(
  generatedCatalogueArtifact.entries,
  generatedCatalogueArtifact.manifest,
);
if (generatedCatalogueIssues.length > 0) {
  throw new Error(
    `Generated catalogue artifact is not a valid launch artifact: ${generatedCatalogueIssues[0]!.message}`,
  );
}
const runtime = globalThis as unknown as { process?: { env?: { NODE_ENV?: string } } };
if (
  runtime.process?.env?.NODE_ENV === 'production' &&
  (generatedCatalogueArtifact.signature === null ||
    generatedCatalogueArtifact.manifest.status !== 'approved')
) {
  throw new Error('Production catalogue requires a signed, publication-approved artifact');
}

/** The exact generated artifact consumed by application/domain code. */
export const bundledCatalogueArtifact = generatedCatalogueArtifact;

/** Stable catalogue entries derived from the verified generated artifact. */
export const comparableBiomarkers: readonly BiomarkerCatalogueEntry[] =
  bundledCatalogueArtifact.entries;

function familyEntries(ids: readonly string[]): readonly BiomarkerCatalogueEntry[] {
  return ids.flatMap((id) => {
    const entry = comparableBiomarkers.find((candidate) => candidate.id === id);
    return entry === undefined ? [] : [entry];
  });
}

export const lipidBiomarkers = familyEntries(Object.values(lipidBiomarkerIds));
export const metabolicMicronutrientBiomarkers = familyEntries(
  Object.values(metabolicMicronutrientBiomarkerIds),
);
export const bloodLiverBiomarkers = familyEntries(Object.values(bloodLiverBiomarkerIds));

/** Deprecated compatibility alias; it remains artifact-derived. */
export const otherComparableBiomarkers = bloodLiverBiomarkers;

export function findCatalogueBiomarker(id: string): BiomarkerCatalogueEntry | null {
  return comparableBiomarkers.find((entry) => entry.id === id) ?? null;
}

export function resolveBiomarkerAlias(label: string): string | null {
  const normalized = normalizeCatalogueAlias(label);
  const matches = comparableBiomarkers.filter((entry) =>
    entry.aliases.some((alias) => normalizeCatalogueAlias(alias) === normalized),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}
