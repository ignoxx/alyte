import type { SpecimenType } from '@alyte/domain';
import type { SemanticRole } from './schema';

export const MODEL_EVALUATION_FIXTURE_VERSION = 'alyte.qwen-evaluation-fixtures.v1' as const;

export type FixtureObservation = {
  readonly id: string;
  readonly rowId: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly pageIndex: number;
  readonly locale: 'en' | 'de' | 'lt' | 'pl' | 'fr' | 'es';
  readonly specimenType: SpecimenType;
};

export type FixtureExpectedMapping = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly sourceFactObservationIds: readonly string[];
  readonly biomarkerId: string | null;
  readonly role: SemanticRole;
  readonly specimenType: SpecimenType;
  /** These facts are source-only and are never included in model output. */
  readonly sourceFacts: {
    readonly valueString: string;
    readonly unit: string;
    readonly referenceInterval: string;
  };
};

export type SemanticEvaluationFixture = {
  readonly id: string;
  readonly language: FixtureObservation['locale'];
  readonly observations: readonly FixtureObservation[];
  readonly expected: readonly FixtureExpectedMapping[];
};

function observation(
  id: string,
  rowId: string,
  text: string,
  language: FixtureObservation['locale'],
  specimenType: SpecimenType,
  alternatives: readonly string[] = [],
): FixtureObservation {
  return {
    id,
    rowId,
    text,
    alternatives,
    pageIndex: 0,
    locale: language,
    specimenType,
  };
}

function fixture(
  id: string,
  language: FixtureObservation['locale'],
  rows: readonly {
    readonly rowId: string;
    readonly label: string;
    readonly labelAlternatives?: readonly string[];
    readonly value: string;
    readonly valueAlternatives?: readonly string[];
    readonly unit: string;
    readonly interval: string;
    readonly biomarkerId: string | null;
    readonly role?: SemanticRole;
    readonly specimenType: SpecimenType;
  }[],
): SemanticEvaluationFixture {
  const observations = rows.flatMap((row) => [
    observation(
      `${row.rowId}-label`,
      row.rowId,
      row.label,
      language,
      row.specimenType,
      row.labelAlternatives,
    ),
    observation(
      `${row.rowId}-value`,
      row.rowId,
      row.value,
      language,
      row.specimenType,
      row.valueAlternatives,
    ),
    observation(`${row.rowId}-unit`, row.rowId, row.unit, language, row.specimenType),
    observation(`${row.rowId}-interval`, row.rowId, row.interval, language, row.specimenType),
  ]);
  return {
    id,
    language,
    observations,
    expected: rows.map((row) => ({
      rowId: row.rowId,
      sourceObservationIds: [
        `${row.rowId}-label`,
        `${row.rowId}-value`,
        `${row.rowId}-unit`,
        `${row.rowId}-interval`,
      ],
      sourceFactObservationIds: [
        `${row.rowId}-value`,
        `${row.rowId}-unit`,
        `${row.rowId}-interval`,
      ],
      biomarkerId: row.biomarkerId,
      role: row.role ?? 'measurement',
      specimenType: row.specimenType,
      sourceFacts: {
        valueString: row.value,
        unit: row.unit,
        referenceInterval: row.interval,
      },
    })),
  };
}

/**
 * Synthetic only. Labels intentionally resemble ordinary multilingual lab terminology, while
 * values, dates, identifiers, and laboratory names are fabricated for this benchmark.
 */
export const semanticEvaluationFixtures: readonly SemanticEvaluationFixture[] = Object.freeze([
  fixture('qwen-v1-en-mixed', 'en', [
    {
      rowId: 'en-serum-ldl',
      label: 'LDL cholesterol',
      value: '118',
      unit: 'mg/dL',
      interval: '<115',
      biomarkerId: 'biomarker.ldl_c',
      specimenType: 'serum',
    },
    {
      rowId: 'en-urine-glucose',
      label: 'Glucose',
      labelAlternatives: ['Glucose (urine)'],
      value: 'negative',
      unit: 'qualitative',
      interval: 'negative',
      biomarkerId: null,
      role: 'specimen-context',
      specimenType: 'urine',
    },
  ]),
  fixture('qwen-v1-de-mixed', 'de', [
    {
      rowId: 'de-plasma-ldl',
      label: 'LDL-Cholesterin',
      labelAlternatives: ['LDL Cholesterin'],
      value: '3,8',
      valueAlternatives: ['3.8'],
      unit: 'mmol/L',
      interval: '<3,0',
      biomarkerId: 'biomarker.ldl_c',
      specimenType: 'plasma',
    },
    {
      rowId: 'de-blood-hb',
      label: 'Hämoglobin',
      value: '14,2',
      unit: 'g/dL',
      interval: '12,0–16,0',
      biomarkerId: 'biomarker.hemoglobin',
      specimenType: 'blood',
    },
  ]),
  fixture('qwen-v1-lt-mixed', 'lt', [
    {
      rowId: 'lt-serum-ferritin',
      label: 'Feritinas',
      labelAlternatives: ['Serumo feritinas'],
      value: '42',
      unit: 'ng/mL',
      interval: '15–150',
      biomarkerId: 'biomarker.ferritin',
      specimenType: 'serum',
    },
    {
      rowId: 'lt-urine-glucose',
      label: 'Gliukozė (šlapimas)',
      value: 'neigiama',
      unit: 'qualitative',
      interval: 'neigiama',
      biomarkerId: null,
      role: 'specimen-context',
      specimenType: 'urine',
    },
  ]),
  fixture('qwen-v1-pl-mixed', 'pl', [
    {
      rowId: 'pl-blood-hct',
      label: 'Hematokryt',
      value: '42',
      unit: '%',
      interval: '36–46',
      biomarkerId: 'biomarker.hematocrit',
      specimenType: 'blood',
    },
    {
      rowId: 'pl-plasma-triglycerides',
      label: 'Triglicerydy',
      labelAlternatives: ['Triglicerydy w osoczu'],
      value: '1,7',
      valueAlternatives: ['1.7'],
      unit: 'mmol/L',
      interval: '<1,7',
      biomarkerId: 'biomarker.triglycerides',
      specimenType: 'plasma',
    },
  ]),
  fixture('qwen-v1-fr-mixed', 'fr', [
    {
      rowId: 'fr-serum-vitamin-d',
      label: 'Vitamine D totale',
      labelAlternatives: ['25-hydroxyvitamine D totale'],
      value: '31',
      unit: 'ng/mL',
      interval: '20–50',
      biomarkerId: 'biomarker.vitamin_d_total',
      specimenType: 'serum',
    },
    {
      rowId: 'fr-urine-glucose',
      label: 'Glucose urinaire',
      value: 'négatif',
      unit: 'qualitative',
      interval: 'négatif',
      biomarkerId: null,
      role: 'specimen-context',
      specimenType: 'urine',
    },
  ]),
  fixture('qwen-v1-es-mixed', 'es', [
    {
      rowId: 'es-plasma-b12',
      label: 'Vitamina B12 total',
      labelAlternatives: ['Cobalamina'],
      value: '410',
      unit: 'pg/mL',
      interval: '200–900',
      biomarkerId: 'biomarker.vitamin_b12_total',
      specimenType: 'plasma',
    },
    {
      rowId: 'es-blood-ast',
      label: 'AST',
      value: '22',
      unit: 'U/L',
      interval: '<35',
      biomarkerId: 'biomarker.ast',
      specimenType: 'blood',
    },
  ]),
]);

export function fixtureById(id: string): SemanticEvaluationFixture | null {
  return semanticEvaluationFixtures.find((candidate) => candidate.id === id) ?? null;
}
