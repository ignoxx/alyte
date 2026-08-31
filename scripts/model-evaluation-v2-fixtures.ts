import { comparableBiomarkers } from '@alyte/catalogue';
import type {
  ExtractionSemanticCandidateRow,
  ExtractionSemanticFieldSelection,
  ExtractionSemanticProposal,
  SpecimenType,
  VisionTextObservation,
} from '@alyte/domain';

export type V2FixtureObservation = VisionTextObservation & {
  readonly rowId: string;
  readonly locale: 'en' | 'de' | 'lt';
  readonly specimenType: SpecimenType;
};
export type V2ExpectedRow = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly sourceFactObservationIds: readonly string[];
  readonly sourceFields: ExtractionSemanticFieldSelection;
  readonly biomarkerId: string | null;
  readonly role: NonNullable<ExtractionSemanticProposal['role']>;
  readonly specimenType: SpecimenType;
  readonly sourceFacts: {
    readonly valueString: string;
    readonly unit: string;
    readonly referenceInterval: string;
  };
};
export type V2Fixture = {
  readonly id: string;
  readonly language: 'en' | 'de' | 'lt';
  readonly rows: readonly ExtractionSemanticCandidateRow[];
  readonly observations: readonly V2FixtureObservation[];
  readonly expected: readonly V2ExpectedRow[];
};

export const PRODUCTION_V2_FIXTURE_VERSION =
  'alyte.gemma4-production-contract-fixtures.v1' as const;

function cell(
  id: string,
  rowId: string,
  text: string,
  language: V2Fixture['language'],
  specimenType: SpecimenType,
  index: number,
): V2FixtureObservation {
  return {
    id,
    rowId,
    text,
    alternatives: [],
    pageIndex: 0,
    orientation: 0,
    boundingBox: { x: Math.min(0.02 + index * 0.19, 0.8), y: 0.2, width: 0.16, height: 0.03 },
    recognition: { level: 'accurate', language, internalConfidence: null },
    locale: language,
    specimenType,
  };
}

type RowInput = {
  readonly rowId: string;
  readonly cells: readonly string[];
  readonly labelIndex: number;
  readonly valueIndex: number;
  readonly unitIndex: number;
  readonly intervalIndex: number;
  readonly biomarkerId: string | null;
  readonly role: NonNullable<ExtractionSemanticProposal['role']>;
  readonly specimenType: SpecimenType;
  readonly labelAlternatives?: readonly string[];
  readonly valueAlternatives?: readonly string[];
};

function makeFixture(
  id: string,
  language: V2Fixture['language'],
  inputs: readonly RowInput[],
): V2Fixture {
  const rows = inputs.map((input) => {
    const observations = input.cells.map((text, index) =>
      cell(`${input.rowId}-c${index}`, input.rowId, text, language, input.specimenType, index),
    );
    if (input.labelAlternatives !== undefined) {
      const item = observations[input.labelIndex];
      if (item !== undefined)
        observations[input.labelIndex] = { ...item, alternatives: input.labelAlternatives };
    }
    if (input.valueAlternatives !== undefined) {
      const item = observations[input.valueIndex];
      if (item !== undefined)
        observations[input.valueIndex] = { ...item, alternatives: input.valueAlternatives };
    }
    return {
      rowId: input.rowId,
      sourceObservationIds: observations.map((item) => item.id),
      observations,
    } satisfies ExtractionSemanticCandidateRow;
  });
  const observations = rows.flatMap((row) => row.observations) as V2FixtureObservation[];
  const expected = inputs.map((input) => {
    const row = rows.find((candidate) => candidate.rowId === input.rowId)!;
    const id = (index: number) => row.sourceObservationIds[index]!;
    return {
      rowId: input.rowId,
      sourceObservationIds: row.sourceObservationIds,
      sourceFactObservationIds: [
        id(input.valueIndex),
        id(input.unitIndex),
        id(input.intervalIndex),
      ],
      sourceFields: {
        label: id(input.labelIndex),
        value: id(input.valueIndex),
        unit: id(input.unitIndex),
        referenceInterval: id(input.intervalIndex),
        flag: null,
      },
      biomarkerId: input.biomarkerId,
      role: input.role,
      specimenType: input.specimenType,
      sourceFacts: {
        valueString: input.cells[input.valueIndex]!,
        unit: input.cells[input.unitIndex]!,
        referenceInterval: input.cells[input.intervalIndex]!,
      },
    };
  });
  return { id, language, rows, observations, expected };
}

export const productionV2Fixtures: readonly V2Fixture[] = Object.freeze([
  makeFixture('gemma-v2-en-supported', 'en', [
    {
      rowId: 'en-serum-ldl',
      cells: ['LDL cholesterol', '118', 'mg/dL', '<115'],
      labelIndex: 0,
      valueIndex: 1,
      unitIndex: 2,
      intervalIndex: 3,
      labelAlternatives: ['R-017', '2026-08-17 08:42'],
      biomarkerId: 'biomarker.ldl_c',
      role: 'measurement',
      specimenType: 'serum',
    },
  ]),
  makeFixture('gemma-v2-en-unsupported', 'en', [
    {
      rowId: 'en-urine-glucose',
      cells: ['Glucose', 'negative', 'qualitative', 'negative'],
      labelIndex: 0,
      valueIndex: 1,
      unitIndex: 2,
      intervalIndex: 3,
      labelAlternatives: ['Glucose (urine)'],
      biomarkerId: null,
      role: 'preserve',
      specimenType: 'urine',
    },
  ]),
  makeFixture('gemma-v2-de-columns', 'de', [
    {
      rowId: 'de-plasma-ldl',
      cells: ['LDL-Cholesterin', 'mmol/L', '3,8', '<3,0'],
      labelIndex: 0,
      valueIndex: 2,
      unitIndex: 1,
      intervalIndex: 3,
      labelAlternatives: ['LDL Cholesterin'],
      valueAlternatives: ['3.8'],
      biomarkerId: 'biomarker.ldl_c',
      role: 'measurement',
      specimenType: 'plasma',
    },
  ]),
  makeFixture('gemma-v2-de-reordered', 'de', [
    {
      rowId: 'de-blood-hb',
      cells: ['14,2', 'Hämoglobin', '12,0–16,0', 'g/dL'],
      labelIndex: 1,
      valueIndex: 0,
      unitIndex: 3,
      intervalIndex: 2,
      biomarkerId: 'biomarker.hemoglobin',
      role: 'measurement',
      specimenType: 'blood',
    },
  ]),
  makeFixture('gemma-v2-lt-supported', 'lt', [
    {
      rowId: 'lt-serum-ferritin',
      cells: ['Feritinas', '42', 'ng/mL', '15–150'],
      labelIndex: 0,
      valueIndex: 1,
      unitIndex: 2,
      intervalIndex: 3,
      labelAlternatives: ['Serumo feritinas'],
      biomarkerId: 'biomarker.ferritin',
      role: 'measurement',
      specimenType: 'serum',
    },
  ]),
  makeFixture('gemma-v2-lt-ambiguous', 'lt', [
    {
      rowId: 'lt-ambiguous-cholesterol',
      cells: ['Cholesterolis', '5,1', 'mmol/L', '—'],
      labelIndex: 0,
      valueIndex: 1,
      unitIndex: 2,
      intervalIndex: 3,
      biomarkerId: null,
      role: 'preserve',
      specimenType: 'serum',
    },
  ]),
]);

export const productionAliases = comparableBiomarkers.map((entry) => ({
  id: entry.id,
  canonicalLabel: entry.canonicalLabel,
  aliases: entry.aliases,
  specimens: entry.specimens,
  units: entry.units,
  unsafeAliases: entry.unsafeAliases,
  methodPolicy: entry.methodPolicy,
}));
