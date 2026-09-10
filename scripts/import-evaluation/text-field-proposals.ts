/**
 * Synthetic-only Qwen field-string proposal experiment.
 *
 * The model proposes source strings. The current main grounder resolves those strings against
 * native observations before a measurement is produced; model text is never authoritative.
 */
import { groundVisionProposals, type VisionObservation, type VisionPage } from './qwen35-grounding';
import { fileURLToPath } from 'node:url';
import type { EvaluationMeasurement } from './contract';

export const TEXT_FIELD_PROPOSALS_PROMPT_VERSION = 'text-field-proposals.v1' as const;
export const TEXT_FIELD_PROPOSALS_MAIN_GROUNDER = fileURLToPath(
  new URL('./qwen35-grounding.ts', import.meta.url),
);
export const TEXT_FIELD_PROPOSALS_USER_PROMPT =
  'Use the system table and return the requested field-string rows now.' as const;

export type TextFieldProposal = {
  readonly label: string;
  readonly value: string;
  /** Untrusted model spelling/value before the string used for grounding. */
  readonly rawValue: string | number;
  readonly unit: string | null;
  readonly reference: string | null;
  readonly flag: string | null;
};

export type FieldProposalDecode = {
  readonly proposals: readonly TextFieldProposal[];
  readonly valid: boolean;
};

function center(observation: VisionObservation, axis: 'x' | 'y'): number {
  const box = observation.boundingBox;
  if (box === undefined) return 2;
  return axis === 'x' ? box.x + box.width / 2 : box.y + box.height / 2;
}

function inventory(page: VisionPage): string {
  const ordered = page.observations
    .map((observation) => ({
      observation,
      x: center(observation, 'x'),
      y: center(observation, 'y'),
    }))
    .toSorted((left, right) => left.y - right.y || left.x - right.x);
  let row = 0;
  let previousY: number | null = null;
  return ordered
    .map(({ observation, y }) => {
      if (previousY !== null && y - previousY > 0.008) row += 1;
      previousY = y;
      return `r${row}|y${Math.round(y * 1000)}|x${Math.round(center(observation, 'x') * 1000)}|${JSON.stringify(observation.text.trim())}`;
    })
    .join('\n');
}

export function buildTextFieldProposalPrompt(page: VisionPage): string {
  return [
    'Task: read the current laboratory table and propose one object for each clear measurement row.',
    'Return exactly one JSON object and no Markdown or explanation.',
    'Schema: {"rows":[{"label":"source label text","value":"result token only","unit":null,"reference":null,"flag":null}]}',
    'Every row must contain all five keys. label, value, unit, reference, and flag are source field strings; optional fields may be null.',
    'The value field is the result token alone, without its unit. For example, use value "5.2" and unit "mmol/L", never value "5.2 mmol/L".',
    'Copy source spelling exactly, including decimal separators and case. Do not invent text, convert units, or combine different rows.',
    'Select numeric, comparator, bounded, categorical, status, and unknown-label results from the current Result column. Exclude headers, Previous/Prior Result, reference prose, demographics, and administrative text.',
    'Unrelated example (do not copy): input r8|y400|x100|"Sodium" and r8|y400|x800|"140"; output {"rows":[{"label":"Sodium","value":"140","unit":null,"reference":null,"flag":null}]}',
    `PAGE ${page.pageIndex + 1}. Each line is rROW|yY|xX|one native table cell; equal rROW means one physical row. The x values identify label, current-result, and unit columns.\n${inventory(page)}`,
    'Return the JSON object now. If no row is clear, return {"rows":[]}.',
  ].join('\n');
}

function jsonObjects(raw: string): readonly unknown[] {
  const objects: unknown[] = [];
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            objects.push(JSON.parse(raw.slice(start, index + 1)) as unknown);
          } catch {
            // Model output is untrusted and may contain partial JSON.
          }
          break;
        }
      }
    }
  }
  return objects;
}

function jsonArrays(raw: string): readonly unknown[] {
  const arrays: unknown[] = [];
  for (let start = raw.indexOf('['); start >= 0; start = raw.indexOf('[', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === '[') depth += 1;
      else if (character === ']') {
        depth -= 1;
        if (depth === 0) {
          try {
            arrays.push(JSON.parse(raw.slice(start, index + 1)) as unknown);
          } catch {
            // Model output is untrusted and may contain partial JSON.
          }
          break;
        }
      }
    }
  }
  return arrays;
}

function assistantResponse(raw: string): string {
  const marker = `> ${TEXT_FIELD_PROPOSALS_USER_PROMPT}`;
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex >= 0) return raw.slice(markerIndex + marker.length);
  const assistant = /(?:^|\n)\s*assistant\s+(?=\{|\[)/iu.exec(raw);
  if (assistant !== null) return raw.slice((assistant.index ?? 0) + assistant[0].length);
  const cliPrompt = /(?:^|\n)>\s/gu;
  const promptMatches = [...raw.matchAll(cliPrompt)];
  if (promptMatches.length > 0) {
    const match = promptMatches[promptMatches.length - 1];
    return raw.slice((match?.index ?? 0) + (match?.[0].length ?? 0));
  }
  const trimmed = raw.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : '';
}

export function decodeTextFieldProposals(raw: string): FieldProposalDecode {
  const response = assistantResponse(raw);
  const objectRows = [...jsonObjects(response)]
    .reverse()
    .find(
      (item): item is { readonly rows: unknown[] } =>
        item !== null &&
        typeof item === 'object' &&
        Array.isArray((item as { readonly rows?: unknown }).rows),
    );
  const arrayRows = [...jsonArrays(response)]
    .reverse()
    .find(
      (item): item is readonly unknown[] =>
        Array.isArray(item) &&
        (item.length === 0 ||
          item.every(
            (row) =>
              row !== null &&
              typeof row === 'object' &&
              typeof (row as { label?: unknown }).label === 'string' &&
              (typeof (row as { value?: unknown }).value === 'string' ||
                (typeof (row as { value?: unknown }).value === 'number' &&
                  Number.isFinite((row as { value: number }).value))),
          )),
    );
  const rows = objectRows?.rows ?? arrayRows;
  if (rows === undefined) return { proposals: [], valid: false };
  const proposals = rows.flatMap((item): TextFieldProposal[] => {
    if (item === null || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.label !== 'string' || row.label.trim().length === 0) return [];
    const rawValue = row.value;
    const value =
      typeof row.value === 'string'
        ? row.value.trim()
        : typeof row.value === 'number' && Number.isFinite(row.value)
          ? String(row.value)
          : '';
    if (value.length === 0) return [];
    const nullableString = (key: string): string | null | undefined => {
      const field = row[key];
      if (field === undefined || field === null) return null;
      if (typeof field !== 'string' || field.trim().length === 0) return undefined;
      return field.trim();
    };
    const unit = nullableString('unit');
    const reference = nullableString('reference');
    const flag = nullableString('flag');
    if (unit === undefined || reference === undefined || flag === undefined) return [];
    return [
      {
        label: row.label.trim(),
        value,
        rawValue: rawValue as string | number,
        unit,
        reference,
        flag,
      },
    ];
  });
  return { proposals, valid: true };
}

function toMeasurement(proposal: TextFieldProposal, page: VisionPage): EvaluationMeasurement {
  return {
    id: `text-field-proposal-p${page.pageIndex + 1}-${proposal.label}-${proposal.value}`,
    sourceLabel: proposal.label,
    valueString: proposal.value,
    valueType: 'unknown',
    parsedValue: null,
    comparator: null,
    unit: proposal.unit,
    referenceInterval: proposal.reference,
    flag: proposal.flag,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: page.pageIndex + 1,
    location: null,
    ambiguousFields: ['collectionDate', 'specimen', 'canonicalBiomarkerId'],
    canonicalBiomarkerId: null,
    trendEligible: null,
    unresolvedFields: ['collectionDate', 'specimen', 'canonicalBiomarkerId'],
    sourceIds: [],
  };
}

export function groundTextFieldProposals(
  proposals: readonly TextFieldProposal[],
  page: VisionPage,
): ReturnType<typeof groundVisionProposals> {
  return groundVisionProposals(
    proposals.map((proposal) => toMeasurement(proposal, page)),
    [page],
  );
}
