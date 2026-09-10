import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  bundledCatalogueArtifact,
  comparableBiomarkers,
  normalizeCatalogueAlias,
  type BiomarkerCatalogueEntry,
} from '../../packages/catalogue/src/index';
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  readExpectedResults,
  securePrivateFile,
  sha256File,
  verifyReportAndGroundTruth,
  writeJsonFile,
  type EvaluationMeasurement,
} from './contract';

const ANNOTATION_SCHEMA_VERSION = 'alyte.import-eval.annotation.v1' as const;
const ANNOTATION_VERSION = 1 as const;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,80}$/u;

type MappingReason =
  | 'exact-reviewed-alias'
  | 'empty-label'
  | 'no-exact-reviewed-alias'
  | 'ambiguous-exact-alias'
  | 'unsafe-alias';

type TrendReason =
  | 'unmapped'
  | 'value-type-not-numeric'
  | 'parsed-value-missing-or-invalid'
  | 'collection-date-missing'
  | 'collection-date-invalid'
  | 'collection-date-ambiguous'
  | 'unit-missing'
  | 'unit-unsupported-or-case-mismatch'
  | 'specimen-missing'
  | 'specimen-unsupported-or-case-mismatch'
  | 'method-policy-unsafe-pattern'
  | 'method-policy-requires-explicit-evidence';

type AnnotationAggregate = {
  readonly measurementCount: number;
  readonly mappedCount: number;
  readonly unsupportedCount: number;
  readonly mappingReasonCounts: Readonly<Record<string, number>>;
  readonly trendEligibleCount: number;
  readonly trendIneligibleCount: number;
  readonly trendReasonCounts: Readonly<Record<string, number>>;
};

type MeasurementAnnotation = {
  readonly measurement: EvaluationMeasurement;
  readonly mapping: {
    readonly canonicalBiomarkerId: string | null;
    readonly status: 'mapped' | 'unsupported';
    readonly reason: MappingReason;
    readonly normalizedSourceLabel: string;
    readonly matchedAliases: readonly string[];
    readonly candidateIds: readonly string[];
  };
  readonly trend: {
    readonly trendEligible: boolean;
    readonly reasons: readonly TrendReason[];
    readonly catalogueEntryId: string | null;
  };
  readonly provenance: {
    readonly sourceMeasurementId: string;
    readonly reportId: string;
    readonly reportSha256: string;
    readonly groundTruthSha256: string;
    readonly sourcePage: number | null;
    readonly sourceLocation: EvaluationMeasurement['location'];
  };
};

type AnnotationProposal = {
  readonly schemaVersion: typeof ANNOTATION_SCHEMA_VERSION;
  readonly annotationVersion: typeof ANNOTATION_VERSION;
  readonly status: 'draft';
  readonly reportId: string;
  readonly reportSha256: string;
  readonly groundTruthSha256: string;
  readonly sourceGroundTruthReview: {
    readonly status: 'source-checked';
    readonly method: string;
    readonly reviewedPages: readonly number[];
  };
  readonly catalogue: {
    readonly version: string;
    readonly manifestStatus: string;
    readonly integrityDigest: string;
  };
  readonly rules: {
    readonly mapping: string;
    readonly aliasNormalization: string;
    readonly unitComparison: string;
    readonly trendEligibility: string;
  };
  readonly measurements: readonly MeasurementAnnotation[];
  readonly aggregate: AnnotationAggregate;
};

function validateComponent(value: string, field: string): void {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`${field} is unsafe`);
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function exactAliasCandidates(sourceLabel: string): {
  readonly normalized: string;
  readonly entries: readonly BiomarkerCatalogueEntry[];
  readonly matchedAliases: readonly string[];
  readonly unsafe: boolean;
} {
  const normalized = normalizeCatalogueAlias(sourceLabel);
  const entries = comparableBiomarkers.filter((entry) =>
    entry.aliases.some((alias) => normalizeCatalogueAlias(alias) === normalized),
  );
  const matchedAliases = entries.flatMap((entry) =>
    entry.aliases.filter((alias) => normalizeCatalogueAlias(alias) === normalized),
  );
  const unsafe = comparableBiomarkers.some((entry) =>
    entry.unsafeAliases?.some((alias) => normalizeCatalogueAlias(alias) === normalized),
  );
  return { normalized, entries, matchedAliases, unsafe };
}

function mappingFor(measurement: EvaluationMeasurement): MeasurementAnnotation['mapping'] {
  const candidates = exactAliasCandidates(measurement.sourceLabel);
  let reason: MappingReason;
  let canonicalBiomarkerId: string | null = null;
  if (candidates.normalized.length === 0) reason = 'empty-label';
  else if (candidates.unsafe) reason = 'unsafe-alias';
  else if (candidates.entries.length === 0) reason = 'no-exact-reviewed-alias';
  else if (candidates.entries.length !== 1) reason = 'ambiguous-exact-alias';
  else {
    reason = 'exact-reviewed-alias';
    canonicalBiomarkerId = candidates.entries[0]!.id;
  }
  return {
    canonicalBiomarkerId,
    status: canonicalBiomarkerId === null ? 'unsupported' : 'mapped',
    reason,
    normalizedSourceLabel: candidates.normalized,
    matchedAliases: candidates.matchedAliases,
    candidateIds: candidates.entries.map((entry) => entry.id),
  };
}

function exactUnitSupported(unit: string | null, entry: BiomarkerCatalogueEntry): boolean {
  if (unit === null) return false;
  const normalizedUnit = unit.normalize('NFKC');
  return entry.units.some((candidate) => candidate.normalize('NFKC') === normalizedUnit);
}

function methodEvidenceText(measurement: EvaluationMeasurement): string {
  return [measurement.sourceLabel, measurement.referenceInterval, measurement.flag]
    .filter((value): value is string => value !== null)
    .join(' ');
}

function methodPolicyReason(
  measurement: EvaluationMeasurement,
  entry: BiomarkerCatalogueEntry,
): TrendReason | null {
  const policy = entry.methodPolicy;
  if (policy === undefined) return null;
  const sourceText = normalizeCatalogueAlias(methodEvidenceText(measurement));
  if (
    policy.unsafePatterns.some((pattern) => sourceText.includes(normalizeCatalogueAlias(pattern)))
  ) {
    return 'method-policy-unsafe-pattern';
  }
  if (policy.kind !== 'requires-explicit-method') return null;
  if (policy.profiles !== undefined) {
    const containsAny = (patterns: readonly string[]) =>
      patterns.some((pattern) => sourceText.includes(normalizeCatalogueAlias(pattern)));
    const matchedProfiles = policy.profiles.filter(
      (profile) =>
        containsAny(profile.assayPatterns) &&
        containsAny(profile.temperaturePatterns) &&
        containsAny(profile.pyridoxalPhosphatePatterns),
    );
    return matchedProfiles.length === 1 ? null : 'method-policy-requires-explicit-evidence';
  }
  return policy.allowedMethods.some((method) =>
    sourceText.includes(normalizeCatalogueAlias(method)),
  )
    ? null
    : 'method-policy-requires-explicit-evidence';
}

function trendFor(
  measurement: EvaluationMeasurement,
  mapping: MeasurementAnnotation['mapping'],
): MeasurementAnnotation['trend'] {
  const reasons: TrendReason[] = [];
  const entry =
    mapping.canonicalBiomarkerId === null
      ? undefined
      : comparableBiomarkers.find((candidate) => candidate.id === mapping.canonicalBiomarkerId);
  if (entry === undefined) {
    reasons.push('unmapped');
  } else {
    // Bounded results remain measured, but comparison treats them as non-points.
    if (measurement.valueType !== 'numeric') reasons.push('value-type-not-numeric');
    if (typeof measurement.parsedValue !== 'number' || !Number.isFinite(measurement.parsedValue)) {
      reasons.push('parsed-value-missing-or-invalid');
    }
    if (measurement.collectionDate === null || measurement.collectionDate.trim().length === 0) {
      reasons.push('collection-date-missing');
    } else if (Number.isNaN(Date.parse(measurement.collectionDate))) {
      reasons.push('collection-date-invalid');
    } else if (
      measurement.ambiguousFields.some((field) => field === 'collectionDate' || field === 'date')
    ) {
      reasons.push('collection-date-ambiguous');
    }
    if (measurement.unit === null) reasons.push('unit-missing');
    else if (!exactUnitSupported(measurement.unit, entry)) {
      reasons.push('unit-unsupported-or-case-mismatch');
    }
    if (measurement.specimen === null) reasons.push('specimen-missing');
    else if (!entry.specimens.some((specimen) => specimen === measurement.specimen)) {
      reasons.push('specimen-unsupported-or-case-mismatch');
    }
    const methodReason = methodPolicyReason(measurement, entry);
    if (methodReason !== null) reasons.push(methodReason);
  }
  return {
    trendEligible: reasons.length === 0,
    reasons,
    catalogueEntryId: entry?.id ?? null,
  };
}

function annotateMeasurement(
  measurement: EvaluationMeasurement,
  reportId: string,
  reportSha256: string,
  groundTruthSha256: string,
): MeasurementAnnotation {
  const mapping = mappingFor(measurement);
  const trend = trendFor(measurement, mapping);
  return {
    measurement,
    mapping,
    trend,
    provenance: {
      sourceMeasurementId: measurement.id,
      reportId,
      reportSha256,
      groundTruthSha256,
      sourcePage: measurement.page,
      sourceLocation: measurement.location,
    },
  };
}

function aggregateAnnotations(annotations: readonly MeasurementAnnotation[]): AnnotationAggregate {
  const mappingReasonCounts: Record<string, number> = {};
  const trendReasonCounts: Record<string, number> = {};
  let mappedCount = 0;
  let trendEligibleCount = 0;
  for (const annotation of annotations) {
    increment(mappingReasonCounts, annotation.mapping.reason);
    if (annotation.mapping.status === 'mapped') mappedCount += 1;
    if (annotation.trend.trendEligible) trendEligibleCount += 1;
    for (const reason of annotation.trend.reasons) increment(trendReasonCounts, reason);
  }
  return {
    measurementCount: annotations.length,
    mappedCount,
    unsupportedCount: annotations.length - mappedCount,
    mappingReasonCounts,
    trendEligibleCount,
    trendIneligibleCount: annotations.length - trendEligibleCount,
    trendReasonCounts,
  };
}

function annotateReport(
  reportId: string,
  reportPath: string,
  expectedPath: string,
): { readonly proposal: AnnotationProposal; readonly aggregate: AnnotationAggregate } {
  const expected = readExpectedResults(expectedPath);
  const reportSha256 = verifyReportAndGroundTruth(reportPath, expected, reportId);
  const groundTruthSha256 = sha256File(expectedPath);
  const measurements = expected.measurements.map((measurement) =>
    annotateMeasurement(measurement, reportId, reportSha256, groundTruthSha256),
  );
  const aggregate = aggregateAnnotations(measurements);
  return {
    proposal: {
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      annotationVersion: ANNOTATION_VERSION,
      status: 'draft',
      reportId,
      reportSha256,
      groundTruthSha256,
      sourceGroundTruthReview: {
        status: 'source-checked',
        method: expected.review.method,
        reviewedPages: expected.review.reviewedPages,
      },
      catalogue: {
        version: bundledCatalogueArtifact.manifest.version,
        manifestStatus: bundledCatalogueArtifact.manifest.status,
        integrityDigest: bundledCatalogueArtifact.integrity.digest,
      },
      rules: {
        mapping:
          'exact normalized reviewed alias only; all other rows are explicit null unsupported',
        aliasNormalization:
          'catalogue.normalizeCatalogueAlias (NFKD, accent folding, punctuation and case normalization)',
        unitComparison:
          'NFKC-equivalent exact case-sensitive catalogue unit; no conversion or case folding',
        trendEligibility:
          'canonical mapping, numeric point, finite parsed value, known unambiguous date, exact supported unit, exact supported specimen, and satisfied method policy',
      },
      measurements,
      aggregate,
    },
    aggregate,
  };
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const rootArgument = argumentValue(args, '--root');
  const reportsArgument = argumentValue(args, '--reports');
  if (rootArgument === undefined || reportsArgument === undefined) {
    throw new Error('--root and --reports are required');
  }
  const reportIds = [
    ...new Set(
      reportsArgument
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (reportIds.length === 0) throw new Error('--reports must contain at least one report id');
  reportIds.forEach((reportId) => validateComponent(reportId, 'report id'));
  const privateRoot = resolve(rootArgument);
  ensurePrivateDirectory(privateRoot);
  const resolvedRoot = realpathSync(privateRoot);
  const outputDirectory = resolve(
    argumentValue(args, '--output-dir') ??
      `${privateRoot}/ground-truth-proposals/catalogue-${bundledCatalogueArtifact.manifest.version}`,
  );
  assertPrivatePath(outputDirectory, resolvedRoot);
  const proposals: AnnotationAggregate[] = [];
  for (const reportId of reportIds) {
    const reportPath = assertPrivatePath(
      resolve(resolvedRoot, 'reports', `${reportId}.pdf`),
      resolvedRoot,
    );
    const expectedPath = assertPrivatePath(
      resolve(resolvedRoot, 'ground-truth', `${reportId}.json`),
      resolvedRoot,
    );
    // Existing source and truth files are private inputs as well as output dependencies.
    // Their contents never appear in stdout; only hashes and counts are reported.
    ensurePrivateDirectory(dirname(reportPath));
    ensurePrivateDirectory(dirname(expectedPath));
    securePrivateFile(reportPath);
    securePrivateFile(expectedPath);
    const result = annotateReport(reportId, reportPath, expectedPath);
    const proposalPath = assertPrivatePath(
      resolve(outputDirectory, `${reportId}.proposal.json`),
      resolvedRoot,
    );
    const aggregatePath = assertPrivatePath(
      resolve(outputDirectory, `${reportId}.aggregate.json`),
      resolvedRoot,
    );
    ensurePrivateDirectory(dirname(proposalPath));
    assertPrivatePath(proposalPath, resolvedRoot);
    writeJsonFile(proposalPath, result.proposal);
    writeJsonFile(aggregatePath, {
      schemaVersion: ANNOTATION_SCHEMA_VERSION,
      annotationVersion: ANNOTATION_VERSION,
      reportId,
      reportSha256: result.proposal.reportSha256,
      groundTruthSha256: result.proposal.groundTruthSha256,
      catalogue: result.proposal.catalogue,
      aggregate: result.aggregate,
    });
    proposals.push(result.aggregate);
  }
  const comparisonPath = assertPrivatePath(
    resolve(outputDirectory, 'comparison.json'),
    resolvedRoot,
  );
  ensurePrivateDirectory(dirname(comparisonPath));
  writeJsonFile(comparisonPath, {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    annotationVersion: ANNOTATION_VERSION,
    catalogue: {
      version: bundledCatalogueArtifact.manifest.version,
      manifestStatus: bundledCatalogueArtifact.manifest.status,
      integrityDigest: bundledCatalogueArtifact.integrity.digest,
    },
    reports: proposals,
  });
  process.stdout.write(
    `${JSON.stringify({ reportCount: reportIds.length, measurementCount: proposals.reduce((sum, item) => sum + item.measurementCount, 0), mappedCount: proposals.reduce((sum, item) => sum + item.mappedCount, 0), unsupportedCount: proposals.reduce((sum, item) => sum + item.unsupportedCount, 0), trendEligibleCount: proposals.reduce((sum, item) => sum + item.trendEligibleCount, 0), trendIneligibleCount: proposals.reduce((sum, item) => sum + item.trendIneligibleCount, 0) })}\n`,
  );
}

if (process.argv[1]?.endsWith('/annotate-ground-truth.ts') === true) {
  try {
    main();
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'ground-truth annotation failed');
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}

export { annotateMeasurement, annotateReport, aggregateAnnotations };
