import { compareCodeUnits } from '../src/artifact';
import type {
  BiomarkerCatalogueEntry,
  CatalogueArtifact,
  CatalogueMethodPolicy,
  CatalogueReviewMetadata,
  CatalogueSource,
  GeneralGuidance,
  SpecimenCompatibility,
} from '../src/schema';

const NO_VALUE = '(none encoded)';

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 0 ? value : '""';
  return String(value);
}

function code(value: string | number | boolean | null): string {
  return `\`${scalar(value)}\``;
}

function list(values: readonly (string | number | boolean)[]): string {
  return values.length === 0 ? NO_VALUE : values.map((value) => code(value)).join(', ');
}

function lines(values: readonly (string | number | boolean)[], indent = ''): string[] {
  return values.length === 0
    ? [`${indent}- ${NO_VALUE}`]
    : values.map((value) => `${indent}- ${code(value)}`);
}

function compatibility(value: SpecimenCompatibility | undefined): string[] {
  if (value === undefined || value.length === 0) return [`- ${NO_VALUE}`];
  return value.map(
    (group, index) => `${index + 1}. ${group.map((specimen) => code(specimen)).join(', ')}`,
  );
}

function markdownText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function sourceLink(source: CatalogueSource): string {
  return `[${markdownText(source.id)} — ${markdownText(source.title)}](${source.url})`;
}

function sourceDetails(source: CatalogueSource): string[] {
  return [
    `- ${sourceLink(source)}`,
    `  - publisher: ${markdownText(source.publisher)}`,
    `  - publication date: ${code(source.publicationDate)}`,
    `  - accessed date: ${code(source.accessedAt)}`,
    `  - source kind: ${code(source.sourceKind)}`,
    `  - URL: ${source.url}`,
  ];
}

function reviewMetadata(metadata: CatalogueReviewMetadata): string[] {
  return [
    `- catalogue review status: ${code(metadata.status)}`,
    `- source content version: ${code(metadata.contentVersion)}`,
    `- source reviewed date: ${code(metadata.reviewedAt)}`,
    `- source reviewer: ${code(metadata.reviewer)}`,
    `- source review notes: ${markdownText(metadata.reviewNotes)}`,
  ];
}

function decisionFields(sourceContentVersion: string): string[] {
  return [
    '- **Human decision (leave blank; select exactly one later):** `________________` (`approve` / `revise` / `withhold`)',
    '- Qualified reviewer identity: `________________`',
    '- Reviewer qualification: `________________`',
    '- Review date (ISO 8601): `________________`',
    `- Reviewed content version: \`________________\` (source content version: ${code(sourceContentVersion)})`,
    '- Reviewer notes: `________________`',
  ];
}

function methodPolicyDetails(policy: CatalogueMethodPolicy | undefined): string[] {
  if (policy === undefined) return [`- ${NO_VALUE}`];

  const output = [
    `- policy version: ${code(policy.version)}`,
    `- kind: ${code(policy.kind)}`,
    '- allowed methods:',
    ...lines(policy.allowedMethods, '  '),
    '- unsafe method patterns:',
    ...lines(policy.unsafePatterns, '  '),
    `- rationale: ${markdownText(policy.rationale)}`,
  ];
  if (policy.profiles === undefined || policy.profiles.length === 0) {
    output.push(`- method profiles: ${NO_VALUE}`);
    return output;
  }

  output.push('- method profiles:');
  for (const profile of policy.profiles) {
    output.push(
      `  - profile ${code(profile.id)}: assay patterns ${list(profile.assayPatterns)}; temperature ${code(profile.temperatureC)} °C; temperature patterns ${list(profile.temperaturePatterns)}; pyridoxal phosphate ${code(profile.pyridoxalPhosphate)}; pyridoxal phosphate patterns ${list(profile.pyridoxalPhosphatePatterns)}`,
    );
  }
  return output;
}

function conversionDetails(
  entry: BiomarkerCatalogueEntry,
  sourceById: ReadonlyMap<string, CatalogueSource>,
): string[] {
  const conversions = entry.unitConversions ?? [];
  if (conversions.length === 0) return [`- ${NO_VALUE}`];

  const output = [
    '| From | To | Factor | Offset | Authority source |',
    '| --- | --- | ---: | ---: | --- |',
  ];
  for (const conversion of conversions) {
    const source = sourceById.get(conversion.sourceId);
    if (source === undefined) throw new Error(`Missing conversion source ${conversion.sourceId}`);
    output.push(
      `| ${code(conversion.from)} | ${code(conversion.to)} | ${code(conversion.factor)} | ${code(conversion.offset)} | ${sourceLink(source)} |`,
    );
  }
  return output;
}

function guidanceDetails(
  guidance: GeneralGuidance,
  sourceById: ReadonlyMap<string, CatalogueSource>,
): string[] {
  const output = [
    `### Guidance item ${code(guidance.id)}`,
    `- label: ${markdownText(guidance.label)}`,
    `- description: ${markdownText(guidance.description)}`,
    '- thresholds:',
  ];
  if (guidance.thresholds.length === 0) {
    output.push(`  - ${NO_VALUE}`);
  } else {
    for (const threshold of guidance.thresholds) {
      output.push(
        `  - ${code(threshold.operator)} ${code(threshold.value)} ${code(threshold.unit)}`,
      );
    }
  }
  output.push(
    '- applicability:',
    `  - population: ${code(guidance.applicability.population)}`,
    `  - jurisdiction: ${code(guidance.applicability.jurisdiction)}`,
    `  - context: ${code(guidance.applicability.context)}`,
    `  - purpose: ${code(guidance.applicability.purpose ?? null)}`,
    `  - sex: ${code(guidance.applicability.sex)}`,
    `  - fasting: ${code(guidance.applicability.fasting)}`,
    `  - specimen: ${code(guidance.applicability.specimen ?? null)}`,
    '  - limitations:',
    ...lines(guidance.applicability.limitations, '    '),
    `- disagreement: ${markdownText(guidance.disagreement ?? NO_VALUE)}`,
    `- authority: ${markdownText(guidance.authority)}`,
    `- publication version: ${code(guidance.publicationVersion)}`,
    `- review date: ${code(guidance.reviewDate)}`,
    `- unit: ${code(guidance.unit)}`,
    `- boundary semantics: ${code(guidance.boundarySemantics)}`,
    '- source metadata and links:',
  );
  for (const sourceId of guidance.sources) {
    const source = sourceById.get(sourceId);
    if (source === undefined) throw new Error(`Missing guidance source ${sourceId}`);
    output.push(...sourceDetails(source).map((line) => `  ${line}`));
  }
  output.push(
    '- source review metadata:',
    ...reviewMetadata(guidance.review).map((line) => `  ${line}`),
  );
  output.push(
    '- blank human decision fields:',
    ...decisionFields(guidance.review.contentVersion).map((line) => `  ${line}`),
  );
  return output;
}

function entryDetails(
  entry: BiomarkerCatalogueEntry,
  sourceById: ReadonlyMap<string, CatalogueSource>,
  index: number,
): string[] {
  const output = [
    `## ${index}. ${code(entry.id)} — ${markdownText(entry.canonicalLabel ?? '(canonical label not encoded)')}`,
    `- canonical label: ${markdownText(entry.canonicalLabel ?? NO_VALUE)}`,
    `- catalogue version: ${code(entry.catalogueVersion ?? null)}`,
    `- value type: ${code(entry.valueType ?? null)}`,
    `- canonical unit: ${code(entry.canonicalUnit ?? null)}`,
    '- accepted units:',
    ...lines(entry.units, '  '),
    '- accepted specimens:',
    ...lines(entry.specimens, '  '),
    '- specimen compatibility groups:',
    ...compatibility(entry.specimenCompatibility).map((line) => `  ${line}`),
    '- aliases:',
    ...lines(entry.aliases, '  '),
    '- unsafe aliases:',
    ...lines(entry.unsafeAliases ?? [], '  '),
    '- method/specimen constraints:',
    ...methodPolicyDetails(entry.methodPolicy).map((line) => `  ${line}`),
    '- exact unit conversions:',
    ...conversionDetails(entry, sourceById).map((line) => `  ${line}`),
    `- explanation (source copy; not approved for publication): ${markdownText(entry.explanation ?? NO_VALUE)}`,
    '- entry limitations: see the exact explanation, method rationale, unsafe aliases, specimen groups, and any guidance limitations above; no separate entry-level limitations field is encoded.',
    '- entry disagreements: no separate entry-level disagreement field is encoded; guidance disagreements are preserved below.',
    '- source metadata and links:',
  ];
  for (const source of entry.sources ?? [])
    output.push(...sourceDetails(source).map((line) => `  ${line}`));
  output.push(
    '- source review metadata:',
    ...reviewMetadata(
      entry.review ?? {
        status: 'pending-human-publication',
        contentVersion: entry.catalogueVersion ?? 'unknown',
        reviewedAt: null,
        reviewer: null,
        reviewNotes: 'No entry review metadata is encoded.',
      },
    ).map((line) => `  ${line}`),
    '- guidance items:',
  );
  const guidance = [...(entry.generalGuidance ?? [])].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  if (guidance.length === 0) {
    output.push(`  - ${NO_VALUE}`);
  } else {
    for (const item of guidance)
      output.push(...guidanceDetails(item, sourceById).map((line) => `  ${line}`));
  }
  output.push(
    '- blank human decision fields:',
    ...decisionFields(entry.review?.contentVersion ?? entry.catalogueVersion ?? 'unknown').map(
      (line) => `  ${line}`,
    ),
  );
  return output;
}

/** Render the complete review packet from one validated catalogue artifact. */
export function renderCatalogueReviewPacket(artifact: CatalogueArtifact): string {
  if (artifact.manifest.status !== 'review-pending') {
    throw new Error('Catalogue review packet requires a review-pending manifest');
  }
  const entries = [...artifact.entries].sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const entry of entries) {
    if (entry.review?.status !== 'pending-human-publication') {
      throw new Error(`Catalogue review packet entry is not pending: ${entry.id}`);
    }
    for (const guidance of entry.generalGuidance ?? []) {
      if (guidance.review.status !== 'pending-human-publication') {
        throw new Error(`Catalogue review packet guidance is not pending: ${guidance.id}`);
      }
    }
  }
  const sourceById = new Map(artifact.sourceSet.map((source) => [source.id, source]));
  const guidanceCount = entries.reduce(
    (count, entry) => count + (entry.generalGuidance?.length ?? 0),
    0,
  );
  const output = [
    '# Alyte qualified catalogue review packet',
    '',
    '<!-- prettier-ignore-start -->',
    '',
    '> **PENDING HUMAN REVIEW — NOT APPROVED.** This packet is generated from the versioned catalogue artifact. It records no qualified-human decision, reviewer identity, reviewer qualification, or approval. Blank decision fields are intentional. Integrity signing is not medical-content approval.',
    '',
    'This is a source-review aid for an authorized qualified human content owner. Review each Biomarker entry and each General Guidance item independently. The packet preserves the catalogue values and provenance; it does not add or resolve medical claims.',
    '',
    '## Packet metadata',
    '',
    `- packet status: ${code('pending-human-review')}`,
    `- artifact schema version: ${code(artifact.schemaVersion)}`,
    `- catalogue version: ${code(artifact.manifest.version)}`,
    `- catalogue manifest status: ${code(artifact.manifest.status)}`,
    `- signature present: ${code(artifact.signature === null ? 'no' : 'yes')}`,
    `- entry count: ${code(entries.length)}`,
    `- General Guidance item count: ${code(guidanceCount)}`,
    `- source-set count: ${code(artifact.sourceSet.length)}`,
    '',
    '## Human-only review boundary',
    '',
    '- An automated agent may generate this packet and check completeness/freshness, but may not approve, revise, withhold, qualify, or publish catalogue content.',
    '- Leave every decision field blank until an authorized reviewer records one decision and their identity, qualification, date, content version, and notes.',
    '- A signature proves artifact integrity only. It does not prove reviewer qualification or medical-content approval.',
    '- A later maintainer change must preserve this packet’s pending status until the human publication review is complete.',
    '',
    '## Entries',
    '',
  ];
  entries.forEach((entry, index) => {
    output.push(...entryDetails(entry, sourceById, index + 1), '');
  });
  output.push(
    '## Returning a completed review',
    '',
    'The authorized reviewer should return a copy of this packet through the maintainer-approved review channel, with exactly one `approve`, `revise`, or `withhold` decision for every entry and every guidance item, plus identity, qualification, review date, reviewed content version, and notes. Do not change the catalogue manifest, source modules, generated artifact, signatures, or approval fields as part of returning this packet. A later implementation ticket may apply explicit human decisions; until then, the checked-in catalogue remains `review-pending`.',
    '',
    'Generated by `packages/catalogue/scripts/catalogue-review-packet.ts`; do not edit the checked-in packet by hand.',
    '',
    '<!-- prettier-ignore-end -->',
  );
  return `${output.join('\n')}\n`;
}
