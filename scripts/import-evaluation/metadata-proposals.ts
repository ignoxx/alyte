export type MetadataDateState =
  { readonly kind: 'known'; readonly value: string } | { readonly kind: 'missing' };

export type MetadataBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type MetadataSpan = {
  readonly id?: string;
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly boundingBox?: MetadataBoundingBox;
};

export type MetadataStructure = {
  readonly kind?: string;
  readonly tableId?: string | null;
  readonly rowIndex?: number | null;
  readonly columnIndex?: number | null;
};

/** Native observations accepted from the PDFKit, Vision, or Poppler evaluation readers. */
export type MetadataObservation = {
  readonly id: string;
  readonly text: string;
  readonly pageIndex: number;
  readonly boundingBox: MetadataBoundingBox;
  readonly locale?: string | null;
  readonly structure?: MetadataStructure;
  readonly spans?: readonly MetadataSpan[];
};

export type MetadataSourceRef = {
  readonly observationId: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly boundingBox: MetadataBoundingBox | null;
};

export type MetadataScope =
  | { readonly kind: 'page'; readonly key: string }
  | { readonly kind: 'table-row'; readonly key: string }
  | { readonly kind: 'visual-row'; readonly key: string };

export type CollectionDateProposalReason =
  | 'accepted'
  | 'ambiguous-date-locale'
  | 'invalid-date'
  | 'non-collection-date'
  | 'no-explicit-collection-label'
  | 'ambiguous-label-pairing'
  | 'multiple-page-date-pairs';

export type CollectionDateProposal = {
  readonly id: string;
  readonly pageIndex: number;
  readonly scope: MetadataScope;
  readonly state: MetadataDateState;
  readonly rawDate: MetadataSourceRef;
  readonly collectionLabel: MetadataSourceRef | null;
  readonly reason: CollectionDateProposalReason;
};

export type PageCollectionDateContext = {
  readonly pageIndex: number;
  readonly state: MetadataDateState;
  readonly proposalIds: readonly string[];
  readonly reason: 'unique-page-date-pair' | 'ambiguous-page-date-pairs' | 'no-page-date-pair';
};

export type CollectionDateMetadataResult = {
  readonly proposals: readonly CollectionDateProposal[];
  readonly pageContexts: readonly PageCollectionDateContext[];
};

type DateToken = {
  readonly observation: MetadataObservation;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly boundingBox: MetadataBoundingBox | null;
};

type DateLabel = {
  readonly observation: MetadataObservation;
  readonly context: 'collection' | 'non-collection';
  readonly start: number;
  readonly end: number;
  readonly boundingBox: MetadataBoundingBox | null;
};

const COLLECTION_LABEL =
  /\b(?:date\s+(?:of\s+)?collection|collection\s+date|date\s+collected|specimen\s+collection(?:\s+date)?|sample\s+collection(?:\s+date)?|probenentnahme(?:datum)?|entnahme(?:datum)?|abnahmedatum|pa(?:ė|e)mimo\s+data|m(?:ė|e)ginio\s+pa(?:ė|e)mimo\s+data)\b/giu;
const NON_COLLECTION_LABEL =
  /\b(?:date\s+(?:of\s+)?(?:birth|receipt|received)|birth\s+date|receipt\s+date|date\s+reported|report\s+date|reported|issued|printed|dob|gimimo\s+data|i(?:š|s)davimo\s+data|pri(?:ė|e)mimo\s+data|patvirtinimo\s+data|ausgestellt|geburt|eingangsdatum|eingang)\b/giu;
const DATE_TOKEN = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,-])(?:\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}\.?\s+(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|maerz|apr(?:il)?|may|mai|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?)\s+\d{4}|(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|maerz|apr(?:il)?|may|mai|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?)\s+\d{1,2},?\s+\d{4})(?![\p{L}\p{N}.,-])`,
  'giu',
);
const MAX_HORIZONTAL_GAP = 0.3;
const PAGE_HEADER_Y = 0.15;
const PAGE_FOOTER_Y = 0.85;

/**
 * Build source-grounded collection-date candidates without assigning dates to measurements.
 * A caller must bind an accepted page/table/visual scope to rows separately.
 */
export function proposeCollectionDateMetadata(
  observations: readonly MetadataObservation[],
): CollectionDateMetadataResult {
  const unique = [
    ...new Map(observations.map((observation) => [observation.id, observation])).values(),
  ];
  const dates = unique.flatMap(dateTokens);
  const proposals: CollectionDateProposal[] = [];

  for (const date of dates) {
    const sameObservationLabels = dateLabels(date.observation).filter(
      (label) => label.observation.id === date.observation.id,
    );
    const nearbyLabels = unique
      .flatMap(dateLabels)
      .filter((label) => label.observation.id !== date.observation.id)
      .filter((label) => label.observation.pageIndex === date.observation.pageIndex)
      .filter((label) => sameVisualRow(date.observation, label.observation))
      .filter((label) => horizontalGap(date.observation, label.observation) <= MAX_HORIZONTAL_GAP);
    const labels = [...sameObservationLabels, ...nearbyLabels];
    const proposal = proposalForDate(date, labels);
    proposals.push(proposal);
  }

  const pageContexts = unique
    .map((observation) => observation.pageIndex)
    .filter((page, index, pages) => pages.indexOf(page) === index)
    .sort((a, b) => a - b)
    .map((pageIndex) => {
      const pageProposals = proposals.filter(
        (proposal) => proposal.pageIndex === pageIndex && proposal.reason === 'accepted',
      );
      const pageScoped = pageProposals.filter((proposal) => proposal.scope.kind === 'page');
      const pageDateProposals = proposals.filter((proposal) => proposal.pageIndex === pageIndex);
      const competingExplicitCollectionDates = pageDateProposals.filter(
        (proposal) =>
          proposal.reason !== 'non-collection-date' &&
          proposal.reason !== 'no-explicit-collection-label' &&
          (pageScoped[0] === undefined || proposal.id !== pageScoped[0].id),
      );
      if (pageScoped.length === 1 && competingExplicitCollectionDates.length === 0) {
        return {
          pageIndex,
          state: pageScoped[0]!.state,
          proposalIds: [pageScoped[0]!.id],
          reason: 'unique-page-date-pair' as const,
        };
      }
      return {
        pageIndex,
        state: { kind: 'missing' as const },
        proposalIds: pageProposals.map((proposal) => proposal.id),
        reason:
          pageScoped.length > 1 ||
          (pageScoped.length === 1 && competingExplicitCollectionDates.length > 0)
            ? ('ambiguous-page-date-pairs' as const)
            : ('no-page-date-pair' as const),
      };
    });

  return { proposals, pageContexts };
}

function proposalForDate(date: DateToken, labels: readonly DateLabel[]): CollectionDateProposal {
  const sameObservation = labels.filter((label) => label.observation.id === date.observation.id);
  const candidates =
    sameObservation.length > 0 ? inlineLabelsForDate(date, sameObservation) : labels;
  const nearest = nearestLabels(date, candidates);
  const collection = nearest.filter((candidate) => candidate.context === 'collection');
  const nonCollection = nearest.filter((candidate) => candidate.context === 'non-collection');
  const id = `collection-date:${date.observation.pageIndex}:${date.observation.id}:${date.start}`;
  const rawDate = sourceRef(date.observation, date.start, date.end, date.raw, date.boundingBox);

  if (collection.length === 0 && nonCollection.length > 0) {
    return {
      id,
      pageIndex: date.observation.pageIndex,
      scope: visualScope(date, nonCollection[0]!),
      state: { kind: 'missing' },
      rawDate,
      collectionLabel: null,
      reason: 'non-collection-date',
    };
  }
  if (collection.length !== 1 || nonCollection.length > 0) {
    return {
      id,
      pageIndex: date.observation.pageIndex,
      scope: visualScope(date, collection[0] ?? nonCollection[0] ?? null),
      state: { kind: 'missing' },
      rawDate,
      collectionLabel: collection.length === 1 ? sourceRefForLabel(collection[0]!) : null,
      reason: labels.length === 0 ? 'no-explicit-collection-label' : 'ambiguous-label-pairing',
    };
  }

  const label = collection[0]!;
  const locale = date.observation.locale ?? label.observation.locale ?? null;
  const state = parseExplicitDate(date.raw, locale);
  const reason =
    state === null
      ? dateNeedsLocale(date.raw, locale)
        ? 'ambiguous-date-locale'
        : 'invalid-date'
      : 'accepted';
  const scope = scopeForPair(date, label);
  return {
    id,
    pageIndex: date.observation.pageIndex,
    scope,
    state: state ?? { kind: 'missing' },
    rawDate,
    collectionLabel: sourceRefForLabel(label),
    reason,
  };
}

function dateTokens(observation: MetadataObservation): readonly DateToken[] {
  return [...observation.text.matchAll(DATE_TOKEN)].map((match) => {
    const start = match.index ?? 0;
    const raw = match[0];
    return {
      observation,
      raw,
      start,
      end: start + raw.length,
      boundingBox: textBoundingBox(observation, start, start + raw.length),
    };
  });
}

function dateLabels(observation: MetadataObservation): readonly DateLabel[] {
  return [
    ...[...observation.text.matchAll(COLLECTION_LABEL)].map((match) => ({
      observation,
      context: 'collection' as const,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      boundingBox: textBoundingBox(
        observation,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      ),
    })),
    ...[...observation.text.matchAll(NON_COLLECTION_LABEL)].map((match) => ({
      observation,
      context: 'non-collection' as const,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      boundingBox: textBoundingBox(
        observation,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      ),
    })),
  ];
}

function nearestLabels(date: DateToken, labels: readonly DateLabel[]): readonly DateLabel[] {
  if (labels.length === 0) return [];
  const ranked = labels
    .map((label) => ({ label, distance: Math.abs(labelCenterX(label) - dateCenterX(date)) }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = ranked[0]!;
  return ranked
    .filter((candidate) => Math.abs(candidate.distance - nearest.distance) <= 0.002)
    .map((candidate) => candidate.label);
}

function inlineLabelsForDate(date: DateToken, labels: readonly DateLabel[]): readonly DateLabel[] {
  const preceding = labels
    .filter((label) => label.end <= date.start)
    .sort((left, right) => right.end - left.end);
  if (preceding.length > 0) {
    const end = preceding[0]!.end;
    return preceding.filter((label) => label.end === end);
  }
  const following = labels
    .filter((label) => label.start >= date.end)
    .sort((left, right) => left.start - right.start);
  if (following.length > 0) {
    const start = following[0]!.start;
    return following.filter((label) => label.start === start);
  }
  return [];
}

function scopeForPair(date: DateToken, label: DateLabel): MetadataScope {
  const tableId = date.observation.structure?.tableId;
  const rowIndex = date.observation.structure?.rowIndex;
  if (
    tableId !== null &&
    tableId !== undefined &&
    rowIndex !== null &&
    rowIndex !== undefined &&
    tableId === label.observation.structure?.tableId &&
    rowIndex === label.observation.structure?.rowIndex
  ) {
    return {
      kind: 'table-row',
      key: `page:${date.observation.pageIndex}:table:${tableId}:row:${rowIndex}`,
    };
  }
  const pageOnly =
    date.observation.id === label.observation.id
      ? isStandaloneHeaderFooter(date.observation)
      : isPageHeaderFooter(date.observation) && isPageHeaderFooter(label.observation);
  return pageOnly
    ? { kind: 'page', key: `page:${date.observation.pageIndex}` }
    : visualScope(date, label);
}

function visualScope(date: DateToken, label: DateLabel | null): MetadataScope {
  return {
    kind: 'visual-row',
    key: `page:${date.observation.pageIndex}:visual:${label?.observation.id ?? 'none'}:${date.observation.id}:${date.start}`,
  };
}

function sameVisualRow(left: MetadataObservation, right: MetadataObservation): boolean {
  if (left.structure?.tableId !== undefined && left.structure?.tableId !== null) {
    return (
      left.structure.tableId === right.structure?.tableId &&
      left.structure.rowIndex !== null &&
      left.structure.rowIndex !== undefined &&
      left.structure.rowIndex === right.structure?.rowIndex
    );
  }
  if (right.structure?.tableId !== undefined && right.structure?.tableId !== null) return false;
  const leftTop = left.boundingBox.y;
  const leftBottom = left.boundingBox.y + left.boundingBox.height;
  const rightTop = right.boundingBox.y;
  const rightBottom = right.boundingBox.y + right.boundingBox.height;
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop);
  const smallerHeight = Math.min(left.boundingBox.height, right.boundingBox.height);
  return smallerHeight > 0 && overlap / smallerHeight >= 0.5;
}

function isPageHeaderFooter(observation: MetadataObservation): boolean {
  const center = centerY(observation);
  return center <= PAGE_HEADER_Y || center >= PAGE_FOOTER_Y;
}

function isStandaloneHeaderFooter(observation: MetadataObservation): boolean {
  return isPageHeaderFooter(observation);
}

function sourceRefForLabel(label: DateLabel): MetadataSourceRef {
  return sourceRef(
    label.observation,
    label.start,
    label.end,
    label.observation.text.slice(label.start, label.end),
    label.boundingBox,
  );
}

function sourceRef(
  observation: MetadataObservation,
  start: number,
  end: number,
  text: string,
  boundingBox: MetadataBoundingBox | null,
): MetadataSourceRef {
  return { observationId: observation.id, start, end, text, boundingBox };
}

function textBoundingBox(
  observation: MetadataObservation,
  start: number,
  end: number,
): MetadataBoundingBox | null {
  const span = observation.spans?.find((candidate) => {
    if (candidate.start !== undefined && candidate.end !== undefined)
      return candidate.start <= start && candidate.end >= end;
    return candidate.text.includes(observation.text.slice(start, end));
  });
  if (span?.boundingBox !== undefined) return span.boundingBox;
  if (observation.text.length === 0) return observation.boundingBox;
  const left = Math.max(0, start) / observation.text.length;
  const right = Math.min(observation.text.length, end) / observation.text.length;
  return {
    x: observation.boundingBox.x + observation.boundingBox.width * left,
    y: observation.boundingBox.y,
    width: observation.boundingBox.width * Math.max(0, right - left),
    height: observation.boundingBox.height,
  };
}

function labelCenterX(label: DateLabel): number {
  return label.boundingBox === null
    ? label.observation.boundingBox.x + label.observation.boundingBox.width / 2
    : label.boundingBox.x + label.boundingBox.width / 2;
}

function dateCenterX(date: DateToken): number {
  return date.boundingBox === null
    ? date.observation.boundingBox.x + date.observation.boundingBox.width / 2
    : date.boundingBox.x + date.boundingBox.width / 2;
}

function centerY(observation: MetadataObservation): number {
  return observation.boundingBox.y + observation.boundingBox.height / 2;
}

function horizontalGap(left: MetadataObservation, right: MetadataObservation): number {
  return Math.max(
    0,
    Math.max(left.boundingBox.x, right.boundingBox.x) -
      Math.min(
        left.boundingBox.x + left.boundingBox.width,
        right.boundingBox.x + right.boundingBox.width,
      ),
  );
}

function parseExplicitDate(input: string, locale: string | null): MetadataDateState | null {
  if (dateNeedsLocale(input, locale)) return null;
  const trimmed = input.trim();
  const numeric = trimmed.split(/[./-]/u).map(Number);
  let year: number;
  let month: number;
  let day: number;
  if (numeric.length === 3 && numeric.every((part) => Number.isInteger(part))) {
    if (String(numeric[0]).length === 4) [year, month, day] = numeric as [number, number, number];
    else if ((numeric[0] ?? 0) > 12) [day, month, year] = numeric as [number, number, number];
    else if ((numeric[1] ?? 0) > 12) [month, day, year] = numeric as [number, number, number];
    else if (/^en-(us|ca)/iu.test(locale ?? ''))
      [month, day, year] = numeric as [number, number, number];
    else [day, month, year] = numeric as [number, number, number];
  } else {
    const normalized = trimmed.toLocaleLowerCase(locale ?? 'en-US').replace(/\s+/gu, ' ');
    const dayFirst = normalized.match(/^(\d{1,2})\.?\s+([\p{L}]+)\s+(\d{4})$/u);
    const monthFirst = normalized.match(/^([\p{L}]+)\s+(\d{1,2}),?\s+(\d{4})$/u);
    const parts = dayFirst ?? monthFirst;
    if (parts === null) return null;
    const monthName = dayFirst === null ? parts[1] : parts[2];
    day = Number(dayFirst === null ? parts[2] : parts[1]);
    year = Number(parts[3]);
    month = writtenMonthNumber(monthName ?? '');
  }
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days) return null;
  return {
    kind: 'known',
    value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function writtenMonthNumber(value: string): number {
  const prefix = value.toLocaleLowerCase('en-US').slice(0, 3);
  return (
    (
      {
        jan: 1,
        feb: 2,
        mar: 3,
        mär: 3,
        mae: 3,
        apr: 4,
        may: 5,
        mai: 5,
        jun: 6,
        jul: 7,
        aug: 8,
        sep: 9,
        oct: 10,
        okt: 10,
        nov: 11,
        dec: 12,
        dez: 12,
      } as const
    )[prefix as keyof Record<string, number>] ?? 0
  );
}

function dateNeedsLocale(input: string, locale: string | null): boolean {
  const parts = input.split(/[./-]/u).map(Number);
  return (
    parts.length === 3 &&
    String(parts[0]).length !== 4 &&
    (parts[0] ?? 0) <= 12 &&
    (parts[1] ?? 0) <= 12 &&
    locale === null
  );
}
