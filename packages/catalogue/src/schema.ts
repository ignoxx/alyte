export const CATALOGUE_VERSION = '0.2.0';
export const CATALOGUE_SCHEMA_VERSION = 'alyte.catalogue.v1';
export const CATALOGUE_ARTIFACT_SCHEMA_VERSION = 'alyte.catalogue.artifact.v1';

export const lipidBiomarkerIds = {
  totalCholesterol: 'biomarker.total_cholesterol',
  ldlC: 'biomarker.ldl_c',
  hdlC: 'biomarker.hdl_c',
  triglycerides: 'biomarker.triglycerides',
} as const;

export type LipidBiomarkerId = (typeof lipidBiomarkerIds)[keyof typeof lipidBiomarkerIds];
export const LIPID_BIOMARKER_IDS = lipidBiomarkerIds;

export const metabolicMicronutrientBiomarkerIds = {
  glucose: 'biomarker.glucose',
  hba1c: 'biomarker.hba1c',
  ferritin: 'biomarker.ferritin',
  vitaminDTotal: 'biomarker.vitamin_d_total',
  vitaminB12Total: 'biomarker.vitamin_b12_total',
} as const;

export type MetabolicBiomarkerId =
  (typeof metabolicMicronutrientBiomarkerIds)[keyof typeof metabolicMicronutrientBiomarkerIds];
export const METABOLIC_MICRONUTRIENT_BIOMARKER_IDS = metabolicMicronutrientBiomarkerIds;

export const bloodLiverBiomarkerIds = {
  hemoglobin: 'biomarker.hemoglobin',
  hematocrit: 'biomarker.hematocrit',
  mcv: 'biomarker.mcv',
  alt: 'biomarker.alt',
  ast: 'biomarker.ast',
  ggt: 'biomarker.ggt',
} as const;

export type BloodLiverBiomarkerId =
  (typeof bloodLiverBiomarkerIds)[keyof typeof bloodLiverBiomarkerIds];
export const BLOOD_LIVER_BIOMARKER_IDS = bloodLiverBiomarkerIds;

export type CataloguePublicationStatus = 'review-pending' | 'approved';

export type CatalogueReviewMetadata = {
  readonly status: 'pending-human-publication' | 'approved';
  readonly contentVersion: string;
  readonly reviewedAt: string | null;
  readonly reviewer: string | null;
  readonly reviewNotes: string;
};

export type CatalogueSource = {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publicationDate: string | null;
  readonly accessedAt: string;
  readonly sourceKind: 'public-health-authority' | 'professional-guideline' | 'reference';
};

export type UnitConversion = {
  readonly from: string;
  readonly to: string;
  readonly factor: number;
  readonly offset: number;
  readonly sourceId: string;
};

export type CatalogueSpecimen =
  'blood' | 'serum' | 'plasma' | 'urine' | 'stool' | 'saliva' | 'unknown';

export type SpecimenCompatibility = readonly (readonly [
  CatalogueSpecimen,
  ...CatalogueSpecimen[],
])[];

export type CatalogueMethodPolicy = {
  /** Policy release, independent from the catalogue content release. */
  readonly version: string;
  /** Standardized methods may be omitted when the reported identity and unit are explicit. */
  readonly kind: 'method-agnostic' | 'standardized' | 'requires-explicit-method';
  readonly allowedMethods: readonly string[];
  readonly unsafePatterns: readonly string[];
  /** Complete source-text profile requirements for methods whose identity affects comparability. */
  readonly profiles?: readonly CatalogueMethodProfile[];
  readonly rationale: string;
};

export type CatalogueMethodProfile = {
  readonly id: string;
  readonly assayPatterns: readonly string[];
  readonly temperatureC: 30 | 37;
  readonly temperaturePatterns: readonly string[];
  readonly pyridoxalPhosphate: 'present' | 'absent' | 'not-applicable';
  readonly pyridoxalPhosphatePatterns: readonly string[];
};

export type GeneralGuidanceThreshold = {
  readonly operator: '<' | '<=' | '>' | '>=';
  readonly value: number;
  readonly unit: string;
};

export type GeneralGuidance = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly thresholds: readonly GeneralGuidanceThreshold[];
  readonly applicability: {
    readonly population: 'adults';
    readonly jurisdiction: string;
    readonly context: 'screening';
    readonly purpose?: 'screening' | 'monitoring';
    readonly sex: 'all' | 'female' | 'male';
    readonly fasting: 'any' | 'fasting' | 'non-fasting';
    readonly specimen?: CatalogueSpecimen;
    readonly limitations: readonly string[];
  };
  /** Disagreement is explicit; catalogue content never silently chooses a universal threshold. */
  readonly disagreement: string | null;
  readonly authority: string;
  readonly publicationVersion: string;
  readonly reviewDate: string | null;
  readonly unit: string;
  readonly boundarySemantics: 'exclusive' | 'inclusive' | 'sex-specific';
  readonly sources: readonly string[];
  readonly review: CatalogueReviewMetadata;
};

export type BiomarkerCatalogueEntry = {
  readonly id: string;
  /** Catalogue release that authored this entry; optional for pending non-lipid extensions. */
  readonly catalogueVersion?: string;
  readonly aliases: readonly string[];
  readonly specimens: readonly CatalogueSpecimen[];
  readonly units: readonly string[];
  readonly canonicalLabel?: string;
  readonly valueType?: 'numeric';
  readonly canonicalUnit?: string;
  readonly unitConversions?: readonly UnitConversion[];
  readonly specimenCompatibility?: SpecimenCompatibility;
  readonly unsafeAliases?: readonly string[];
  readonly methodPolicy?: CatalogueMethodPolicy;
  readonly explanation?: string;
  readonly sources?: readonly CatalogueSource[];
  readonly review?: CatalogueReviewMetadata;
  readonly generalGuidance?: readonly GeneralGuidance[];
};

export interface CatalogueManifest {
  readonly version: typeof CATALOGUE_VERSION;
  readonly schemaVersion: typeof CATALOGUE_SCHEMA_VERSION;
  readonly status: CataloguePublicationStatus;
  readonly signatureRequired: boolean;
}

export const catalogueManifest: CatalogueManifest = {
  version: CATALOGUE_VERSION,
  schemaVersion: CATALOGUE_SCHEMA_VERSION,
  status: 'review-pending',
  // The checked-in baseline has no private signing key. Release/update tooling can require and
  // verify a detached signature without making an unapproved secret part of this repository.
  signatureRequired: false,
};

export type CatalogueArtifact = {
  readonly schemaVersion: typeof CATALOGUE_ARTIFACT_SCHEMA_VERSION;
  readonly manifest: CatalogueManifest;
  readonly entries: readonly BiomarkerCatalogueEntry[];
  readonly sourceSet: readonly CatalogueSource[];
  readonly integrity: { readonly algorithm: 'SHA-256'; readonly digest: string };
  readonly signature: CatalogueSignature | null;
};

export type CatalogueSignature = {
  /** Key ID is resolved against caller-supplied trusted key material. */
  readonly keyId: string;
  readonly algorithm: 'Ed25519' | 'ECDSA-P256-SHA256';
  readonly value: string;
};

export type CatalogueTrustedKey = {
  readonly keyId: string;
  readonly algorithm: CatalogueSignature['algorithm'];
  readonly publicKeyJwk: Record<string, unknown>;
};

export type CatalogueVerificationOptions = {
  readonly requireSignature?: boolean;
  readonly trustedKeys?: readonly CatalogueTrustedKey[];
};

export type CatalogueArtifactVerification =
  { readonly ok: true; readonly signed: boolean } | { readonly ok: false; readonly reason: string };

export type CatalogueValidationIssue = {
  readonly path: string;
  readonly message: string;
};
