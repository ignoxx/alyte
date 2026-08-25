type FixtureRuntimeVariant = 'development' | 'preview' | 'production';

export interface ShowcaseSnapshot {
  readonly fixtureId: 'showcase.synthetic.v1';
  readonly label: 'Synthetic showcase data';
  readonly records: readonly ['Synthetic lab report', 'Synthetic intake event'];
  readonly intakeEvents: readonly [
    {
      readonly id: 'showcase-intake-breakfast';
      readonly eventType: 'food';
      readonly name: 'Synthetic breakfast';
      readonly localTime: '09:00';
    },
    {
      readonly id: 'showcase-intake-drink';
      readonly eventType: 'drink';
      readonly name: 'Synthetic drink';
      readonly localTime: '12:00';
    },
  ];
}

const SYNTHETIC_RECORDS = Object.freeze([
  'Synthetic lab report',
  'Synthetic intake event',
] as const);

const SYNTHETIC_SNAPSHOT: ShowcaseSnapshot = Object.freeze({
  fixtureId: 'showcase.synthetic.v1',
  label: 'Synthetic showcase data',
  records: SYNTHETIC_RECORDS,
  intakeEvents: Object.freeze([
    {
      id: 'showcase-intake-breakfast',
      eventType: 'food',
      name: 'Synthetic breakfast',
      localTime: '09:00',
    },
    {
      id: 'showcase-intake-drink',
      eventType: 'drink',
      name: 'Synthetic drink',
      localTime: '12:00',
    },
  ] as const),
});

export function loadShowcaseSnapshot(
  variant: FixtureRuntimeVariant,
  requested: boolean,
): ShowcaseSnapshot | null {
  if (!requested) {
    return null;
  }

  if (variant === 'production') {
    throw new Error('Showcase data is disabled in production builds');
  }

  return SYNTHETIC_SNAPSHOT;
}

/** Synthetic document rows only; no fixture originates from a person's report. */
export const multilingualLabTableFixtures = Object.freeze({
  lt: Object.freeze([
    'UAB Sintetinė laboratorija  Įmonės kodas 000000000',
    'Mėginio paėmimo data 20.08.2026  Kraujo serumas',
    'Mažo tankio lipoproteinų cholesterolis  3,8  mmol/L  <3,0  H',
    'Nežinomas žymuo  <0,5  µg/L  0,1–0,7',
    'Licencija Nr. 0000  synthetic.example',
  ]),
  en: Object.freeze(['Collection date 20.08.2026', 'LDL cholesterol 118 mg/dL <115 H']),
  de: Object.freeze(['Probenentnahme 20.08.2026', 'LDL-Cholesterin 3,8 mmol/L <3,0 H']),
});

export {
  metabolicLabReportFixtures,
  mixedSpecimenMetabolicLabReportFixture,
  type MetabolicLabReportFixture,
  type SyntheticOCRObservation,
  type SyntheticLabSpecimen,
} from './metabolic-lab-reports';
export {
  bloodLiverLabReportFixtures,
  bloodLiverSafetyReportFixture,
  type BloodLiverExpectedMeasurement,
  type BloodLiverExpectedReview,
  type BloodLiverFixtureSpecimen,
  type BloodLiverLabReportFixture,
  type BloodLiverOCRObservation,
} from './blood-liver-lab-reports';
