import {
  extractionReviewBlocksConfirmation,
  type ExtractionDraftRow,
  type ExtractionRowDecision,
} from '@alyte/domain';

export type ExtractionReviewFilter = 'all' | 'needs-review';

export type ExtractionReviewSection = {
  readonly key: string;
  readonly collectionDateLabel: string | null;
  readonly specimenType: ExtractionDraftRow['proposedSpecimenType'];
  readonly panels: readonly {
    readonly label: string | null;
    readonly rows: readonly ExtractionDraftRow[];
  }[];
};

export function extractionNeedsResolution(
  row: Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>,
): boolean {
  return extractionReviewBlocksConfirmation(row);
}

export type ExtractionDecisionPresentation = {
  readonly label: 'kept' | 'skipped' | 'resolved' | 'needs-decision';
  /** Review decisions stay visually neutral; they are not provenance or inclusion states. */
  readonly tone: 'neutral';
};

export function extractionDecisionPresentation(
  decision: ExtractionRowDecision,
): ExtractionDecisionPresentation {
  switch (decision) {
    case 'preserve':
      return { label: 'kept', tone: 'neutral' };
    case 'skip':
      return { label: 'skipped', tone: 'neutral' };
    case 'resolve':
      return { label: 'resolved', tone: 'neutral' };
    case 'unresolved':
      return { label: 'needs-decision', tone: 'neutral' };
  }
}

export function canConfirmExtraction(
  rows: readonly Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>[],
): boolean {
  return (
    rows.some((row) => row.decision !== 'skip') &&
    rows.every((row) => !extractionNeedsResolution(row))
  );
}

export function filterExtractionRows(
  rows: readonly ExtractionDraftRow[],
  search: string,
  filter: ExtractionReviewFilter,
): readonly ExtractionDraftRow[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter === 'needs-review' && !extractionNeedsResolution(row)) return false;
    if (!query) return true;
    const value = row.proposedValue;
    const proposedValue =
      value.kind === 'numeric'
        ? String(value.value)
        : value.kind === 'bounded'
          ? `${value.comparator}${value.value}`
          : value.value;
    return [
      row.proposedLabel,
      row.sourceLabel,
      row.sourceText,
      proposedValue,
      row.sourceValueString,
      row.proposedUnit,
      row.proposedReferenceInterval,
      row.proposedFlag,
      row.panelLabel,
    ]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function buildExtractionReviewSections(
  rows: readonly ExtractionDraftRow[],
): readonly ExtractionReviewSection[] {
  const records = new Map<string, ExtractionReviewSection>();
  for (const row of rows) {
    const collectionDateLabel =
      row.collectionDate.kind === 'known' ? row.collectionDate.value : null;
    const key = `${collectionDateLabel ?? 'missing'}|${row.proposedSpecimenType}`;
    let record = records.get(key);
    if (record === undefined) {
      record = { key, collectionDateLabel, specimenType: row.proposedSpecimenType, panels: [] };
      records.set(key, record);
    }
    const panels = [...record.panels];
    const panelIndex = panels.findIndex((panel) => panel.label === row.panelLabel);
    if (panelIndex < 0) panels.push({ label: row.panelLabel, rows: [row] });
    else {
      const panel = panels[panelIndex]!;
      panels[panelIndex] = { ...panel, rows: [...panel.rows, row] };
    }
    records.set(key, { ...record, panels });
  }
  return [...records.values()];
}

export function sourceRegionPresentation(row: Pick<ExtractionDraftRow, 'source'>) {
  return {
    pageIndex: row.source.pageIndex,
    boundingBox: row.source.boundingBox,
  } as const;
}
