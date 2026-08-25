import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bloodLiverLabReportFixtures,
  bloodLiverSafetyReportFixture,
  type BloodLiverExpectedMeasurement,
  type BloodLiverLabReportFixture,
} from '@alyte/fixtures';
import {
  buildExtractionConfirmationPlan,
  buildMeasuredTrend,
  canonicalId,
  convertComparableValue,
  decodeVisionOCRResult,
  groupObservationsIntoRows,
  parseLabDate,
  resolveExtractionMethodProfile,
  type ExtractionAliasEntry,
  type ExtractionDraft,
  type LabRecord,
  type Measurement,
} from '@alyte/domain';
import { comparableBiomarkers } from '@alyte/catalogue';
import { createDefaultExtractionAliases } from './report-service';

const enzymeIds = new Set(['biomarker.alt', 'biomarker.ast', 'biomarker.ggt']);

function extractFixture(
  fixture: BloodLiverLabReportFixture,
  aliases: readonly ExtractionAliasEntry[],
): {
  readonly rows: ReturnType<typeof groupObservationsIntoRows>;
  readonly plan: ReturnType<typeof buildExtractionConfirmationPlan>;
} {
  const ocr = decodeVisionOCRResult({
    contractVersion: 'alyte.vision.document.v2',
    pageIndex: 0,
    orientation: 0,
    observations: fixture.observations,
  });
  const collectionDate = parseLabDate(fixture.collectionDateText, fixture.locale);
  assert.deepEqual(
    collectionDate,
    { kind: 'known', value: fixture.expectedCollectionDate },
    fixture.id,
  );

  const rows = fixture.expected.specimenContexts.flatMap((context) =>
    groupObservationsIntoRows(
      ocr.observations.filter((observation) => context.observationIds.includes(observation.id)),
      {
        aliases,
        locale: fixture.locale,
        collectionDate: collectionDate ?? { kind: 'missing' },
        specimenType: context.specimenType,
      },
    ),
  );
  const draft: ExtractionDraft = {
    id: fixture.id,
    reportId: `${fixture.id}-source`,
    state: 'draft',
    ocrContractVersion: 'alyte.vision.document.v2',
    parserVersion: 'alyte.local-parser.v2',
    collectionDate: collectionDate ?? { kind: 'missing' },
    rows,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    confirmedAt: null,
  };
  return {
    rows,
    plan: buildExtractionConfirmationPlan(draft, {
      record: (key) => `${fixture.id}-record-${key}`,
      measurement: (rowId) => `${fixture.id}-measurement-${rowId}`,
    }),
  };
}

function measurementFromPlan(
  recordId: string,
  specimenType: LabRecord['specimenType'],
  planned: ReturnType<
    typeof buildExtractionConfirmationPlan
  >['records'][number]['measurements'][number],
): Measurement {
  const state = {
    biomarkerId: planned.biomarkerId === null ? null : canonicalId(planned.biomarkerId),
    specimenType,
    snapshot: planned.original,
    reviewState: planned.reviewState,
    provenance: planned.provenance,
    source: planned.source,
  };
  return {
    id: planned.id,
    labRecordId: recordId,
    biomarkerId: state.biomarkerId,
    specimenType: state.specimenType,
    panelLabel: planned.panelLabel,
    original: planned.original,
    originalState: state,
    current: {
      label: planned.label,
      value: planned.value,
      valueString: planned.valueString,
      unit: planned.unit,
      referenceInterval: planned.referenceInterval,
      flag: planned.flag,
    },
    provenance: planned.provenance,
    reviewState: planned.reviewState,
    source: planned.source,
    corrections: [],
  };
}

function recordsFromPlan(
  fixture: BloodLiverLabReportFixture,
  plan: ReturnType<typeof buildExtractionConfirmationPlan>,
): readonly LabRecord[] {
  const contextByObservation = new Map(
    fixture.expected.specimenContexts.flatMap((context) =>
      context.observationIds.map((observationId) => [observationId, context.specimenType] as const),
    ),
  );
  return plan.records.map((record) => {
    const specimenType =
      record.measurements
        .map((measurement) => contextByObservation.get(measurement.sourceRowId))
        .find((value): value is NonNullable<typeof value> => value !== undefined) ?? 'unknown';
    return {
      id: record.id,
      labReportId: plan.reportId,
      collectionDate: record.collectionDate,
      specimenType,
      laboratoryName: 'Synthetic Laboratory',
      notes: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
      measurements: record.measurements.map((measurement) =>
        measurementFromPlan(record.id, specimenType, measurement),
      ),
    };
  });
}

describe('blood-count and liver synthetic extraction evidence', () => {
  it('decodes, groups, maps, confirms, and preserves all six families across three locales', () => {
    const aliases = createDefaultExtractionAliases();
    const records: LabRecord[] = [];
    const expectedByBiomarker = new Map<string, BloodLiverExpectedMeasurement[]>();

    for (const fixture of bloodLiverLabReportFixtures) {
      const { rows, plan } = extractFixture(fixture, aliases);
      const rowByObservation = new Map(rows.map((row) => [row.id, row]));
      assert.equal(new Set(fixture.expected.credible.map((entry) => entry.biomarkerId)).size, 6);
      assert.equal(fixture.expected.needsReview.length, 0, fixture.id);

      for (const entry of fixture.expected.credible) {
        const row = rowByObservation.get(entry.observationId);
        assert.ok(row, `${fixture.id}: ${entry.observationId} was not grouped`);
        assert.equal(row?.proposedBiomarkerId, entry.biomarkerId, fixture.id);
        assert.equal(row?.reviewState, 'ready', `${fixture.id}:${entry.observationId}`);
        assert.equal(row?.proposedSpecimenType, entry.specimenType, fixture.id);
        assert.deepEqual(row?.proposedValue, { kind: 'numeric', value: entry.value }, fixture.id);
        assert.equal(row?.sourceValueString, entry.valueString, fixture.id);
        assert.equal(row?.sourceUnit, entry.unit, fixture.id);
        assert.equal(row?.proposedUnit, entry.unit, fixture.id);
        assert.equal(row?.sourceReferenceInterval, entry.referenceInterval, fixture.id);
        assert.equal(row?.proposedReferenceInterval, entry.referenceInterval, fixture.id);
        assert.deepEqual(row?.collectionDate, {
          kind: 'known',
          value: fixture.expectedCollectionDate,
        });
        assert.deepEqual(row?.source.observationIds, [entry.observationId]);
        assert.equal(row?.source.observations?.[0]?.id, entry.observationId);
        assert.equal(
          row?.source.observations?.[0]?.text,
          fixture.observations.find((observation) => observation.id === entry.observationId)?.text,
        );
        assert.equal(row?.source.semantic, null);

        const catalogueEntry = comparableBiomarkers.find(
          (candidate) => candidate.id === entry.biomarkerId,
        );
        assert.ok(catalogueEntry, `${fixture.id}: ${entry.biomarkerId}`);
        const normalized = convertComparableValue(entry.value, entry.unit, catalogueEntry);
        assert.ok(normalized, `${fixture.id}: deterministic conversion`);
        assert.equal(normalized?.unit, entry.canonicalUnit, fixture.id);
        assert.equal(normalized?.value, entry.normalizedValue, fixture.id);
        if (entry.unit !== entry.canonicalUnit) {
          assert.ok((normalized?.conversionSourceIds.length ?? 0) > 0, fixture.id);
        } else {
          assert.deepEqual(normalized?.conversionSourceIds, [], fixture.id);
        }

        if (enzymeIds.has(entry.biomarkerId)) {
          assert.match(row?.sourceText ?? '', /IFCC/iu, fixture.id);
          assert.match(row?.sourceText ?? '', /37\s*C/iu, fixture.id);
          assert.match(row?.sourceText ?? '', /P5P/iu, fixture.id);
          const alias = aliases.find((candidate) => candidate.id === entry.biomarkerId);
          assert.ok(alias?.methodPolicy?.profiles, fixture.id);
          assert.ok(
            resolveExtractionMethodProfile(row?.sourceText ?? '', alias?.methodPolicy),
            fixture.id,
          );
        }

        const planned = plan.records
          .flatMap((record) => record.measurements)
          .find((measurement) => measurement.sourceRowId === entry.observationId);
        assert.ok(planned, `${fixture.id}: confirmation plan ${entry.observationId}`);
        assert.equal(planned?.reviewState, 'confirmed', fixture.id);
        assert.deepEqual(planned?.value, { kind: 'numeric', value: entry.value }, fixture.id);
        assert.equal(planned?.valueString, String(entry.value), fixture.id);
        assert.equal(planned?.original.valueString, entry.valueString, fixture.id);
        assert.equal(planned?.original.referenceInterval, entry.referenceInterval, fixture.id);
        assert.deepEqual(planned?.source.observationIds, [entry.observationId]);
        expectedByBiomarker.get(entry.biomarkerId)?.push(entry) ??
          expectedByBiomarker.set(entry.biomarkerId, [entry]);
      }

      for (const excludedId of fixture.expected.excludedObservationIds) {
        assert.equal(rowByObservation.has(excludedId), false, `${fixture.id}: ${excludedId}`);
      }
      records.push(...recordsFromPlan(fixture, plan));
      assert.equal(plan.records.length, 2, `${fixture.id}: blood and liver specimen records`);
    }

    const expectedDirections: Readonly<Record<string, 'increased' | 'decreased'>> = {
      'biomarker.hemoglobin': 'decreased',
      'biomarker.hematocrit': 'decreased',
      'biomarker.mcv': 'increased',
      'biomarker.alt': 'decreased',
      'biomarker.ast': 'decreased',
      'biomarker.ggt': 'decreased',
    };
    for (const [biomarkerId, expected] of expectedByBiomarker) {
      const trend = buildMeasuredTrend(records, canonicalId(biomarkerId), comparableBiomarkers);
      assert.equal(trend.points.length, 3, biomarkerId);
      assert.equal(trend.direction, expectedDirections[biomarkerId], biomarkerId);
      assert.deepEqual(
        trend.points.map((point) => point.source.referenceInterval),
        expected.map((entry) => entry.referenceInterval),
        biomarkerId,
      );
      assert.deepEqual(
        trend.points.map((point) => point.current.value),
        expected.map((entry) => ({ kind: 'numeric', value: entry.value })),
        biomarkerId,
      );
      assert.deepEqual(
        trend.points.map((point) => point.normalized.value),
        expected.map((entry) => entry.normalizedValue),
        biomarkerId,
      );
      assert.equal(trend.generalGuidance.length, 0, `${biomarkerId}: no inferred personal range`);
    }
  });

  it('keeps unknown/incompatible specimens, units, methods, sibling labels, and furniture out of trends', () => {
    const aliases = createDefaultExtractionAliases();
    const fixture = bloodLiverSafetyReportFixture;
    const { rows, plan } = extractFixture(fixture, aliases);
    const rowByObservation = new Map(rows.map((row) => [row.id, row]));

    const unknown = rowByObservation.get('safety-unknown-mcv');
    assert.equal(unknown?.reviewState, 'ready');
    assert.equal(unknown?.proposedSpecimenType, 'unknown');
    assert.equal(unknown?.proposedBiomarkerId, 'biomarker.mcv');

    for (const expected of fixture.expected.needsReview) {
      const row = rowByObservation.get(expected.observationId);
      assert.ok(row, expected.observationId);
      assert.equal(row?.proposedBiomarkerId, expected.biomarkerId, expected.observationId);
      assert.equal(row?.proposedSpecimenType, expected.specimenType, expected.observationId);
      assert.equal(row?.reviewState, 'needs-review', expected.observationId);
      assert.ok(row?.reviewReasons.includes(expected.reason), expected.observationId);
      assert.deepEqual(
        row?.source.observationIds,
        [expected.observationId],
        expected.observationId,
      );
    }
    for (const excludedId of fixture.expected.excludedObservationIds) {
      assert.equal(rowByObservation.has(excludedId), false, excludedId);
    }

    const knownFixture = bloodLiverLabReportFixtures[0]!;
    const knownExtraction = extractFixture(knownFixture, aliases);
    const safetyRecords = [
      ...recordsFromPlan(knownFixture, knownExtraction.plan),
      ...recordsFromPlan(fixture, plan),
    ];
    const unknownTrend = buildMeasuredTrend(
      safetyRecords,
      canonicalId('biomarker.mcv'),
      comparableBiomarkers,
    );
    assert.equal(unknownTrend.points.length, 1);
    assert.equal(
      unknownTrend.points[0]?.measurementId,
      'blood-liver-report-en-us-v1-measurement-en-mcv',
    );
    assert.equal(
      unknownTrend.nonPoints.some((point) => point.reason === 'incompatible-specimen'),
      true,
    );
    assert.equal(
      plan.records
        .flatMap((record) => record.measurements)
        .some((measurement) => measurement.reviewState === 'needs-review'),
      true,
    );
    const invalidTrend = buildMeasuredTrend(
      safetyRecords,
      canonicalId('biomarker.hemoglobin'),
      comparableBiomarkers,
    );
    assert.equal(invalidTrend.points.length, 1);
    assert.equal(
      invalidTrend.points.some((point) => point.measurementId.endsWith('safety-urine-hemoglobin')),
      false,
    );
    assert.equal(
      invalidTrend.nonPoints.some((point) => point.reason === 'unconfirmed'),
      true,
    );
  });
});
