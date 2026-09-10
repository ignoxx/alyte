/**
 * Evaluation-only NuExtract 2.0 field-string adapter.
 *
 * NuExtract receives a template followed by the complete page text and returns source strings.
 * The strings are untrusted proposals; the shared native grounder must resolve them before a
 * measurement is produced.
 */
import type { TextFieldProposal } from './text-field-proposals';

export const NUEXTRACT_PROMPT_VERSION = 'nuextract-2.0-laboratory-results.v1' as const;
export const NUEXTRACT_MODEL_ID = 'nuextract-2.0-2b-q4_k_m' as const;
export const NUEXTRACT_MODEL_SHA256 =
  '4725ac4d8437b8657005de6c5fb2de8dea186e654e9331a092f1c1146bc9582e' as const;
export const NUEXTRACT_DEFAULT_MODEL_PATH =
  '/private/tmp/alyte-import-models/NuExtract-2.0-2B-Q4_K_M.gguf' as const;

/** The official NuExtract template uses verbatim-string placeholders for each extracted field. */
export const NUEXTRACT_LABORATORY_SCHEMA = {
  laboratory_results: [
    {
      test_name: 'verbatim-string',
      current_result: 'verbatim-string',
      unit: 'verbatim-string',
      reference_interval: 'verbatim-string',
      flag: 'verbatim-string',
    },
  ],
} as const;

export const NUEXTRACT_PROMPT_PREFIX = `# Template:\n${JSON.stringify(NUEXTRACT_LABORATORY_SCHEMA, null, 4)}\n`;

export type NuExtractProposalDecode = {
  readonly proposals: readonly TextFieldProposal[];
  readonly valid: boolean;
  readonly droppedIncompleteRows: number;
};

function jsonObjects(raw: string): readonly Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
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
            const value: unknown = JSON.parse(raw.slice(start, index + 1));
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
              objects.push(value as Record<string, unknown>);
            }
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

function isPlaceholder(value: string): boolean {
  return value.trim() === 'verbatim-string';
}

type OptionalFieldResult =
  | { readonly kind: 'ok'; readonly value: string | null }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'placeholder' };

function optionalField(row: Record<string, unknown>, key: string): OptionalFieldResult {
  const value = row[key];
  if (value === null || value === undefined || value === '') return { kind: 'ok', value: null };
  if (typeof value !== 'string') return { kind: 'malformed' };
  if (isPlaceholder(value)) return { kind: 'placeholder' };
  return { kind: 'ok', value };
}

type RowDecode =
  | { readonly kind: 'proposal'; readonly proposal: TextFieldProposal }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'malformed' };

function buildProposal(row: Record<string, unknown>): RowDecode {
  const label = row.test_name;
  const value = row.current_result;
  if (label === null || label === undefined || value === null || value === undefined)
    return { kind: 'dropped' };
  if (typeof label !== 'string' || typeof value !== 'string') return { kind: 'malformed' };
  if (label.trim().length === 0 || value.trim().length === 0) return { kind: 'dropped' };
  if (isPlaceholder(label) || isPlaceholder(value)) return { kind: 'dropped' };
  const unit = optionalField(row, 'unit');
  const reference = optionalField(row, 'reference_interval');
  const flag = optionalField(row, 'flag');
  if (unit.kind === 'malformed' || reference.kind === 'malformed' || flag.kind === 'malformed') {
    return { kind: 'malformed' };
  }
  if (
    unit.kind === 'placeholder' ||
    reference.kind === 'placeholder' ||
    flag.kind === 'placeholder'
  ) {
    return { kind: 'dropped' };
  }
  return {
    kind: 'proposal',
    proposal: {
      label,
      value,
      rawValue: value,
      unit: unit.value,
      reference: reference.value,
      flag: flag.value,
    },
  };
}

/**
 * Build the exact NuExtract template prompt. The page text follows the schema immediately; no
 * candidate catalogue, expected result, or report-specific instruction is inserted.
 */
export function buildNuExtractPrompt(pageText: string): string {
  return `${NUEXTRACT_PROMPT_PREFIX}${pageText}`;
}

/**
 * Decode the final laboratory_results object from untrusted CLI output.
 *
 * Searching the last matching object avoids treating a CLI-echoed template as model output. A
 * template-only echo is explicitly invalid rather than becoming a fabricated verbatim row.
 */
export function decodeNuExtractProposals(raw: string): NuExtractProposalDecode {
  const candidates = jsonObjects(raw).filter((candidate) =>
    Array.isArray(candidate.laboratory_results),
  );
  const candidate = candidates.at(-1);
  if (candidate === undefined) return { proposals: [], valid: false, droppedIncompleteRows: 0 };
  const rows = candidate.laboratory_results;
  if (!Array.isArray(rows)) return { proposals: [], valid: false, droppedIncompleteRows: 0 };
  if (rows.length === 0) return { proposals: [], valid: true, droppedIncompleteRows: 0 };
  const proposals: TextFieldProposal[] = [];
  let droppedIncompleteRows = 0;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return { proposals: [], valid: false, droppedIncompleteRows };
    }
    const proposal = buildProposal(row as Record<string, unknown>);
    if (proposal.kind === 'malformed') {
      return { proposals: [], valid: false, droppedIncompleteRows };
    }
    if (proposal.kind === 'dropped') {
      droppedIncompleteRows += 1;
      continue;
    }
    proposals.push(proposal.proposal);
  }
  const placeholderEcho =
    proposals.length === 0 &&
    rows.some(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        Object.values(row as Record<string, unknown>).some(
          (value) => typeof value === 'string' && isPlaceholder(value),
        ),
    );
  return { proposals, valid: !placeholderEcho, droppedIncompleteRows };
}
