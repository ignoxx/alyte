import type { SpecimenType } from '@alyte/domain';
import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  type BiomarkerCatalogueEntry,
  findCatalogueBiomarker,
} from '@alyte/catalogue';
import {
  MODEL_EVALUATION_MANIFEST_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  qwenEvaluationManifest,
} from './manifest';

export const SEMANTIC_ROLES = ['measurement', 'specimen-context', 'ignore'] as const;
export type SemanticRole = (typeof SEMANTIC_ROLES)[number];

export const SPECIMEN_TYPES = [
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'saliva',
  'unknown',
] as const satisfies readonly SpecimenType[];

export type EvaluationProposal = {
  readonly sourceObservationIds: readonly string[];
  readonly role: SemanticRole;
  readonly specimenType: SpecimenType;
  readonly biomarkerId: string | null;
};

export type EvaluationOutput = {
  readonly schemaVersion: typeof SEMANTIC_MAPPER_SCHEMA_VERSION;
  readonly proposals: readonly EvaluationProposal[];
};

/** JSON Schema is kept beside the native runner's grammar generation input. */
export const semanticMapperJsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'proposals'],
  properties: {
    schemaVersion: { const: SEMANTIC_MAPPER_SCHEMA_VERSION },
    proposals: {
      type: 'array',
      maxItems: qwenEvaluationManifest.prompt.maxProposals,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceObservationIds', 'role', 'specimenType', 'biomarkerId'],
        properties: {
          sourceObservationIds: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 96 },
          },
          role: { enum: SEMANTIC_ROLES },
          specimenType: { enum: SPECIMEN_TYPES },
          biomarkerId: { type: ['string', 'null'], enum: [...ALL_COMPARABLE_BIOMARKER_IDS, null] },
        },
      },
    },
  },
} as const);

export const authoritativeFieldNames = new Set([
  'value',
  'valueString',
  'unit',
  'referenceInterval',
  'reference',
  'range',
  'flag',
  'conversion',
  'normalizedValue',
  'normalizedUnit',
  'translation',
  'translatedLabel',
  'explanation',
  'medicalCopy',
]);

export function catalogueEntryFor(id: string | null): BiomarkerCatalogueEntry | null {
  return id === null ? null : findCatalogueBiomarker(id);
}

export function specimenCompatible(
  entry: BiomarkerCatalogueEntry,
  specimenType: SpecimenType,
): boolean {
  if (entry.specimens.includes(specimenType)) return true;
  return (
    entry.specimenCompatibility?.some(
      (group) =>
        group.includes(specimenType) && group.some((item) => entry.specimens.includes(item)),
    ) ?? false
  );
}

export function isKnownBiomarkerId(id: string | null): boolean {
  return (
    id === null ||
    ALL_COMPARABLE_BIOMARKER_IDS.includes(id as (typeof ALL_COMPARABLE_BIOMARKER_IDS)[number])
  );
}

export function isSpecimenType(value: unknown): value is SpecimenType {
  return typeof value === 'string' && (SPECIMEN_TYPES as readonly string[]).includes(value);
}

export function isSemanticRole(value: unknown): value is SemanticRole {
  return typeof value === 'string' && (SEMANTIC_ROLES as readonly string[]).includes(value);
}

export function isEvaluationOutput(value: unknown): value is EvaluationOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    candidate.schemaVersion === SEMANTIC_MAPPER_SCHEMA_VERSION &&
    Array.isArray(candidate.proposals)
  );
}

export const evaluationSchemaMetadata = Object.freeze({
  manifestVersion: MODEL_EVALUATION_MANIFEST_VERSION,
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
});
