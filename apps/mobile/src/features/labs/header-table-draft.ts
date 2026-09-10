import {
  proposeBiomarkerId,
  type ExtractionAliasEntry,
  type ExtractionDateContext,
  type ExtractionDraftRow,
  type ExtractionSemanticFieldSelection,
  type LabDateState,
  type LabSourceArtifact,
  type SpecimenType,
  type VisionTextObservation,
  type HeaderTableMeasurement,
  type HeaderTableSpecimen,
  parseReferenceInterval,
  revalidateExtractionRow,
} from '@alyte/domain';

/**
 * Resolve HeaderTable source IDs without treating a parent observation as a substitute for its
 * selected spans. HeaderTable source IDs intentionally contain both: the parent preserves the
 * complete source line and spans preserve the exact field slices.
 */
export function headerSourceObservations(
  sourceIds: readonly string[],
  observations: readonly VisionTextObservation[],
): readonly VisionTextObservation[] {
  const wanted = new Set(sourceIds);
  const resolved: VisionTextObservation[] = [];
  const emitted = new Set<string>();
  for (const sourceId of sourceIds) {
    const direct = observations.find((observation) => observation.id === sourceId);
    if (direct !== undefined && emitted.add(direct.id)) resolved.push(direct);
    for (const parent of observations) {
      for (const [spanIndex, span] of (parent.spans ?? []).entries()) {
        const spanId = span.id ?? `${parent.id}:span:${spanIndex}`;
        if (spanId !== sourceId || !wanted.has(spanId) || emitted.has(spanId)) continue;
        resolved.push({
          id: spanId,
          text: span.text,
          alternatives: parent.alternatives,
          boundingBox: span.boundingBox ?? parent.boundingBox,
          pageIndex: parent.pageIndex,
          orientation: parent.orientation,
          structure: {
            kind: 'text',
            tableId: parent.structure?.tableId ?? null,
            rowIndex: parent.structure?.rowIndex ?? null,
            columnIndex: parent.structure?.columnIndex ?? null,
          },
          sourceSpan: {
            id: spanId,
            parentObservationId: span.parentObservationId ?? parent.id,
            start: span.start ?? 0,
            end: span.end ?? span.text.length,
            text: span.text,
            boundingBox: span.boundingBox ?? parent.boundingBox,
            parentText: parent.text,
          },
          recognition: parent.recognition,
        });
        emitted.add(spanId);
      }
    }
  }
  return resolved;
}

export type HeaderTableDraftOptions = {
  readonly observations: readonly VisionTextObservation[];
  readonly locale: string;
  readonly collectionDateContexts?: readonly ExtractionDateContext[];
  readonly aliases: readonly ExtractionAliasEntry[];
  readonly artifact: LabSourceArtifact;
};

function specimenType(specimen: HeaderTableSpecimen | null): SpecimenType {
  if (specimen === null || specimen === 'unknown') return 'unknown';
  return specimen === 'blood-edta' ? 'blood' : specimen;
}

function unionBoxes(
  observations: readonly VisionTextObservation[],
): ExtractionDraftRow['source']['boundingBox'] {
  const first = observations[0]?.boundingBox;
  if (first === undefined) return { x: 0, y: 0, width: 0, height: 0 };
  return observations.slice(1).reduce(
    (box, observation) => ({
      x: Math.min(box.x, observation.boundingBox.x),
      y: Math.min(box.y, observation.boundingBox.y),
      width:
        Math.max(box.x + box.width, observation.boundingBox.x + observation.boundingBox.width) -
        Math.min(box.x, observation.boundingBox.x),
      height:
        Math.max(box.y + box.height, observation.boundingBox.y + observation.boundingBox.height) -
        Math.min(box.y, observation.boundingBox.y),
    }),
    { ...first },
  );
}

function exactDateToken(value: string | null): string | null {
  if (value === null) return null;
  // Keep the exact source substring. This is intentionally not a date parser or formatter.
  return (
    value.match(
      /(?<!\d)(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{4})(?!\d)/u,
    )?.[0] ?? null
  );
}

function dateContextFor(
  measurement: HeaderTableMeasurement,
  sourceObservations: readonly VisionTextObservation[],
  contexts: readonly ExtractionDateContext[],
  locale: string,
): ExtractionDateContext | null {
  if (measurement.collectionDate === null) return null;
  const dateIds = new Set(measurement.collectionDateSourceIds);
  const dateSource = sourceObservations.find((observation) => dateIds.has(observation.id));
  const existing = contexts.find((context) => dateIds.has(context.observationId));
  const sourceDate = existing?.sourceDate ?? exactDateToken(dateSource?.text ?? null);
  if (existing !== undefined) {
    return {
      ...existing,
      ...(sourceDate === null ? {} : { sourceDate }),
      collectionDate: { kind: 'known', value: measurement.collectionDate },
    };
  }
  if (dateSource === undefined || sourceDate === null) return null;
  return {
    observationId: dateSource.id,
    pageIndex: dateSource.pageIndex,
    centerY: dateSource.boundingBox.y + dateSource.boundingBox.height / 2,
    centerX: dateSource.boundingBox.x + dateSource.boundingBox.width / 2,
    locale,
    context: 'collection',
    ambiguous: false,
    collectionDate: { kind: 'known', value: measurement.collectionDate },
    sourceText: dateSource.text,
    sourceDate,
  };
}

function valueFor(measurement: HeaderTableMeasurement): ExtractionDraftRow['sourceValue'] {
  const text = measurement.valueString ?? '';
  if (
    measurement.valueType === 'numeric' &&
    measurement.comparator === null &&
    typeof measurement.parsedValue === 'number' &&
    Number.isFinite(measurement.parsedValue)
  )
    return { kind: 'numeric', value: measurement.parsedValue };
  if (
    measurement.valueType === 'bounded' &&
    (measurement.comparator === '<' || measurement.comparator === '>') &&
    typeof measurement.parsedValue === 'number' &&
    Number.isFinite(measurement.parsedValue)
  )
    return {
      kind: 'bounded',
      comparator: measurement.comparator,
      value: measurement.parsedValue,
    };
  if (measurement.valueType === 'categorical' && text.length > 0)
    return { kind: 'categorical', value: text };
  // The current MeasurementValue contract cannot represent <= or >= without changing their
  // semantics. Keep those exact source strings reviewable as free text until the schema grows.
  return { kind: 'free_text', value: text };
}

function sourceTextFor(
  measurement: HeaderTableMeasurement,
  sourceObservations: readonly VisionTextObservation[],
): string {
  const fields = [
    measurement.sourceLabel,
    measurement.valueString,
    measurement.unit,
    measurement.referenceInterval,
    measurement.flag,
  ].filter((value): value is string => value !== null && value.length > 0);
  return fields.length > 0
    ? fields.join('  ')
    : sourceObservations.map((observation) => observation.text).join('  ');
}

function reviewReasonsFor(
  measurement: HeaderTableMeasurement,
  value: ExtractionDraftRow['sourceValue'],
  proposedBiomarkerId: ExtractionDraftRow['proposedBiomarkerId'],
  collectionDate: LabDateState,
): ExtractionDraftRow['reviewReasons'] {
  const reasons = new Set<ExtractionDraftRow['reviewReasons'][number]>();
  if (measurement.sourceLabel.trim().length === 0) reasons.add('missing-label');
  if (measurement.valueString === null || measurement.valueString.trim().length === 0)
    reasons.add('missing-value');
  if (value.kind === 'free_text') {
    if (value.value.trim().length === 0 || measurement.valueType === 'bounded')
      reasons.add('unparseable-value');
  }
  // Preserve unsupported comparator semantics as review work without rewriting <= or >= as < or >.
  if (
    measurement.comparator !== null &&
    measurement.comparator !== '<' &&
    measurement.comparator !== '>'
  )
    reasons.add('unparseable-value');
  if (proposedBiomarkerId === null) reasons.add('unsupported-alias');
  if ((value.kind === 'numeric' || value.kind === 'bounded') && measurement.unit === null)
    reasons.add('missing-unit');
  if (
    measurement.referenceInterval !== null &&
    parseReferenceInterval(measurement.referenceInterval) === null
  )
    reasons.add('unparseable-reference-interval');
  if (collectionDate.kind === 'missing') reasons.add('missing-collection-date');
  if (measurement.ambiguousFields.includes('collectionDate')) reasons.add('ambiguous-date');
  return [...reasons];
}

function sourceFieldId(
  ids: readonly string[],
  sourceObservations: readonly VisionTextObservation[],
): string {
  return (
    ids.find((id) =>
      sourceObservations.some(
        (observation) => observation.id === id && observation.sourceSpan !== undefined,
      ),
    ) ??
    ids.find((id) => sourceObservations.some((observation) => observation.id === id)) ??
    ''
  );
}

function sourceFieldsFor(
  measurement: HeaderTableMeasurement,
  sourceObservations: readonly VisionTextObservation[],
): ExtractionSemanticFieldSelection {
  return {
    label: sourceFieldId(measurement.labelSourceIds, sourceObservations),
    value: sourceFieldId(measurement.valueSourceIds, sourceObservations),
    unit:
      measurement.unit === null
        ? null
        : sourceFieldId(measurement.unitSourceIds, sourceObservations),
    referenceInterval:
      measurement.referenceInterval === null
        ? null
        : sourceFieldId(measurement.referenceIntervalSourceIds, sourceObservations),
    flag:
      measurement.flag === null
        ? null
        : sourceFieldId(measurement.flagSourceIds, sourceObservations),
  };
}

/** Convert source-grounded HeaderTable measurements into editable extraction rows. */
export function createHeaderTableDraftRows(
  measurements: readonly HeaderTableMeasurement[],
  options: HeaderTableDraftOptions,
): readonly ExtractionDraftRow[] {
  return measurements.map((measurement, order) => {
    const sourceObservations = headerSourceObservations(
      measurement.sourceIds,
      options.observations,
    );
    const sourceValue = valueFor(measurement);
    const collectionDate: LabDateState =
      measurement.collectionDate === null
        ? { kind: 'missing' }
        : { kind: 'known', value: measurement.collectionDate };
    const collectionDateContext = dateContextFor(
      measurement,
      sourceObservations,
      options.collectionDateContexts ?? [],
      options.locale,
    );
    const proposedBiomarkerId = proposeBiomarkerId(measurement.sourceLabel, options.aliases);
    const localReviewReasons = reviewReasonsFor(
      measurement,
      sourceValue,
      proposedBiomarkerId,
      collectionDate,
    );
    const sourceText = sourceTextFor(measurement, sourceObservations);
    const first = sourceObservations[0];
    const initialRow: ExtractionDraftRow = {
      id: measurement.id,
      order,
      panelLabel: null,
      sourceText,
      sourceLabel: measurement.sourceLabel,
      sourceValue,
      sourceValueString: measurement.valueString ?? '',
      sourceUnit: measurement.unit,
      sourceReferenceInterval: measurement.referenceInterval,
      sourceFlag: measurement.flag,
      source: {
        pageIndex: measurement.page === null ? (first?.pageIndex ?? 0) : measurement.page - 1,
        orientation: first?.orientation ?? 0,
        artifact: options.artifact,
        observationIds: [...new Set(measurement.sourceIds)],
        observations: sourceObservations,
        semantic: null,
        boundingBox: measurement.location ?? unionBoxes(sourceObservations),
        raw: {
          label: measurement.sourceLabel || null,
          value: measurement.valueString,
          unit: measurement.unit,
          referenceInterval: measurement.referenceInterval,
          flag: measurement.flag,
          collectionDate: exactDateToken(
            sourceObservations.find((observation) =>
              measurement.collectionDateSourceIds.includes(observation.id),
            )?.text ?? null,
          ),
        },
      },
      collectionDateContext,
      proposedLabel: measurement.sourceLabel,
      proposedValue: sourceValue,
      proposedUnit: measurement.unit,
      proposedReferenceInterval: measurement.referenceInterval,
      proposedFlag: measurement.flag,
      proposedBiomarkerId,
      proposedSpecimenType: specimenType(measurement.specimen),
      collectionDate,
      reviewReasons: [],
      reviewState: 'ready',
      decision: 'resolve',
      editState: 'automatic',
    };
    // HeaderTable has already selected exact source fields. Supplying those selections lets the
    // existing domain validator check alias, unit, method, specimen, and layout compatibility
    // without rescanning a source line and mistaking reference numbers for observed values.
    const validated = revalidateExtractionRow(initialRow, {}, options.aliases, {
      sourceFields: sourceFieldsFor(measurement, sourceObservations),
    });
    const reviewReasons = [...new Set([...validated.reviewReasons, ...localReviewReasons])];
    const canonicalLabel =
      validated.proposedBiomarkerId === null || reviewReasons.includes('ambiguous-assay')
        ? null
        : (options.aliases.find((entry) => entry.id === validated.proposedBiomarkerId)
            ?.canonicalLabel ?? null);
    return {
      ...validated,
      proposedLabel: canonicalLabel ?? validated.proposedLabel,
      reviewReasons,
      reviewState: reviewReasons.length === 0 ? 'ready' : 'needs-review',
      decision: reviewReasons.length === 0 ? 'resolve' : 'unresolved',
    };
  });
}
