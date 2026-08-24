import { bloodLiverBiomarkers, bloodLiverSources } from './blood-liver.js';
import { lipidBiomarkers, lipidSources } from './lipids.js';
import { metabolicMicronutrientBiomarkers, metabolicSources } from './metabolic-micronutrients.js';
import type { BiomarkerCatalogueEntry, CatalogueSource } from './schema.js';

/**
 * Source modules are build inputs only. Application/domain consumers must import the generated
 * artifact through index.ts, so this aggregate is deliberately not part of the package exports.
 */
export const sourceCatalogue: readonly BiomarkerCatalogueEntry[] = [
  ...lipidBiomarkers,
  ...metabolicMicronutrientBiomarkers,
  ...bloodLiverBiomarkers,
];

export const sourceCatalogueSources: readonly CatalogueSource[] = [
  ...lipidSources,
  ...metabolicSources,
  ...bloodLiverSources,
];
