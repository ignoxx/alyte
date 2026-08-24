import { lipidBiomarkers } from './lipids.js';
import { metabolicMicronutrientBiomarkers } from './metabolic-micronutrients.js';
import { otherComparableBiomarkers } from './other-biomarkers.js';
import type { BiomarkerCatalogueEntry } from './schema.js';
import { normalizeCatalogueAlias } from './validation.js';

export * from './schema.js';
export * from './lipids.js';
export * from './metabolic-micronutrients.js';
export * from './other-biomarkers.js';
export * from './validation.js';
export * from './artifact.js';

export function composeCatalogue(
  ...groups: readonly (readonly BiomarkerCatalogueEntry[])[]
): readonly BiomarkerCatalogueEntry[] {
  return groups.flat();
}

/** Deterministic aggregate consumed by extraction adapters and downstream domain code. */
export const comparableBiomarkers: readonly BiomarkerCatalogueEntry[] = composeCatalogue(
  lipidBiomarkers,
  metabolicMicronutrientBiomarkers,
  otherComparableBiomarkers,
);

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
