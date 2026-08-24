import {
  lipidBiomarkerIds,
  metabolicMicronutrientBiomarkerIds,
  type BiomarkerCatalogueEntry,
  type CatalogueValidationIssue,
} from './schema.js';

/** Source-shaped aliases are normalized only for lookup; they never replace the original label. */
export function normalizeCatalogueAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const forbiddenWordingPatterns: readonly RegExp[] = [
  /\bdiagnos(?:e|ed|es|is|tic|ing)?\b/i,
  /\bcaus(?:e|al|ed|es|ing)?\b/i,
  /\bpredict(?:ed|ion|s|ing)?\b/i,
  /\bprobabl(?:e|y)\b/i,
  /\b(?:good|bad|healthy|optimal)\b/i,
  /\b(?:improv(?:e|ed|ement)|worsen(?:ed|ing)?)\b/i,
  /\bstop\s+taking\b/i,
  /\byou\s+have\s+(?:a\s+)?(?:deficien|disease)/i,
];

type ComparableEntryRequirements = {
  readonly family: 'lipid' | 'metabolic/micronutrient';
  readonly guidance: 'required' | 'optional';
  readonly requireMethodPolicy: boolean;
};

const comparableEntryRequirements = new Map<string, ComparableEntryRequirements>([
  ...Object.values(lipidBiomarkerIds).map(
    (id) => [id, { family: 'lipid', guidance: 'required', requireMethodPolicy: false }] as const,
  ),
  ...Object.values(metabolicMicronutrientBiomarkerIds).map(
    (id) =>
      [
        id,
        { family: 'metabolic/micronutrient', guidance: 'optional', requireMethodPolicy: true },
      ] as const,
  ),
]);

function validateComparableEntry(
  entry: BiomarkerCatalogueEntry,
  path: string,
  requirements: ComparableEntryRequirements,
): CatalogueValidationIssue[] {
  const issues: CatalogueValidationIssue[] = [];
  const family = requirements.family;
  const required = (field: string, message: string): void => {
    issues.push({ path: `${path}.${field}`, message });
  };
  if (entry.canonicalLabel === undefined || entry.canonicalLabel.trim().length === 0)
    required('canonicalLabel', `${family} canonical label is required`);
  if (entry.valueType !== 'numeric') required('valueType', `${family} entries must be numeric`);
  if (entry.specimens.length === 0) required('specimens', `${family} specimens are required`);
  if (entry.units.length === 0) required('units', `${family} units are required`);
  if (entry.canonicalUnit === undefined || entry.canonicalUnit.trim().length === 0)
    required('canonicalUnit', `${family} canonical unit is required`);
  if (entry.explanation === undefined || entry.explanation.trim().length === 0)
    required('explanation', `${family} explanation is required`);
  if (entry.sources === undefined || entry.sources.length === 0)
    required('sources', `${family} source metadata is required`);
  if (entry.review === undefined) required('review', `${family} review metadata is required`);
  if (
    requirements.guidance === 'required' &&
    (entry.generalGuidance === undefined || entry.generalGuidance.length === 0)
  )
    required('generalGuidance', `${family} guidance metadata is required`);

  for (const unit of entry.units) {
    if (entry.canonicalUnit !== undefined && unit !== entry.canonicalUnit) {
      const covered = entry.unitConversions?.some(
        (candidate) => candidate.from === unit && candidate.to === entry.canonicalUnit,
      );
      if (!covered)
        issues.push({
          path: `${path}.unitConversions`,
          message: `${family} conversion coverage is missing for ${unit}`,
        });
    }
  }

  if (entry.specimens.length > 0) {
    const listedSpecimens = new Set(entry.specimens);
    if (listedSpecimens.size !== entry.specimens.length)
      required('specimens', `${family} specimens must be unique`);
    const groups = entry.specimenCompatibility;
    if (groups === undefined || groups.length === 0) {
      required('specimenCompatibility', `${family} specimen compatibility groups are required`);
    } else {
      const coveredSpecimens = new Set<string>();
      for (const [groupIndex, group] of groups.entries()) {
        if (!Array.isArray(group) || group.length === 0) {
          issues.push({
            path: `${path}.specimenCompatibility[${groupIndex}]`,
            message: `${family} specimen compatibility groups cannot be empty`,
          });
          continue;
        }
        for (const specimen of group) {
          if (!listedSpecimens.has(specimen)) {
            issues.push({
              path: `${path}.specimenCompatibility[${groupIndex}]`,
              message: `${family} specimen compatibility references an unlisted specimen`,
            });
          }
          if (coveredSpecimens.has(specimen)) {
            issues.push({
              path: `${path}.specimenCompatibility[${groupIndex}]`,
              message: `${family} specimen compatibility groups overlap`,
            });
          }
          coveredSpecimens.add(specimen);
        }
      }
      for (const specimen of listedSpecimens) {
        if (!coveredSpecimens.has(specimen)) {
          issues.push({
            path: `${path}.specimenCompatibility`,
            message: `${family} specimen compatibility does not cover every listed specimen`,
          });
          break;
        }
      }
    }
  }

  if (requirements.requireMethodPolicy) {
    const policy = entry.methodPolicy;
    if (policy === undefined) {
      required('methodPolicy', `${family} method policy is required`);
    } else {
      if (!/^\d+\.\d+\.\d+$/.test(policy.version))
        required('methodPolicy.version', `${family} method policy version is invalid`);
      if (!['method-agnostic', 'standardized', 'requires-explicit-method'].includes(policy.kind))
        required('methodPolicy.kind', `${family} method policy kind is invalid`);
      if (
        (policy.kind === 'standardized' || policy.kind === 'requires-explicit-method') &&
        policy.allowedMethods.length === 0
      )
        required('methodPolicy.allowedMethods', `${family} policy needs allowed methods`);
      if (policy.allowedMethods.some((method) => method.trim().length === 0))
        required('methodPolicy.allowedMethods', `${family} method policy contains an empty method`);
      if (policy.unsafePatterns.some((pattern) => pattern.trim().length === 0))
        required(
          'methodPolicy.unsafePatterns',
          `${family} method policy contains an empty unsafe pattern`,
        );
      if (!policy.rationale.trim())
        required('methodPolicy.rationale', `${family} method rationale is required`);
    }
  }
  return issues;
}

export function findForbiddenWording(text: string): string | null {
  const match = forbiddenWordingPatterns.find((pattern) => pattern.test(text));
  return match?.source ?? null;
}

export function validateCatalogue(
  entries: readonly BiomarkerCatalogueEntry[],
): readonly CatalogueValidationIssue[] {
  const issues: CatalogueValidationIssue[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const path = `entries[${index}]`;
    if (ids.has(entry.id)) issues.push({ path: `${path}.id`, message: 'duplicate canonical id' });
    ids.add(entry.id);
    if (!/^biomarker\.[a-z0-9_]+$/.test(entry.id)) {
      issues.push({ path: `${path}.id`, message: 'invalid canonical biomarker id' });
    }
    if (entry.catalogueVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(entry.catalogueVersion)) {
      issues.push({ path: `${path}.catalogueVersion`, message: 'invalid catalogue version' });
    }
    if (entry.aliases.length === 0) {
      issues.push({ path: `${path}.aliases`, message: 'at least one alias is required' });
    }
    if (
      new Set(entry.aliases.map((alias) => alias.trim().toLocaleLowerCase())).size !==
      entry.aliases.length
    ) {
      issues.push({
        path: `${path}.aliases`,
        message: 'aliases must be unique within the source language',
      });
    }
    for (const unit of entry.units) {
      if (!unit.trim()) issues.push({ path: `${path}.units`, message: 'unit cannot be empty' });
    }
    if (entry.valueType !== undefined && entry.valueType !== 'numeric') {
      issues.push({ path: `${path}.valueType`, message: 'unsupported value type' });
    }
    if (entry.canonicalUnit !== undefined && !entry.units.includes(entry.canonicalUnit)) {
      issues.push({
        path: `${path}.canonicalUnit`,
        message: 'canonical unit is not listed in units',
      });
    }
    const requirements = comparableEntryRequirements.get(entry.id);
    if (requirements !== undefined)
      issues.push(...validateComparableEntry(entry, path, requirements));
    if (entry.unitConversions !== undefined) {
      const entrySourceIds = new Set((entry.sources ?? []).map((source) => source.id));
      for (const [conversionIndex, conversion] of entry.unitConversions.entries()) {
        const conversionPath = `${path}.unitConversions[${conversionIndex}]`;
        if (!entry.units.includes(conversion.from) || !entry.units.includes(conversion.to)) {
          issues.push({
            path: conversionPath,
            message: 'conversion references an unsupported unit',
          });
        }
        if (!Number.isFinite(conversion.factor) || conversion.factor === 0) {
          issues.push({
            path: conversionPath,
            message: 'conversion factor must be finite and non-zero',
          });
        }
        if (!conversion.sourceId.trim()) {
          issues.push({
            path: `${conversionPath}.sourceId`,
            message: 'conversion source is missing',
          });
        } else if (!entrySourceIds.has(conversion.sourceId)) {
          issues.push({
            path: `${conversionPath}.sourceId`,
            message: 'conversion source must be included in the entry source set',
          });
        }
      }
    }
    for (const field of [
      entry.explanation ?? '',
      ...(entry.generalGuidance ?? []).flatMap((item) => [
        item.label,
        item.description,
        item.disagreement ?? '',
        ...item.applicability.limitations,
      ]),
    ]) {
      const forbidden = findForbiddenWording(field);
      if (forbidden !== null) {
        issues.push({ path: `${path}.content`, message: `forbidden wording: ${forbidden}` });
      }
    }
    if (entry.sources !== undefined) {
      for (const source of entry.sources) {
        if (!/^https?:\/\//.test(source.url)) {
          issues.push({ path: `${path}.sources`, message: 'source URL must be absolute' });
        }
      }
    }
    if (entry.review?.status === 'approved' && entry.review.reviewedAt === null) {
      issues.push({ path: `${path}.review`, message: 'approved content requires reviewedAt' });
    }
    for (const guidance of entry.generalGuidance ?? []) {
      if (!guidance.applicability || guidance.applicability.population !== 'adults') {
        issues.push({
          path: `${path}.generalGuidance`,
          message: 'guidance population is unsupported',
        });
        continue;
      }
      if (
        !guidance.applicability.jurisdiction.trim() ||
        guidance.applicability.context !== 'screening' ||
        (guidance.applicability.purpose !== undefined &&
          !['screening', 'monitoring'].includes(guidance.applicability.purpose)) ||
        (guidance.applicability.specimen !== undefined &&
          !entry.specimens.includes(guidance.applicability.specimen)) ||
        !['all', 'female', 'male'].includes(guidance.applicability.sex) ||
        !['any', 'fasting', 'non-fasting'].includes(guidance.applicability.fasting)
      ) {
        issues.push({
          path: `${path}.generalGuidance`,
          message: 'guidance applicability is incomplete',
        });
      }
      if (
        !guidance.authority.trim() ||
        !guidance.publicationVersion.trim() ||
        !guidance.unit.trim() ||
        !['exclusive', 'inclusive', 'sex-specific'].includes(guidance.boundarySemantics)
      ) {
        issues.push({
          path: `${path}.generalGuidance`,
          message: 'guidance review metadata is incomplete',
        });
      }
      if (guidance.review.status === 'approved' && guidance.review.reviewedAt === null) {
        issues.push({
          path: `${path}.generalGuidance`,
          message: 'approved guidance requires reviewedAt',
        });
      }
      if (guidance.sources.some((sourceId) => !sourceId.trim())) {
        issues.push({ path: `${path}.generalGuidance`, message: 'guidance source is missing' });
      }
      const entrySourceIds = new Set((entry.sources ?? []).map((source) => source.id));
      for (const sourceId of guidance.sources) {
        if (sourceId.trim() && !entrySourceIds.has(sourceId)) {
          issues.push({
            path: `${path}.generalGuidance`,
            message: 'guidance source must be included in the entry source set',
          });
        }
      }
    }
  }
  return issues;
}

export function assertCatalogueValid(entries: readonly BiomarkerCatalogueEntry[]): void {
  const issues = validateCatalogue(entries);
  if (issues.length > 0) {
    throw new Error(`Catalogue validation failed: ${issues[0]!.path}: ${issues[0]!.message}`);
  }
}
