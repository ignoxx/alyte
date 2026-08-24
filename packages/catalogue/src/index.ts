import { lipidBiomarkers } from './lipids';
import { metabolicMicronutrientBiomarkers } from './metabolic-micronutrients';
import { bloodLiverBiomarkers } from './blood-liver';
import type { BiomarkerCatalogueEntry } from './schema';
import { normalizeCatalogueAlias } from './validation';

export * from './schema';
export * from './lipids';
export * from './metabolic-micronutrients';
export * from './blood-liver';
export * from './other-biomarkers';
export * from './validation';
export * from './artifact';

export function composeCatalogue(
  ...groups: readonly (readonly BiomarkerCatalogueEntry[])[]
): readonly BiomarkerCatalogueEntry[] {
  return groups.flat();
}

/** Deterministic aggregate consumed by extraction adapters and downstream domain code. */
export const comparableBiomarkers: readonly BiomarkerCatalogueEntry[] = composeCatalogue(
  lipidBiomarkers,
  metabolicMicronutrientBiomarkers,
  bloodLiverBiomarkers,
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
