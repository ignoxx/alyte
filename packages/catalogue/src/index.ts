export const CATALOGUE_VERSION = '0.1.0';

export interface CatalogueManifest {
  readonly version: typeof CATALOGUE_VERSION;
  readonly status: 'review-pending';
}

export const catalogueManifest: CatalogueManifest = {
  version: CATALOGUE_VERSION,
  status: 'review-pending',
};
