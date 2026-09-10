/**
 * Evaluation-only page context classification.
 *
 * This helper is deliberately a page-level admission signal. It does not identify biomarkers,
 * parse values, or decide whether an individual row is measured. The classifier returns only
 * bounded counts so source text cannot reach ordinary diagnostics.
 */
import type { VisionObservation, VisionPage } from './qwen35-grounding';

export type SourceContextKind = 'laboratory-table' | 'imaging-narrative' | 'unknown';

export type SourceContextClassification = {
  readonly kind: SourceContextKind;
  readonly laboratoryEvidence: {
    readonly structuredTableCount: number;
    readonly unstructuredHeaderGroupCount: number;
    readonly explicitSectionHeadingCount: number;
  };
  readonly imagingEvidence: {
    readonly explicitHeadingCount: number;
  };
};

type HeaderRole = 'test' | 'result' | 'unit' | 'reference';
type Box = NonNullable<VisionObservation['boundingBox']>;

const RESULT_HEADER =
  /\b(?:current\s+|present\s+|latest\s+|actual\s+)?(?:result|results|value|values|outcome|measurement|measurements|resultat\w*|rezultat\w*|ergebnis\w*)\b/iu;
const PREVIOUS_RESULT_HEADER =
  /\b(?:previous|prior|former|historical|earlier|last|old|ankstes\w*|praeit\w*|vorherig\w*|früher\w*|zuvor\w*)\b[\s\S]{0,24}\b(?:result|results|value|values|resultat\w*|rezultat\w*|ergebnis\w*)\b/iu;
const GUIDANCE_RESULT_HEADER =
  /\b(?:target|expected|desired|goal|guidance|recommended|reference\s+target)\b[\s\S]{0,24}\b(?:result|results|value|values|resultat\w*|rezultat\w*|ergebnis\w*)\b/iu;
const TEST_HEADER =
  /\b(?:test|tests|analyte|analytes|parameter|parameters|assay|analysis|analyse|marker|name|tyrimas|tyrimo|tyrimai|laboratory\s+test)\b/iu;
const UNIT_HEADER = /\b(?:unit|units|einheit|einheiten|vienetas|matavimo\s+vienetas|uom)\b/iu;
const REFERENCE_HEADER =
  /\b(?:reference|ref\.?|interval|range|norm|norms|riba|ribos|referenz|referenzbereich)\b/iu;
const LABORATORY_SECTION_HEADING =
  /^(?:(?:the|der|die|das)\s+)?(?:laboratory|labor|lab|blood)\s+(?:report|results?|tests?|values?|examination|screening)$|^(?:blutbericht|blutwerte|laborbericht|laborbefund|laborwerte|laboruntersuchung|krau?jo\s+tyrim(?:as|ai)|laborator(?:inis|iniai)\s+tyrim(?:as|ai))$/iu;

const IMAGING_MODIFIER = /\b(?:mri|mrt|ct)\b/iu;
const IMAGING_FULL_NAME =
  /\b(?:magnetic\s+resonance(?:\s+imaging)?|computed\s+tomography|radiolog(?:y|ical)|medical\s+imaging|bildgebung)\b/iu;
const IMAGING_EXAM_NOUN =
  /\b(?:scan|exam(?:ination)?|study|finding(?:s)?|impression|report)\b|[\p{L}-]*(?:untersuchung|befund)\b/iu;
const IMAGING_HEADING_PREFIX =
  /^(?:(?:the|der|die|das)\s+)?(?:mri|mrt|ct|magnetic\s+resonance(?:\s+imaging)?|computed\s+tomography|radiolog(?:y|ical)|imaging|bildgebung)\b|^(?:exam(?:ination)?|study|report|befund|untersuchung)\s*[:\-]/iu;

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function validBox(value: VisionObservation['boundingBox']): value is Box {
  return (
    value !== undefined &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function centerY(observation: VisionObservation): number | null {
  const box = observation.boundingBox;
  return validBox(box) ? box.y + box.height / 2 : null;
}

function rolesForText(value: string): ReadonlySet<HeaderRole> {
  const text = normalizedText(value);
  if (text.length === 0) return new Set();
  const roles = new Set<HeaderRole>();
  if (TEST_HEADER.test(text)) roles.add('test');
  if (UNIT_HEADER.test(text)) roles.add('unit');
  if (REFERENCE_HEADER.test(text)) roles.add('reference');
  const previous = PREVIOUS_RESULT_HEADER.test(text);
  const guidance = GUIDANCE_RESULT_HEADER.test(text);
  // A line containing more than one result column is ambiguous without table ownership. Keep
  // it out of the positive signal; structured cells and split spans can still prove each role.
  if (!previous && !guidance && RESULT_HEADER.test(text)) roles.add('result');
  return roles;
}

function hasPositiveRoles(roles: ReadonlySet<HeaderRole>): boolean {
  return roles.has('test') && roles.has('result') && (roles.has('unit') || roles.has('reference'));
}

function tableCell(observation: VisionObservation): boolean {
  return observation.structure?.kind === 'table-cell';
}

function structuredLaboratoryTableCount(page: VisionPage): number {
  const rolesByTable = new Map<string, Set<HeaderRole>>();
  for (const observation of page.observations) {
    const structure = observation.structure;
    if (
      structure?.kind !== 'table-cell' ||
      structure.tableId === undefined ||
      structure.rowIndex !== 0
    ) {
      continue;
    }
    const roles = rolesByTable.get(structure.tableId) ?? new Set<HeaderRole>();
    for (const role of rolesForText(observation.text)) roles.add(role);
    rolesByTable.set(structure.tableId, roles);
  }
  return [...rolesByTable.values()].filter(hasPositiveRoles).length;
}

function headerGroups(page: VisionPage): readonly (readonly VisionObservation[])[] {
  const candidates = page.observations
    .filter((observation) => !tableCell(observation) && centerY(observation) !== null)
    .toSorted((left, right) => centerY(left)! - centerY(right)!);
  if (candidates.length === 0) return [];
  const heights = candidates.map((observation) => observation.boundingBox!.height).toSorted();
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const groups: VisionObservation[][] = [];
  const centers: number[] = [];
  for (const observation of candidates) {
    const y = centerY(observation)!;
    const previousIndex = groups.length - 1;
    const previous = previousIndex < 0 ? undefined : groups[previousIndex];
    const previousCenter = previousIndex < 0 ? undefined : centers[previousIndex];
    const previousHeight = previous?.[previous.length - 1]?.boundingBox?.height ?? medianHeight;
    const verticalTolerance =
      Math.max(medianHeight, previousHeight, observation.boundingBox!.height) * 1.35;
    if (
      previous !== undefined &&
      previousCenter !== undefined &&
      y - previousCenter <= verticalTolerance
    ) {
      previous.push(observation);
      centers[previousIndex] =
        previous.reduce((sum, item) => sum + centerY(item)!, 0) / previous.length;
    } else {
      groups.push([observation]);
      centers.push(y);
    }
  }
  return groups;
}

function unstructuredLaboratoryHeaderGroupCount(page: VisionPage): number {
  let count = 0;
  for (const group of headerGroups(page)) {
    const roles = new Set<HeaderRole>();
    for (const observation of group) {
      for (const role of rolesForText(observation.text)) roles.add(role);
    }
    if (hasPositiveRoles(roles)) count += 1;
  }
  return count;
}

function explicitLaboratorySectionHeading(observation: VisionObservation): boolean {
  if (tableCell(observation) || !validBox(observation.boundingBox)) return false;
  const text = normalizedText(observation.text).replace(/[:\-–—]\s*$/u, '');
  if (text.length === 0 || text.length > 80 || text.split(' ').length > 8) return false;
  return LABORATORY_SECTION_HEADING.test(text);
}

function explicitImagingHeading(observation: VisionObservation): boolean {
  if (tableCell(observation) || !validBox(observation.boundingBox)) return false;
  const text = normalizedText(observation.text);
  if (text.length === 0 || text.length > 120 || text.split(' ').length > 16) return false;
  const hasModality = IMAGING_MODIFIER.test(text) || IMAGING_FULL_NAME.test(text);
  if (!hasModality || !IMAGING_HEADING_PREFIX.test(text)) return false;
  return (
    IMAGING_FULL_NAME.test(text) || (IMAGING_MODIFIER.test(text) && IMAGING_EXAM_NOUN.test(text))
  );
}

export function classifySourceContext(page: VisionPage): SourceContextClassification {
  const structuredTableCount = structuredLaboratoryTableCount(page);
  const unstructuredHeaderGroupCount = unstructuredLaboratoryHeaderGroupCount(page);
  const explicitSectionHeadingCount = page.observations.filter(
    explicitLaboratorySectionHeading,
  ).length;
  const explicitHeadingCount = page.observations.filter(explicitImagingHeading).length;
  const laboratory = structuredTableCount + unstructuredHeaderGroupCount > 0;
  const hasLaboratorySection = explicitSectionHeadingCount > 0;
  return {
    kind: laboratory
      ? 'laboratory-table'
      : explicitHeadingCount > 0 && !hasLaboratorySection
        ? 'imaging-narrative'
        : 'unknown',
    laboratoryEvidence: {
      structuredTableCount,
      unstructuredHeaderGroupCount,
      explicitSectionHeadingCount,
    },
    imagingEvidence: { explicitHeadingCount },
  };
}
