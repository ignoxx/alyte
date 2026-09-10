import { parseLabDate, type ExtractionDateContext, type VisionTextObservation } from './extraction';
import type { LabDateState } from './labs';

/** The Vision fields needed for conservative date-context extraction, plus the adapter locale. */
export type OCRDateContextObservation = Pick<
  VisionTextObservation,
  'id' | 'text' | 'boundingBox' | 'pageIndex' | 'structure'
> & {
  readonly locale: string | null;
};

export type OCRDateContextResult = {
  readonly contexts: readonly ExtractionDateContext[];
  readonly excludedObservationIds: ReadonlySet<string>;
  readonly collectionDate: LabDateState;
};

type DateToken = {
  readonly observation: OCRDateContextObservation;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly centerY: number;
  readonly centerX: number;
  readonly scopeKey: string;
};

type DateLabel = {
  readonly observation: OCRDateContextObservation;
  readonly context: 'collection' | 'non-collection';
  readonly start: number;
  readonly end: number;
  readonly centerX: number;
};

type DateAssociation = {
  readonly kind: 'collection' | 'non-collection' | 'ambiguous' | 'missing';
  readonly neighbors: readonly OCRDateContextObservation[];
  readonly label: DateLabel | null;
  readonly scopeKey: string;
};

type VisualRow = {
  readonly pageIndex: number;
  readonly observations: OCRDateContextObservation[];
  /** The first observation anchors this row; it must not drift as more observations arrive. */
  readonly anchorCenterY: number;
  readonly anchorHeight: number;
};

const collectionDateLabelPattern =
  /\b(?:date of collection|collection|collected|sample|specimen|abnahme|entnahme|proben(?:entnahme)?|prélèvement|prelevement|muestra|toma de muestra|prelievo|campione|colheita|amostra|afname|monster|pobranie|próbka|paėmimo data|mėgin(?:ys|io data)|ėminys|paimta)\b/giu;
const nonCollectionDateLabelPattern =
  /\b(?:date of birth|date reported|report date|reported|report|issued|birth|dob|ausgestellt|geburt|naissance|nacimiento|nascita|nascimento|geboorte|urodzenia|wydania|ataskaitos data|išdavimo data|gimimo data)\b/giu;
const writtenMonthPattern =
  'jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|maerz|apr(?:il)?|may|mai|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?';
const dateTokenPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,-])(?:\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}\.?\s+(?:${writtenMonthPattern})\s+\d{4}|(?:${writtenMonthPattern})\s+\d{1,2},?\s+\d{4})(?![\p{L}\p{N}.,-])`,
  'giu',
);

/**
 * Extract only explicitly labelled collection dates from OCR observations.
 *
 * This stays pure and conservative: OCR text is never normalized or rewritten, separate
 * horizontal/table scopes cannot conflict with each other, and equal collection/non-collection
 * ties remain ambiguous instead of being resolved by layout guesswork.
 */
export function extractOCRDateContexts(
  input: readonly OCRDateContextObservation[],
): OCRDateContextResult {
  const observations = [
    ...new Map(input.map((observation) => [observation.id, observation] as const)).values(),
  ];
  const rows = visualRows(observations);
  const rowByObservationId = new Map<string, number>();
  rows.forEach((row, index) =>
    row.observations.forEach((observation) => rowByObservationId.set(observation.id, index)),
  );
  const scopeByObservationId = new Map<string, string>();
  rows.forEach((row, rowIndex) => {
    const horizontalGroups = horizontalObservationGroups(row.observations);
    horizontalGroups.forEach((group, groupIndex) => {
      group.forEach((observation) => {
        const structure = observation.structure;
        const scope =
          structure?.kind === 'table-cell' && structure.tableId !== null
            ? `page:${observation.pageIndex}:table:${structure.tableId}:row:${structure.rowIndex ?? rowIndex}`
            : `page:${observation.pageIndex}:row:${rowIndex}:column:${groupIndex}`;
        scopeByObservationId.set(observation.id, scope);
      });
    });
  });

  const dateCandidates = observations.flatMap((observation) =>
    dateTokens(
      observation,
      scopeByObservationId.get(observation.id) ?? `observation:${observation.id}`,
    ),
  );
  const associations = dateCandidates.map((token) => ({
    token,
    association: associateDate(token, observations, rowByObservationId, scopeByObservationId),
  }));
  const excludedObservationIds = new Set<string>();
  for (const { token, association } of associations) {
    if (association.kind === 'missing') continue;

    // Date context is metadata cleanup. Exclude only pure date/header observations so a mixed
    // OCR parent that also contains a measurement remains available to source parsing.
    if (isPureDateObservation(token.observation)) excludedObservationIds.add(token.observation.id);
    if (association.label !== null && isPureDateObservation(association.label.observation))
      excludedObservationIds.add(association.label.observation.id);
  }

  const collectionCandidates = associations.filter(
    ({ association }) => association.kind === 'collection' || association.kind === 'ambiguous',
  );
  const contexts: ExtractionDateContext[] = collectionCandidates.map(({ token, association }) => {
    // A date-only OCR cell often has no language attribution even when its adjacent label does.
    // The explicitly associated collection label is safe locale context; the phone locale is not.
    const contextLocale = token.observation.locale ?? association.label?.observation.locale ?? null;
    const localeAmbiguous = dateIsAmbiguous(token.raw, contextLocale);
    const parsed = localeAmbiguous ? null : parseContextDate(token.raw, contextLocale ?? 'en-US');
    const sameScope = collectionCandidates.filter(
      (candidate) => candidate.association.scopeKey === association.scopeKey,
    );
    const distinctDates = new Set(
      sameScope.map(({ token: candidateToken, association: candidateAssociation }) => {
        if (candidateAssociation.kind === 'ambiguous') return 'ambiguous';
        const candidateLocale =
          candidateToken.observation.locale ??
          candidateAssociation.label?.observation.locale ??
          null;
        const candidateDate = dateIsAmbiguous(candidateToken.raw, candidateLocale)
          ? null
          : parseContextDate(candidateToken.raw, candidateLocale ?? 'en-US');
        return candidateDate?.kind === 'known' ? candidateDate.value : 'invalid';
      }),
    );
    const hasConflict =
      distinctDates.has('ambiguous') || distinctDates.has('invalid') || distinctDates.size > 1;
    const ambiguous =
      association.kind === 'ambiguous' || localeAmbiguous || parsed === null || hasConflict;
    return {
      observationId: token.observation.id,
      pageIndex: token.observation.pageIndex,
      centerY: token.centerY,
      centerX: token.centerX,
      scopeKey: association.scopeKey,
      locale: contextLocale,
      context: 'collection',
      ambiguous,
      collectionDate: ambiguous ? { kind: 'missing' } : (parsed ?? { kind: 'missing' }),
      sourceText: token.observation.text,
      sourceDate: token.raw,
      ...(association.label === null
        ? {}
        : {
            labelObservationId: association.label.observation.id,
            labelText: association.label.observation.text,
          }),
    };
  });
  const known = contexts.filter((context) => context.collectionDate.kind === 'known');
  const collectionDate =
    contexts.length === 1 && known.length === 1
      ? (known[0]?.collectionDate ?? { kind: 'missing' })
      : { kind: 'missing' as const };
  return { contexts, excludedObservationIds, collectionDate };
}

function visualRows(observations: readonly OCRDateContextObservation[]): VisualRow[] {
  const rows: VisualRow[] = [];
  const sorted = [...observations].sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      centerY(left) - centerY(right) ||
      left.boundingBox.x - right.boundingBox.x,
  );
  for (const observation of sorted) {
    const center = centerY(observation);
    const prior = rows.at(-1);
    if (
      prior !== undefined &&
      prior.pageIndex === observation.pageIndex &&
      Math.abs(center - prior.anchorCenterY) <=
        Math.max(observation.boundingBox.height, prior.anchorHeight) * 1.5
    ) {
      prior.observations.push(observation);
    } else
      rows.push({
        pageIndex: observation.pageIndex,
        observations: [observation],
        anchorCenterY: center,
        anchorHeight: observation.boundingBox.height,
      });
  }
  return rows;
}

/**
 * Keep a source observation excluded only when it contains date metadata by itself. A parent
 * carrying other source text may still contain a credible measurement, so it remains parseable.
 */
function isPureDateObservation(observation: OCRDateContextObservation): boolean {
  const remainder = observation.text
    .replace(dateTokenPattern, '')
    .replace(collectionDateLabelPattern, '')
    .replace(nonCollectionDateLabelPattern, '')
    // These words are part of common split labels such as "Collection date" and "Date Collected".
    .replace(/\b(?:date|datum|data)\b/giu, '')
    // Times commonly accompany a collection date but are still date-header metadata.
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return remainder.length === 0;
}

function horizontalObservationGroups(
  observations: readonly OCRDateContextObservation[],
): OCRDateContextObservation[][] {
  const groups: OCRDateContextObservation[][] = [];
  const sorted = [...observations].sort((left, right) => left.boundingBox.x - right.boundingBox.x);
  for (const observation of sorted) {
    const priorGroup = groups.at(-1);
    const prior = priorGroup?.at(-1);
    const gap = prior === undefined ? 0 : horizontalGap(prior, observation);
    const threshold = Math.max(
      0.2,
      Math.max(
        prior?.boundingBox.height ?? observation.boundingBox.height,
        observation.boundingBox.height,
      ) * 8,
    );
    if (priorGroup === undefined) groups.push([observation]);
    else if (prior !== undefined && gap <= threshold) priorGroup.push(observation);
    else groups.push([observation]);
  }
  return groups;
}

function dateTokens(observation: OCRDateContextObservation, scopeKey: string): DateToken[] {
  const center = centerY(observation);
  return [...observation.text.matchAll(dateTokenPattern)].map((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return {
      observation,
      raw: match[0],
      start,
      end,
      centerY: center,
      centerX: textPosition(observation, start, end),
      scopeKey,
    };
  });
}

function associateDate(
  token: DateToken,
  observations: readonly OCRDateContextObservation[],
  rowByObservationId: ReadonlyMap<string, number>,
  scopeByObservationId: ReadonlyMap<string, string>,
): DateAssociation {
  const rowIndex = rowByObservationId.get(token.observation.id);
  const neighbors = observations.filter(
    (observation) =>
      observation.pageIndex === token.observation.pageIndex &&
      rowByObservationId.get(observation.id) === rowIndex &&
      scopeByObservationId.get(observation.id) === token.scopeKey,
  );
  const labels = neighbors.flatMap(dateLabels);
  if (labels.length === 0)
    return { kind: 'missing', neighbors: [], label: null, scopeKey: token.scopeKey };
  const lineTokens = observations
    .flatMap((observation) =>
      dateTokens(observation, scopeByObservationId.get(observation.id) ?? ''),
    )
    .filter((candidate) => candidate.scopeKey === token.scopeKey)
    .sort((left, right) => left.centerX - right.centerX);
  const orderedLabels = [...labels].sort((left, right) => left.centerX - right.centerX);
  const tokenIndex = lineTokens.findIndex(
    (candidate) =>
      candidate.observation.id === token.observation.id &&
      candidate.start === token.start &&
      candidate.end === token.end,
  );
  if (lineTokens.length > 1 && lineTokens.length === orderedLabels.length && tokenIndex >= 0) {
    const label = orderedLabels[tokenIndex];
    if (label !== undefined)
      return {
        kind: label.context,
        neighbors,
        label,
        scopeKey: scopeKeyForLabel(token, label, labels),
      };
  }
  const ranked = labels
    .map((label) => ({ label, distance: Math.abs(label.centerX - token.centerX) }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = ranked[0];
  if (nearest === undefined)
    return { kind: 'missing', neighbors: [], label: null, scopeKey: token.scopeKey };
  const tied = ranked.filter(
    (candidate) => Math.abs(candidate.distance - nearest.distance) <= 0.002,
  );
  const contexts = new Set(tied.map((candidate) => candidate.label.context));
  const kind =
    contexts.size !== 1
      ? 'ambiguous'
      : tied[0]?.label.context === 'collection'
        ? 'collection'
        : 'non-collection';
  return {
    kind,
    neighbors,
    label: kind === 'ambiguous' ? null : (tied[0]?.label ?? null),
    scopeKey:
      kind === 'ambiguous' || tied[0] === undefined
        ? token.scopeKey
        : scopeKeyForLabel(token, tied[0].label, labels),
  };
}

function scopeKeyForLabel(
  token: DateToken,
  label: DateLabel,
  labels: readonly DateLabel[],
): string {
  // Repeated labels inside one OCR cell are one unresolved header, while separately emitted
  // label cells provide a useful horizontal event boundary for split side-by-side panels.
  const repeatedSameObservation =
    label.observation.id === token.observation.id &&
    labels.filter(
      (candidate) =>
        candidate.observation.id === label.observation.id && candidate.context === 'collection',
    ).length > 1;
  return repeatedSameObservation
    ? token.scopeKey
    : `${token.scopeKey}:label:${label.observation.id}:${label.start}`;
}

function dateLabels(observation: OCRDateContextObservation): DateLabel[] {
  const labels: DateLabel[] = [];
  for (const match of observation.text.matchAll(collectionDateLabelPattern)) {
    const start = match.index ?? 0;
    labels.push({
      observation,
      context: 'collection',
      start,
      end: start + match[0].length,
      centerX: textPosition(observation, start, start + match[0].length),
    });
  }
  for (const match of observation.text.matchAll(nonCollectionDateLabelPattern)) {
    const start = match.index ?? 0;
    labels.push({
      observation,
      context: 'non-collection',
      start,
      end: start + match[0].length,
      centerX: textPosition(observation, start, start + match[0].length),
    });
  }
  return labels;
}

function textPosition(observation: OCRDateContextObservation, start: number, end: number): number {
  const fraction =
    observation.text.length === 0
      ? 0.5
      : (Math.max(0, start) + Math.min(observation.text.length, end)) / 2 / observation.text.length;
  return observation.boundingBox.x + observation.boundingBox.width * fraction;
}

function centerY(observation: OCRDateContextObservation): number {
  return observation.boundingBox.y + observation.boundingBox.height / 2;
}

function horizontalGap(left: OCRDateContextObservation, right: OCRDateContextObservation): number {
  return Math.max(
    0,
    Math.max(left.boundingBox.x, right.boundingBox.x) -
      Math.min(
        left.boundingBox.x + left.boundingBox.width,
        right.boundingBox.x + right.boundingBox.width,
      ),
  );
}

function dateIsAmbiguous(candidate: string, locale: string | null): boolean {
  const parts = candidate.split(/[./-]/u).map(Number);
  if (parts.length !== 3 || String(parts[0]).length === 4) return false;
  const numericOrderNeedsLocale = (parts[0] ?? 0) <= 12 && (parts[1] ?? 0) <= 12;
  // A source-attributed report language makes numeric order deterministic through parseLabDate.
  // Without that source context, keep 04/01-style dates visibly ambiguous.
  return numericOrderNeedsLocale && locale === null;
}

const monthNumbers: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  januar: 1,
  feb: 2,
  february: 2,
  februar: 2,
  mar: 3,
  march: 3,
  märz: 3,
  maerz: 3,
  apr: 4,
  april: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juni: 6,
  jul: 7,
  july: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  dez: 12,
  dezember: 12,
};

function parseContextDate(input: string, locale: string): LabDateState | null {
  const numeric = parseLabDate(input, locale);
  if (numeric !== null) return numeric;
  const normalized = input.trim().toLocaleLowerCase(locale).replace(/\s+/gu, ' ');
  const dayFirst = normalized.match(/^(\d{1,2})\.?\s+([\p{L}]+)\s+(\d{4})$/u);
  const monthFirst = normalized.match(/^([\p{L}]+)\s+(\d{1,2}),?\s+(\d{4})$/u);
  const parts = dayFirst ?? monthFirst;
  if (parts === null) return null;
  const monthName = dayFirst === null ? parts[1] : parts[2];
  const dayText = dayFirst === null ? parts[2] : parts[1];
  const yearText = parts[3];
  const month = monthNumbers[monthName ?? ''];
  const day = Number(dayText);
  const year = Number(yearText);
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(year)) return null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || day < 1 || day > days) return null;
  return {
    kind: 'known',
    value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}
