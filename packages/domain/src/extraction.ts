import type { CanonicalId } from './index';
import { parseLocaleDecimal } from './labs';
import type { MeasurementValue, SpecimenType, LabDateState } from './labs';

export const VISION_OCR_CONTRACT_VERSION = 'alyte.vision.document.v2' as const;
export const EXTRACTION_PARSER_VERSION = 'alyte.local-parser.v2' as const;

const NUMERIC_TOKEN_PATTERN =
  '[<>≤≥]?\\s*[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?)|(?:\\d+(?:[.,]\\d+)?)|(?:\\.\\d+))';
const PLAIN_NUMERIC_TOKEN_PATTERN =
  '[+-]?(?:(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?)|(?:\\d+(?:[.,]\\d+)?)|(?:\\.\\d+))';

export type NormalizedBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type VisionTextObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly boundingBox: NormalizedBoundingBox;
  readonly pageIndex: number;
  readonly orientation: number;
  readonly structure?: {
    readonly kind: 'text' | 'table-cell';
    readonly tableId: string | null;
    readonly rowIndex: number | null;
    readonly columnIndex: number | null;
  };
  /** Internal routing metadata. Never render this as a user-facing accuracy percentage. */
  readonly recognition: {
    readonly level: 'fast' | 'accurate';
    readonly language: string | null;
    readonly internalConfidence: number | null;
  };
};

export type VisionOCRResult = {
  readonly contractVersion: typeof VISION_OCR_CONTRACT_VERSION;
  readonly pageIndex: number;
  readonly orientation: number;
  readonly observations: readonly VisionTextObservation[];
};

export type ExtractionSourceLocation = {
  readonly pageIndex: number;
  readonly boundingBox: NormalizedBoundingBox;
  readonly orientation: number;
  readonly observationIds: readonly string[];
};

export type ExtractionDateContext = {
  readonly observationId: string;
  readonly pageIndex: number;
  readonly centerY: number;
  readonly locale: string | null;
  readonly context: 'collection' | 'unknown';
  readonly ambiguous: boolean;
  readonly collectionDate: LabDateState;
};

export type ExtractionRowDecision = 'unresolved' | 'preserve' | 'skip' | 'resolve';

export type ExtractionReviewReason =
  | 'missing-label'
  | 'missing-value'
  | 'unparseable-value'
  | 'unsupported-alias'
  | 'incompatible-unit'
  | 'incompatible-specimen'
  | 'unparseable-reference-interval'
  | 'missing-collection-date'
  | 'ambiguous-date'
  | 'unsupported-layout';

export type ExtractionDraftRow = {
  readonly id: string;
  readonly order: number;
  readonly panelLabel: string | null;
  readonly sourceText: string;
  readonly sourceLabel: string;
  readonly sourceValue: MeasurementValue;
  readonly sourceValueString: string;
  readonly sourceUnit: string | null;
  readonly sourceReferenceInterval: string | null;
  readonly sourceFlag: string | null;
  readonly source: ExtractionSourceLocation;
  readonly collectionDateContext: ExtractionDateContext | null;
  readonly proposedLabel: string;
  readonly proposedValue: MeasurementValue;
  readonly proposedUnit: string | null;
  readonly proposedReferenceInterval: string | null;
  readonly proposedFlag: string | null;
  readonly proposedBiomarkerId: CanonicalId | null;
  readonly proposedSpecimenType: SpecimenType;
  readonly collectionDate: LabDateState;
  readonly reviewReasons: readonly ExtractionReviewReason[];
  readonly reviewState: 'ready' | 'needs-review';
  readonly decision: ExtractionRowDecision;
};

export type ExtractionDraft = {
  readonly id: string;
  readonly reportId: string;
  readonly state: 'draft' | 'confirmed' | 'failed';
  readonly ocrContractVersion: typeof VISION_OCR_CONTRACT_VERSION;
  readonly parserVersion: typeof EXTRACTION_PARSER_VERSION;
  readonly collectionDate: LabDateState;
  readonly rows: readonly ExtractionDraftRow[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
};

export type ExtractionAliasEntry = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly specimens: readonly SpecimenType[];
  readonly units: readonly string[];
};

export type ExtractionSemanticProposal = {
  readonly sourceObservationIds: readonly string[];
  readonly proposedBiomarkerId: CanonicalId | null;
};

export interface ExtractionSemanticMapper {
  readonly adapterVersion: string;
  readonly schemaVersion: 'alyte.semantic-mapper.v1';
  supports(locale: string | null): boolean;
  map(input: {
    readonly pageIndex: number;
    readonly observations: readonly VisionTextObservation[];
  }): Promise<readonly ExtractionSemanticProposal[]>;
}

/** Rejects model output unless it refers only to exact local observations and known catalogue IDs. */
export function validateSemanticProposals(
  proposals: readonly ExtractionSemanticProposal[],
  observations: readonly VisionTextObservation[],
  aliases: readonly ExtractionAliasEntry[],
): readonly ExtractionSemanticProposal[] {
  const sourceIds = new Set(observations.map((item) => item.id));
  const biomarkerIds = new Set(aliases.map((item) => item.id));
  return proposals.filter(
    (proposal) =>
      proposal.sourceObservationIds.length > 0 &&
      proposal.sourceObservationIds.every((id) => sourceIds.has(id)) &&
      (proposal.proposedBiomarkerId === null || biomarkerIds.has(proposal.proposedBiomarkerId)),
  );
}

export type ExtractionRowInput = {
  readonly id: string;
  readonly order: number;
  readonly panelLabel?: string | null;
  readonly text: string;
  readonly source: ExtractionSourceLocation;
  readonly collectionDate?: LabDateState;
  readonly collectionDateContexts?: readonly ExtractionDateContext[];
  readonly specimenType?: SpecimenType;
};

export type ExtractionDraftRowPatch = {
  readonly proposedLabel?: string;
  readonly proposedValue?: MeasurementValue;
  readonly proposedUnit?: string | null;
  readonly proposedReferenceInterval?: string | null;
  readonly proposedFlag?: string | null;
  readonly proposedBiomarkerId?: CanonicalId | null;
  readonly proposedSpecimenType?: SpecimenType;
  readonly collectionDate?: LabDateState;
  readonly decision?: ExtractionRowDecision;
};

export type ExtractionConfirmationPlan = {
  readonly draftId: string;
  readonly reportId: string;
  readonly records: readonly {
    readonly id: string;
    readonly collectionDate: LabDateState;
    readonly specimenType: SpecimenType;
    readonly measurements: readonly {
      readonly id: string;
      readonly biomarkerId: CanonicalId | null;
      readonly label: string;
      readonly value: MeasurementValue;
      readonly valueString: string;
      readonly unit: string | null;
      readonly referenceInterval: string | null;
      readonly flag: string | null;
      readonly source: ExtractionSourceLocation;
      readonly original: {
        readonly label: string;
        readonly value: MeasurementValue;
        readonly valueString: string;
        readonly unit: string | null;
        readonly referenceInterval: string | null;
        readonly flag: string | null;
      };
      readonly sourceRowId: string;
      readonly reviewState: 'confirmed' | 'needs-review';
      readonly provenance: 'extracted' | 'user-corrected';
    }[];
  }[];
};

export function decodeVisionOCRResult(input: unknown): VisionOCRResult {
  if (typeof input !== 'object' || input === null)
    throw new Error('Vision OCR result is not an object');
  const value = input as Record<string, unknown>;
  if (value.contractVersion !== VISION_OCR_CONTRACT_VERSION)
    throw new Error('Unsupported Vision OCR contract version');
  const pageIndex = finiteInteger(value.pageIndex, 'Vision OCR page index', 0);
  const orientation = finiteInteger(value.orientation ?? 0, 'Vision OCR orientation', -360, 360);
  if (!Array.isArray(value.observations)) throw new Error('Vision OCR observations are missing');
  return {
    contractVersion: VISION_OCR_CONTRACT_VERSION,
    pageIndex,
    orientation,
    observations: value.observations.map((item, index) =>
      decodeObservation(item, index, pageIndex, orientation),
    ),
  };
}

function finiteInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Invalid ${field}`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${field}`);
  return value;
}

function decodeObservation(
  input: unknown,
  index: number,
  pageIndex: number,
  pageOrientation: number,
): VisionTextObservation {
  if (typeof input !== 'object' || input === null)
    throw new Error(`Vision OCR observation ${index} is not an object`);
  const value = input as Record<string, unknown>;
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (text.length === 0) throw new Error(`Vision OCR observation ${index} has no text`);
  const rawBox = value.boundingBox;
  if (typeof rawBox !== 'object' || rawBox === null)
    throw new Error(`Vision OCR observation ${index} has no bounding box`);
  const box = rawBox as Record<string, unknown>;
  const boundingBox = {
    x: finiteNumber(box.x, 'Vision OCR bounding-box x'),
    y: finiteNumber(box.y, 'Vision OCR bounding-box y'),
    width: finiteNumber(box.width, 'Vision OCR bounding-box width'),
    height: finiteNumber(box.height, 'Vision OCR bounding-box height'),
  };
  if (
    boundingBox.x < 0 ||
    boundingBox.y < 0 ||
    boundingBox.width <= 0 ||
    boundingBox.height <= 0 ||
    boundingBox.x + boundingBox.width > 1.000001 ||
    boundingBox.y + boundingBox.height > 1.000001
  ) {
    throw new Error(`Vision OCR observation ${index} has an invalid normalized bounding box`);
  }
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const rawRecognition =
    typeof value.recognition === 'object' && value.recognition !== null
      ? (value.recognition as Record<string, unknown>)
      : {};
  const level = rawRecognition.level === 'fast' ? 'fast' : 'accurate';
  const language =
    typeof rawRecognition.language === 'string' && rawRecognition.language.length > 0
      ? rawRecognition.language
      : null;
  const internalConfidence =
    rawRecognition.internalConfidence === null || rawRecognition.internalConfidence === undefined
      ? null
      : finiteNumber(rawRecognition.internalConfidence, 'Vision OCR internal confidence');
  if (internalConfidence !== null && (internalConfidence < 0 || internalConfidence > 1))
    throw new Error(`Vision OCR observation ${index} has invalid internal confidence`);
  return {
    id:
      typeof value.id === 'string' && value.id.length > 0
        ? value.id
        : `observation-${pageIndex}-${index}`,
    text,
    alternatives,
    boundingBox,
    pageIndex:
      value.pageIndex === undefined
        ? pageIndex
        : finiteInteger(value.pageIndex, 'Vision OCR observation page index', 0),
    orientation:
      value.orientation === undefined
        ? pageOrientation
        : finiteInteger(value.orientation, 'Vision OCR observation orientation', -360, 360),
    structure: decodeObservationStructure(value.structure, index),
    recognition: { level, language, internalConfidence },
  };
}

function decodeObservationStructure(
  input: unknown,
  index: number,
): NonNullable<VisionTextObservation['structure']> {
  if (input === undefined)
    return { kind: 'text', tableId: null, rowIndex: null, columnIndex: null };
  if (typeof input !== 'object' || input === null)
    throw new Error(`Vision OCR observation ${index} has invalid structure`);
  const value = input as Record<string, unknown>;
  const kind = value.kind === 'table-cell' ? 'table-cell' : value.kind === 'text' ? 'text' : null;
  if (kind === null) throw new Error(`Vision OCR observation ${index} has invalid structure kind`);
  const tableId = typeof value.tableId === 'string' && value.tableId ? value.tableId : null;
  const rowIndex =
    value.rowIndex === null || value.rowIndex === undefined
      ? null
      : finiteInteger(value.rowIndex, 'table row index', 0);
  const columnIndex =
    value.columnIndex === null || value.columnIndex === undefined
      ? null
      : finiteInteger(value.columnIndex, 'table column index', 0);
  if (kind === 'table-cell' && (tableId === null || rowIndex === null || columnIndex === null))
    throw new Error(`Vision OCR observation ${index} has incomplete table structure`);
  return { kind, tableId, rowIndex, columnIndex };
}

export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function proposeBiomarkerId(
  label: string,
  aliases: readonly ExtractionAliasEntry[],
): CanonicalId | null {
  const normalized = normalizeAlias(label);
  if (!normalized) return null;
  const exact = aliases.find((entry) =>
    entry.aliases.some((alias) => normalizeAlias(alias) === normalized),
  );
  return exact === undefined ? null : (exact.id as CanonicalId);
}

export function parseComparatorValue(input: string): MeasurementValue | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^([<>≤≥])?\s*([+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+))\s*(.*)$/u);
  if (match === null) return trimmed.length === 0 ? null : { kind: 'free_text', value: trimmed };
  const numeric = parseLocaleDecimal(match[2] ?? '');
  if (numeric === null) return { kind: 'free_text', value: trimmed };
  const comparator = match[1] === '≤' ? '<' : match[1] === '≥' ? '>' : match[1];
  return comparator === '<' || comparator === '>'
    ? { kind: 'bounded', comparator, value: numeric }
    : { kind: 'numeric', value: numeric };
}

export function parseLabDate(input: string, locale = 'en-US'): LabDateState | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[./-]/).map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  let year: number;
  let month: number;
  let day: number;
  if (String(parts[0]).length === 4) [year, month, day] = parts as [number, number, number];
  else if ((parts[0] ?? 0) > 12) [day, month, year] = parts as [number, number, number];
  else if ((parts[1] ?? 0) > 12) [month, day, year] = parts as [number, number, number];
  else if (/^en-(us|ca)/i.test(locale)) [month, day, year] = parts as [number, number, number];
  else [day, month, year] = parts as [number, number, number];
  if (year < 100) year += 2000;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days) return null;
  return {
    kind: 'known',
    value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function parseReferenceInterval(input: string | null): string | null {
  if (input === null) return null;
  const value = input.trim();
  if (!value) return null;
  // Preserve the laboratory string exactly, but reject strings that look like an OCR fragment.
  const range = value.match(
    /^(?:[<>≤≥]\s*)?[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+)(?:\s*(?:-|–|—|to)\s*[<>≤≥]?\s*[+-]?(?:\d[\d\s\u00a0\u202f.,]*|\.\d+))?$/iu,
  );
  return range === null ? null : value;
}

export function normalizeUnit(input: string | null): string | null {
  if (input === null) return null;
  const normalized = input.trim().replace('μ', 'µ').replace(/\s+/g, ' ');
  if (!normalized) return null;
  const lower = normalized.toLocaleLowerCase();
  const aliases: Record<string, string> = {
    'mg/dl': 'mg/dL',
    'mg dl': 'mg/dL',
    'mmol/l': 'mmol/L',
    'mmol l': 'mmol/L',
    'g/dl': 'g/dL',
    'g/l': 'g/L',
    '%': '%',
    'mmol/mol': 'mmol/mol',
    fl: 'fL',
    'ng/ml': 'ng/mL',
    'ug/l': 'µg/L',
    'µg/l': 'µg/L',
    'nmol/l': 'nmol/L',
    'pg/ml': 'pg/mL',
    'pmol/l': 'pmol/L',
    'u/l': 'U/L',
    'iu/l': 'U/L',
    'l/l': 'L/L',
  };
  return aliases[lower] ?? normalized;
}

function unitCompatible(
  unit: string | null,
  biomarkerId: CanonicalId | null,
  aliases: readonly ExtractionAliasEntry[],
): boolean {
  if (unit === null || biomarkerId === null) return true;
  const entry = aliases.find((candidate) => candidate.id === biomarkerId);
  return (
    entry === undefined ||
    entry.units.some((candidate) => normalizeUnit(candidate) === normalizeUnit(unit))
  );
}

function specimenCompatible(
  specimen: SpecimenType,
  biomarkerId: CanonicalId | null,
  aliases: readonly ExtractionAliasEntry[],
): boolean {
  if (biomarkerId === null || specimen === 'unknown') return true;
  const entry = aliases.find((candidate) => candidate.id === biomarkerId);
  return entry === undefined || entry.specimens.includes(specimen);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp | null {
  const words = normalizeAlias(alias).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join('[^\\p{L}\\p{N}]+'), 'iu');
}

function findAliasInText(
  sourceText: string,
  aliases: readonly ExtractionAliasEntry[],
): { readonly id: CanonicalId; readonly text: string } | null {
  const matches = aliases.flatMap((entry) =>
    entry.aliases.flatMap((alias) => {
      const pattern = aliasPattern(alias);
      const match = pattern?.exec(sourceText);
      return match === null || match === undefined
        ? []
        : (() => {
            const start = match.index;
            let end = start + match[0].length;
            if (sourceText[end] === '(') {
              const closing = sourceText.indexOf(')', end + 1);
              if (closing >= 0) end = closing + 1;
            }
            return [
              {
                id: entry.id as CanonicalId,
                text: sourceText.slice(start, end),
                length: normalizeAlias(alias).length,
              },
            ];
          })();
    }),
  );
  matches.sort((a, b) => b.length - a.length || a.text.length - b.text.length);
  const match = matches[0];
  return match === undefined ? null : { id: match.id, text: match.text };
}

function findUnitInText(sourceText: string): string | null {
  const match = sourceText.match(
    /(?:mg\s*\/\s*dL?|mmol\s*\/\s*L|g\s*\/\s*dL?|g\s*\/\s*L|ng\s*\/\s*mL|nmol\s*\/\s*L|µ?g\s*\/\s*L|pg\s*\/\s*mL|pmol\s*\/\s*L|IU\s*\/\s*L|U\s*\/\s*L|fL|%|mmol\s*\/\s*mol)/iu,
  );
  return normalizeUnit(match?.[0] ?? null);
}

export function groupObservationsIntoRows(
  observations: readonly VisionTextObservation[],
  options: {
    readonly locale?: string;
    readonly collectionDate?: LabDateState;
    readonly collectionDateContexts?: readonly ExtractionDateContext[];
    readonly specimenType?: SpecimenType;
    readonly aliases?: readonly ExtractionAliasEntry[];
  } = {},
): readonly ExtractionDraftRow[] {
  const aliases = options.aliases ?? [];
  const sorted = [...observations]
    .filter((observation) => observation.text.trim())
    .sort(
      (a, b) =>
        a.pageIndex - b.pageIndex ||
        a.boundingBox.y + a.boundingBox.height / 2 - (b.boundingBox.y + b.boundingBox.height / 2) ||
        a.boundingBox.x - b.boundingBox.x,
    );
  const tableGroups = new Map<string, VisionTextObservation[]>();
  const loose: VisionTextObservation[] = [];
  for (const observation of sorted) {
    const structure = observation.structure ?? {
      kind: 'text' as const,
      tableId: null,
      rowIndex: null,
    };
    if (
      structure.kind === 'table-cell' &&
      structure.tableId !== null &&
      structure.rowIndex !== null
    ) {
      const key = `${observation.pageIndex}:${structure.tableId}:${structure.rowIndex}`;
      const group = tableGroups.get(key) ?? [];
      group.push(observation);
      tableGroups.set(key, group);
    } else loose.push(observation);
  }
  const groups: VisionTextObservation[][] = [...tableGroups.values()];
  for (const observation of loose) {
    const center = observation.boundingBox.y + observation.boundingBox.height / 2;
    const prior = groups.at(-1);
    const priorObservation = prior?.[0];
    const priorCenter =
      priorObservation === undefined
        ? null
        : priorObservation.boundingBox.y + priorObservation.boundingBox.height / 2;
    if (
      prior !== undefined &&
      priorObservation?.pageIndex === observation.pageIndex &&
      priorCenter !== null &&
      Math.abs(center - priorCenter) <=
        Math.max(observation.boundingBox.height, priorObservation.boundingBox.height) * 0.75
    )
      prior.push(observation);
    else groups.push([observation]);
  }
  return groups
    .map((group) => group.sort((a, b) => a.boundingBox.x - b.boundingBox.x))
    .sort(
      (a, b) =>
        (a[0]?.pageIndex ?? 0) - (b[0]?.pageIndex ?? 0) ||
        (a[0]?.boundingBox.y ?? 0) - (b[0]?.boundingBox.y ?? 0),
    )
    .map((group, order) =>
      parseSourceRow(
        group,
        order,
        options.locale ?? 'en-US',
        options.collectionDate ?? { kind: 'missing' },
        options.collectionDateContexts ?? [],
        options.specimenType ?? 'unknown',
        aliases,
      ),
    )
    .filter(isMeasurementShapedRow);
}

function isMeasurementShapedRow(row: ExtractionDraftRow): boolean {
  if (row.sourceLabel.trim().length < 2) return false;
  if (row.proposedBiomarkerId !== null && /\d/u.test(row.sourceText)) return true;
  if (row.sourceValueString.length === 0 || row.sourceValue.kind === 'free_text') return false;
  // Unknown biomarkers are useful only when the row has laboratory shape. A numeric token in a
  // phone number, address, licence, or footer is not enough to create review work.
  return (
    row.sourceValue.kind === 'categorical' ||
    row.proposedBiomarkerId !== null ||
    row.sourceUnit !== null ||
    row.sourceReferenceInterval !== null
  );
}

function parseSourceRow(
  group: readonly VisionTextObservation[],
  order: number,
  locale: string,
  collectionDate: LabDateState,
  collectionDateContexts: readonly ExtractionDateContext[],
  specimenType: SpecimenType,
  aliases: readonly ExtractionAliasEntry[],
): ExtractionDraftRow {
  const sourceText = group.map((observation) => observation.text.trim()).join('  ');
  const first = group[0];
  const firstBox = first?.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const source = {
    pageIndex: first?.pageIndex ?? 0,
    orientation: first?.orientation ?? 0,
    observationIds: group.map((item) => item.id),
    boundingBox: group.slice(1).reduce(
      (box, item) => ({
        x: Math.min(box.x, item.boundingBox.x),
        y: Math.min(box.y, item.boundingBox.y),
        width:
          Math.max(box.x + box.width, item.boundingBox.x + item.boundingBox.width) -
          Math.min(box.x, item.boundingBox.x),
        height:
          Math.max(box.y + box.height, item.boundingBox.y + item.boundingBox.height) -
          Math.min(box.y, item.boundingBox.y),
      }),
      { ...firstBox },
    ),
  };
  const aliasMatch = findAliasInText(sourceText, aliases);
  const numericCandidates = [...sourceText.matchAll(new RegExp(NUMERIC_TOKEN_PATTERN, 'gu'))]
    .map((match) => {
      const raw = match[0].trim();
      const start = (match.index ?? 0) + match[0].indexOf(raw);
      return {
        raw,
        start,
        end: start + raw.length,
        value: parseComparatorValue(raw),
      };
    })
    .filter((candidate) => {
      const before = sourceText[candidate.start - 1] ?? '';
      const after = sourceText[candidate.end] ?? '';
      const afterAfter = sourceText[candidate.end + 1] ?? '';
      return (
        !/[\p{L}\p{N}]/u.test(before) &&
        !/[\p{L}\p{N}]/u.test(after) &&
        !(after === '-' && /[\p{L}]/u.test(afterAfter))
      );
    });
  const referenceCandidates = [
    ...sourceText.matchAll(
      new RegExp(
        `(?:[<>≤≥]\\s*${PLAIN_NUMERIC_TOKEN_PATTERN}|${PLAIN_NUMERIC_TOKEN_PATTERN}\\s*(?:-|–|—|to)\\s*[<>≤≥]?\\s*${PLAIN_NUMERIC_TOKEN_PATTERN})`,
        'giu',
      ),
    ),
  ].map((match) => ({
    raw: match[0].trim(),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const rangeReferences = referenceCandidates.filter(
    (reference) => !/^[<>≤≥]/u.test(reference.raw),
  );
  const overlapsRangeReference = (candidate: { start: number; end: number }) =>
    rangeReferences.some(
      (reference) => candidate.start < reference.end && candidate.end > reference.start,
    );
  const numericOutsideRange = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'numeric' && !overlapsRangeReference(candidate),
  );
  const isReference = (candidate: {
    start: number;
    end: number;
    value?: MeasurementValue | null;
  }) =>
    referenceCandidates.some(
      (reference) =>
        candidate.start < reference.end &&
        candidate.end > reference.start &&
        (!/^[<>≤≥]/u.test(reference.raw) || numericOutsideRange.length > 0),
    );
  const scalarCandidates = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'numeric' && !isReference(candidate),
  );
  const boundedCandidates = numericCandidates.filter(
    (candidate) => candidate.value?.kind === 'bounded' && !isReference(candidate),
  );
  const valueCandidates = scalarCandidates.length > 0 ? scalarCandidates : boundedCandidates;
  const selectedValue = valueCandidates.length === 1 ? valueCandidates[0] : undefined;
  const categoricalMatch =
    selectedValue === undefined
      ? /\b(not detected|positive|negative|detected|normal|abnormal|teigiamas|neigiamas|aptikta|neaptikta|positiv|negativ)\s*$/iu.exec(
          sourceText,
        )
      : null;
  const rawValue = selectedValue?.raw ?? categoricalMatch?.[1] ?? '';
  const valueStart = selectedValue?.start ?? categoricalMatch?.index ?? -1;
  const rawLabel = valueStart > 0 ? sourceText.slice(0, valueStart).trim() : sourceText;
  const proposedValue =
    categoricalMatch !== null
      ? { kind: 'categorical' as const, value: rawValue }
      : (parseComparatorValue(rawValue) ?? { kind: 'free_text' as const, value: sourceText });
  const unit = findUnitInText(sourceText);
  const effectiveReferences = referenceCandidates.filter(
    (reference) => !/^[<>≤≥]/u.test(reference.raw) || numericOutsideRange.length > 0,
  );
  const referenceCandidate = effectiveReferences[0]?.raw ?? null;
  const reference = parseReferenceInterval(referenceCandidate);
  const flagCandidate =
    sourceText.match(/(?:^|\s)(high|low|normal|abnormal|h|l|n)(?=\s|$)/iu)?.[1] ?? null;
  const label = aliasMatch?.text ?? (rawLabel.trim() || sourceText);
  const biomarkerId = aliasMatch?.id ?? proposeBiomarkerId(label, aliases);
  const reasons: ExtractionReviewReason[] = [];
  if (!label) reasons.push('missing-label');
  if (!rawValue) reasons.push('missing-value');
  if (proposedValue.kind === 'free_text') reasons.push('unparseable-value');
  if (valueCandidates.length > 1 || effectiveReferences.length > 1)
    reasons.push('unsupported-layout');
  if (biomarkerId === null) reasons.push('unsupported-alias');
  if (!unitCompatible(unit, biomarkerId, aliases)) reasons.push('incompatible-unit');
  if (!specimenCompatible(specimenType, biomarkerId, aliases))
    reasons.push('incompatible-specimen');
  if (referenceCandidate !== null && reference === null)
    reasons.push('unparseable-reference-interval');
  const rowCenterY =
    group.reduce((sum, item) => sum + item.boundingBox.y + item.boundingBox.height / 2, 0) /
    Math.max(1, group.length);
  const nearestDateContext = collectionDateContexts
    .filter((candidate) => candidate.pageIndex === source.pageIndex)
    .sort((a, b) => Math.abs(a.centerY - rowCenterY) - Math.abs(b.centerY - rowCenterY))[0];
  const effectiveDate = nearestDateContext?.collectionDate ?? collectionDate;
  if (effectiveDate.kind === 'missing') reasons.push('missing-collection-date');
  if (nearestDateContext?.ambiguous) reasons.push('ambiguous-date');
  return {
    id: first?.id ?? `row-${order}`,
    order,
    panelLabel: null,
    sourceText,
    sourceLabel: label,
    sourceValue: proposedValue,
    sourceValueString: rawValue || sourceText,
    sourceUnit: unit,
    sourceReferenceInterval: reference,
    sourceFlag: flagCandidate,
    source,
    collectionDateContext: nearestDateContext ?? null,
    proposedLabel: label,
    proposedValue,
    proposedUnit: unit,
    proposedReferenceInterval: reference,
    proposedFlag: flagCandidate,
    proposedBiomarkerId: biomarkerId,
    proposedSpecimenType: specimenType,
    collectionDate: effectiveDate,
    reviewReasons: [...new Set(reasons)],
    reviewState: reasons.length === 0 ? 'ready' : 'needs-review',
    decision: 'unresolved',
  };
}

export function revalidateExtractionRow(
  row: ExtractionDraftRow,
  patch: ExtractionDraftRowPatch,
  aliases: readonly ExtractionAliasEntry[],
): ExtractionDraftRow {
  const next = { ...row, ...patch, source: row.source, sourceValue: row.sourceValue };
  const reasons = new Set<ExtractionReviewReason>();
  if (!next.proposedLabel.trim()) reasons.add('missing-label');
  if (!next.sourceValueString.trim()) reasons.add('missing-value');
  if (next.proposedValue.kind === 'free_text' && !next.proposedValue.value.trim())
    reasons.add('unparseable-value');
  const id = next.proposedBiomarkerId;
  if (id === null) reasons.add('unsupported-alias');
  if (!unitCompatible(next.proposedUnit, id, aliases)) reasons.add('incompatible-unit');
  if (!specimenCompatible(next.proposedSpecimenType, id, aliases))
    reasons.add('incompatible-specimen');
  if (next.collectionDate.kind === 'missing') reasons.add('missing-collection-date');
  if (next.collectionDateContext?.ambiguous) reasons.add('ambiguous-date');
  if (next.proposedReferenceInterval !== null && next.proposedReferenceInterval !== '') {
    if (parseReferenceInterval(next.proposedReferenceInterval) === null)
      reasons.add('unparseable-reference-interval');
  }
  return {
    ...next,
    reviewReasons: [...reasons],
    reviewState: reasons.size === 0 ? 'ready' : 'needs-review',
    decision:
      patch.decision ??
      (patch.proposedLabel !== undefined || patch.proposedValue !== undefined
        ? 'unresolved'
        : row.decision),
  };
}

export function buildExtractionConfirmationPlan(
  draft: ExtractionDraft,
  ids: {
    readonly record: (key: string) => string;
    readonly measurement: (rowId: string) => string;
  },
): ExtractionConfirmationPlan {
  if (draft.state !== 'draft') throw new Error('Extraction Draft has already been confirmed');
  type PlannedRecord = {
    id: string;
    collectionDate: LabDateState;
    specimenType: SpecimenType;
    measurements: Array<ExtractionConfirmationPlan['records'][number]['measurements'][number]>;
  };
  const groups = new Map<string, PlannedRecord>();
  for (const row of draft.rows) {
    if (row.decision === 'unresolved') throw new Error('Every extraction row requires a decision');
    if (row.decision === 'skip') continue;
    const key = `${row.collectionDate.kind === 'known' ? row.collectionDate.value : 'missing'}|${row.proposedSpecimenType}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        id: ids.record(key),
        collectionDate: row.collectionDate,
        specimenType: row.proposedSpecimenType,
        measurements: [],
      };
      groups.set(key, group);
    }
    group.measurements.push({
      id: ids.measurement(row.id),
      biomarkerId: row.proposedBiomarkerId,
      label: row.proposedLabel.trim() || row.sourceLabel,
      value: row.proposedValue,
      valueString:
        row.proposedValue.kind === 'numeric'
          ? String(row.proposedValue.value)
          : row.proposedValue.kind === 'bounded'
            ? `${row.proposedValue.comparator}${row.proposedValue.value}`
            : row.proposedValue.value,
      unit: row.proposedUnit,
      referenceInterval: row.proposedReferenceInterval,
      flag: row.proposedFlag,
      source: row.source,
      original: {
        label: row.sourceLabel,
        value: row.sourceValue,
        valueString: row.sourceValueString,
        unit: row.sourceUnit,
        referenceInterval: row.sourceReferenceInterval,
        flag: row.sourceFlag,
      },
      sourceRowId: row.id,
      reviewState:
        row.decision === 'resolve' && row.reviewState === 'ready' ? 'confirmed' : 'needs-review',
      provenance:
        row.decision === 'resolve' &&
        (row.proposedLabel !== row.sourceLabel ||
          JSON.stringify(row.proposedValue) !== JSON.stringify(row.sourceValue) ||
          row.proposedUnit !== row.sourceUnit ||
          row.proposedReferenceInterval !== row.sourceReferenceInterval ||
          row.proposedFlag !== row.sourceFlag)
          ? 'user-corrected'
          : 'extracted',
    });
  }
  return { draftId: draft.id, reportId: draft.reportId, records: [...groups.values()] };
}
