import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  CATALOGUE_SCHEMA_VERSION,
  CATALOGUE_VERSION,
  bloodLiverBiomarkerIds,
  lipidBiomarkerIds,
  metabolicMicronutrientBiomarkerIds,
  type BiomarkerCatalogueEntry,
  type CatalogueValidationIssue,
} from './schema.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function runtimeEntryShapeIssues(entry: unknown, path: string): CatalogueValidationIssue[] {
  const issues: CatalogueValidationIssue[] = [];
  if (!isRecord(entry)) return [{ path, message: 'entry must be an object' }];
  const requiredStrings = ['id', 'aliases', 'specimens', 'units'] as const;
  for (const field of requiredStrings) {
    if (field === 'id') {
      if (typeof entry[field] !== 'string')
        issues.push({ path: `${path}.${field}`, message: 'must be a string' });
    } else if (!isStringArray(entry[field])) {
      issues.push({ path: `${path}.${field}`, message: 'must be an array of strings' });
    }
  }
  for (const field of [
    'catalogueVersion',
    'canonicalLabel',
    'canonicalUnit',
    'explanation',
  ] as const) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string')
      issues.push({ path: `${path}.${field}`, message: 'must be a string' });
  }
  if (entry.valueType !== undefined && entry.valueType !== 'numeric')
    issues.push({ path: `${path}.valueType`, message: 'unsupported value type' });
  if (entry.unsafeAliases !== undefined && !isStringArray(entry.unsafeAliases))
    issues.push({ path: `${path}.unsafeAliases`, message: 'must be an array of strings' });

  if (entry.unitConversions !== undefined) {
    if (!Array.isArray(entry.unitConversions)) {
      issues.push({ path: `${path}.unitConversions`, message: 'must be an array' });
    } else {
      for (const [index, conversion] of entry.unitConversions.entries()) {
        const conversionPath = `${path}.unitConversions[${index}]`;
        if (!isRecord(conversion)) {
          issues.push({ path: conversionPath, message: 'conversion must be an object' });
          continue;
        }
        for (const field of ['from', 'to', 'sourceId'] as const) {
          if (typeof conversion[field] !== 'string')
            issues.push({ path: `${conversionPath}.${field}`, message: 'must be a string' });
        }
        for (const field of ['factor', 'offset'] as const) {
          if (typeof conversion[field] !== 'number' || !Number.isFinite(conversion[field]))
            issues.push({ path: `${conversionPath}.${field}`, message: 'must be finite' });
        }
      }
    }
  }

  if (entry.specimenCompatibility !== undefined) {
    if (
      !Array.isArray(entry.specimenCompatibility) ||
      !entry.specimenCompatibility.every((group) => isStringArray(group))
    ) {
      issues.push({ path: `${path}.specimenCompatibility`, message: 'must be specimen groups' });
    }
  }

  if (entry.sources !== undefined) {
    if (!Array.isArray(entry.sources)) {
      issues.push({ path: `${path}.sources`, message: 'must be an array' });
    } else {
      for (const [index, source] of entry.sources.entries()) {
        const sourcePath = `${path}.sources[${index}]`;
        if (!isRecord(source)) {
          issues.push({ path: sourcePath, message: 'source must be an object' });
          continue;
        }
        for (const field of ['id', 'title', 'publisher', 'url', 'accessedAt'] as const) {
          if (typeof source[field] !== 'string')
            issues.push({ path: `${sourcePath}.${field}`, message: 'must be a string' });
        }
        if (source.publicationDate !== null && typeof source.publicationDate !== 'string')
          issues.push({
            path: `${sourcePath}.publicationDate`,
            message: 'must be a string or null',
          });
        if (
          source.sourceKind !== 'public-health-authority' &&
          source.sourceKind !== 'professional-guideline' &&
          source.sourceKind !== 'reference'
        ) {
          issues.push({ path: `${sourcePath}.sourceKind`, message: 'unsupported source kind' });
        }
      }
    }
  }

  if (entry.review !== undefined) {
    const review = entry.review;
    if (!isRecord(review)) {
      issues.push({ path: `${path}.review`, message: 'review must be an object' });
    } else {
      if (review.status !== 'pending-human-publication' && review.status !== 'approved')
        issues.push({ path: `${path}.review.status`, message: 'unsupported review status' });
      for (const field of ['contentVersion', 'reviewNotes'] as const) {
        if (typeof review[field] !== 'string')
          issues.push({ path: `${path}.review.${field}`, message: 'must be a string' });
      }
      for (const field of ['reviewedAt', 'reviewer'] as const) {
        if (review[field] !== null && typeof review[field] !== 'string')
          issues.push({ path: `${path}.review.${field}`, message: 'must be a string or null' });
      }
    }
  }

  if (entry.methodPolicy !== undefined) {
    const policy = entry.methodPolicy;
    if (!isRecord(policy)) {
      issues.push({ path: `${path}.methodPolicy`, message: 'method policy must be an object' });
    } else {
      for (const field of ['version', 'rationale'] as const) {
        if (typeof policy[field] !== 'string')
          issues.push({ path: `${path}.methodPolicy.${field}`, message: 'must be a string' });
      }
      if (
        policy.kind !== 'method-agnostic' &&
        policy.kind !== 'standardized' &&
        policy.kind !== 'requires-explicit-method'
      )
        issues.push({
          path: `${path}.methodPolicy.kind`,
          message: 'unsupported method policy kind',
        });
      for (const field of ['allowedMethods', 'unsafePatterns'] as const) {
        if (!isStringArray(policy[field]))
          issues.push({
            path: `${path}.methodPolicy.${field}`,
            message: 'must be an array of strings',
          });
      }
      if (policy.profiles !== undefined) {
        if (!Array.isArray(policy.profiles)) {
          issues.push({ path: `${path}.methodPolicy.profiles`, message: 'must be an array' });
        } else {
          for (const [profileIndex, profile] of policy.profiles.entries()) {
            const profilePath = `${path}.methodPolicy.profiles[${profileIndex}]`;
            if (!isRecord(profile)) {
              issues.push({ path: profilePath, message: 'profile must be an object' });
              continue;
            }
            for (const field of [
              'id',
              'assayPatterns',
              'temperaturePatterns',
              'pyridoxalPhosphatePatterns',
            ] as const) {
              if (
                field === 'id' ? typeof profile[field] !== 'string' : !isStringArray(profile[field])
              )
                issues.push({
                  path: `${profilePath}.${field}`,
                  message: 'profile field is malformed',
                });
            }
            if (profile.temperatureC !== 30 && profile.temperatureC !== 37)
              issues.push({
                path: `${profilePath}.temperatureC`,
                message: 'unsupported temperature',
              });
            if (
              profile.pyridoxalPhosphate !== 'present' &&
              profile.pyridoxalPhosphate !== 'absent' &&
              profile.pyridoxalPhosphate !== 'not-applicable'
            )
              issues.push({
                path: `${profilePath}.pyridoxalPhosphate`,
                message: 'unsupported PLP status',
              });
          }
        }
      }
    }
  }

  if (entry.generalGuidance !== undefined) {
    if (!Array.isArray(entry.generalGuidance)) {
      issues.push({ path: `${path}.generalGuidance`, message: 'must be an array' });
    } else {
      for (const [index, guidance] of entry.generalGuidance.entries()) {
        const guidancePath = `${path}.generalGuidance[${index}]`;
        if (!isRecord(guidance)) {
          issues.push({ path: guidancePath, message: 'guidance must be an object' });
          continue;
        }
        for (const field of [
          'id',
          'label',
          'description',
          'authority',
          'publicationVersion',
          'unit',
          'boundarySemantics',
        ] as const) {
          if (typeof guidance[field] !== 'string')
            issues.push({ path: `${guidancePath}.${field}`, message: 'must be a string' });
        }
        if (!Array.isArray(guidance.thresholds)) {
          issues.push({ path: `${guidancePath}.thresholds`, message: 'must be an array' });
        } else {
          for (const threshold of guidance.thresholds) {
            if (
              !isRecord(threshold) ||
              typeof threshold.unit !== 'string' ||
              typeof threshold.value !== 'number' ||
              !Number.isFinite(threshold.value) ||
              !['<', '<=', '>', '>='].includes(String(threshold.operator))
            )
              issues.push({
                path: `${guidancePath}.thresholds`,
                message: 'threshold is malformed',
              });
          }
        }
        if (!isStringArray(guidance.sources))
          issues.push({ path: `${guidancePath}.sources`, message: 'must be an array of strings' });
        if (!isRecord(guidance.applicability)) {
          issues.push({
            path: `${guidancePath}.applicability`,
            message: 'applicability is malformed',
          });
        } else {
          const applicability = guidance.applicability;
          for (const field of [
            'population',
            'jurisdiction',
            'context',
            'sex',
            'fasting',
          ] as const) {
            if (typeof applicability[field] !== 'string')
              issues.push({
                path: `${guidancePath}.applicability.${field}`,
                message: 'must be a string',
              });
          }
          if (applicability.purpose !== undefined && typeof applicability.purpose !== 'string')
            issues.push({
              path: `${guidancePath}.applicability.purpose`,
              message: 'must be a string',
            });
          if (applicability.specimen !== undefined && typeof applicability.specimen !== 'string')
            issues.push({
              path: `${guidancePath}.applicability.specimen`,
              message: 'must be a string',
            });
          if (!isStringArray(applicability.limitations))
            issues.push({
              path: `${guidancePath}.applicability.limitations`,
              message: 'must be an array of strings',
            });
        }
        if (!isRecord(guidance.review))
          issues.push({ path: `${guidancePath}.review`, message: 'review is malformed' });
      }
    }
  }
  return issues;
}

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
  readonly family: 'lipid' | 'metabolic/micronutrient' | 'blood/liver';
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
  ...Object.values(bloodLiverBiomarkerIds).map(
    (id) =>
      [id, { family: 'blood/liver', guidance: 'optional', requireMethodPolicy: true }] as const,
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
      for (const [profileIndex, profile] of (policy.profiles ?? []).entries()) {
        const profilePath = `${path}.methodPolicy.profiles[${profileIndex}]`;
        if (!profile.id.trim())
          required(`${profilePath}.id`, `${family} method profile id is required`);
        if (profile.assayPatterns.length === 0)
          required(`${profilePath}.assayPatterns`, `${family} method assay patterns are required`);
        if (profile.temperaturePatterns.length === 0)
          required(
            `${profilePath}.temperaturePatterns`,
            `${family} method temperature patterns are required`,
          );
        if (profile.pyridoxalPhosphatePatterns.length === 0)
          required(
            `${profilePath}.pyridoxalPhosphatePatterns`,
            `${family} method PLP/P5P patterns are required`,
          );
        if (![30, 37].includes(profile.temperatureC))
          required(`${profilePath}.temperatureC`, `${family} method temperature is unsupported`);
        if (!['present', 'absent', 'not-applicable'].includes(profile.pyridoxalPhosphate))
          required(
            `${profilePath}.pyridoxalPhosphate`,
            `${family} method PLP/P5P status is unsupported`,
          );
      }
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
  if (!Array.isArray(entries)) return [{ path: 'entries', message: 'entries must be an array' }];
  const runtimeEntries = entries as readonly BiomarkerCatalogueEntry[];
  const issues: CatalogueValidationIssue[] = [];
  const ids = new Set<string>();
  const normalizedAliases = new Map<string, string>();
  for (const [index, entry] of runtimeEntries.entries()) {
    const path = `entries[${index}]`;
    const shapeIssues = runtimeEntryShapeIssues(entry, path);
    if (shapeIssues.length > 0) {
      issues.push(...shapeIssues);
      continue;
    }
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
    for (const alias of entry.aliases) {
      const normalized = normalizeCatalogueAlias(alias);
      const previous = normalizedAliases.get(normalized);
      if (previous !== undefined && previous !== entry.id) {
        issues.push({
          path: `${path}.aliases`,
          message: `alias is ambiguous with ${previous}: ${normalized}`,
        });
      } else {
        normalizedAliases.set(normalized, entry.id);
      }
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
        if (!Number.isFinite(conversion.offset)) {
          issues.push({
            path: conversionPath,
            message: 'conversion offset must be finite',
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
    if (
      entry.catalogueVersion !== undefined &&
      entry.review !== undefined &&
      entry.review.contentVersion !== entry.catalogueVersion
    ) {
      issues.push({
        path: `${path}.review.contentVersion`,
        message: 'review content version must match the entry catalogue version',
      });
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

/**
 * Validation used by an emitted launch artifact. The lower-level validator intentionally permits
 * future extension entries for source-preserving parsing tests; a release artifact must contain
 * every stable MVP identity and keep all entry versions aligned with its manifest.
 */
export function validateCatalogueRelease(
  entries: readonly BiomarkerCatalogueEntry[],
  manifest: {
    readonly version: string;
    readonly schemaVersion: string;
    readonly status: 'review-pending' | 'approved';
    readonly signatureRequired: boolean;
  },
): readonly CatalogueValidationIssue[] {
  const issues = [...validateCatalogue(entries)];
  if (manifest.schemaVersion !== CATALOGUE_SCHEMA_VERSION) {
    issues.push({ path: 'manifest.schemaVersion', message: 'catalogue schema version mismatch' });
  }
  if (manifest.version !== CATALOGUE_VERSION) {
    issues.push({ path: 'manifest.version', message: 'catalogue version mismatch' });
  }
  const present = new Set(
    entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : [])),
  );
  for (const id of ALL_COMPARABLE_BIOMARKER_IDS) {
    if (!present.has(id))
      issues.push({ path: 'entries', message: `missing stable biomarker ID: ${id}` });
  }
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) continue;
    if (entry.catalogueVersion !== manifest.version) {
      issues.push({
        path: `entries[${index}].catalogueVersion`,
        message: 'entry catalogue version must match the manifest version',
      });
    }
    if (entry.review !== undefined) {
      if (entry.review.status === 'approved' && manifest.status !== 'approved') {
        issues.push({
          path: `entries[${index}].review`,
          message: 'approved entry cannot be emitted in a review-pending manifest',
        });
      }
      if (entry.review.status === 'pending-human-publication' && manifest.status === 'approved') {
        issues.push({
          path: `entries[${index}].review`,
          message: 'approved manifest cannot contain review-pending entry',
        });
      }
    }
    for (const [guidanceIndex, guidance] of (entry.generalGuidance ?? []).entries()) {
      if (guidance.review.status === 'approved' && manifest.status !== 'approved') {
        issues.push({
          path: `entries[${index}].generalGuidance[${guidanceIndex}].review`,
          message: 'approved guidance cannot be emitted in a review-pending manifest',
        });
      }
      if (
        guidance.review.status === 'pending-human-publication' &&
        manifest.status === 'approved'
      ) {
        issues.push({
          path: `entries[${index}].generalGuidance[${guidanceIndex}].review`,
          message: 'approved manifest cannot contain review-pending guidance',
        });
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
