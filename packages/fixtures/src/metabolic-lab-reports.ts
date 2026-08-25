/**
 * Synthetic OCR observations for the metabolic/micronutrient extraction journey.
 *
 * These are de-identified document-shaped inputs, not screenshots or copies of a person's
 * report. Keep the fixture text close to what Vision returns so extraction tests exercise the
 * production parser and catalogue aliases rather than a fixture-only adapter.
 */

export type SyntheticLabSpecimen = 'blood' | 'serum' | 'plasma';

export type SyntheticOCRObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pageIndex: 0;
  readonly orientation: 0;
  readonly structure: {
    readonly kind: 'table-cell';
    readonly tableId: string;
    readonly rowIndex: number;
    readonly columnIndex: 0;
  };
  readonly recognition: {
    readonly level: 'accurate';
    readonly language: string;
    readonly internalConfidence: null;
  };
};

export type MetabolicLabReportFixture = {
  readonly id: string;
  readonly locale: 'en-US' | 'de-DE' | 'lt-LT';
  readonly specimenType: SyntheticLabSpecimen;
  readonly collectionDateText: string;
  readonly observations: readonly SyntheticOCRObservation[];
  readonly expected: {
    readonly credible: readonly {
      readonly observationId: string;
      readonly biomarkerId: string;
    }[];
    readonly needsReview: readonly {
      readonly observationId: string;
      readonly biomarkerId: string | null;
      readonly reason: 'incompatible-method' | 'ambiguous-assay';
    }[];
    readonly excludedObservationIds: readonly string[];
  };
};

function observation(
  id: string,
  text: string,
  rowIndex: number,
  language: string,
): SyntheticOCRObservation {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x: 0.06, y: 0.02 + rowIndex * 0.1, width: 0.88, height: 0.04 },
    pageIndex: 0,
    orientation: 0,
    structure: {
      kind: 'table-cell',
      tableId: 'synthetic-results',
      rowIndex,
      columnIndex: 0,
    },
    recognition: { level: 'accurate', language, internalConfidence: null },
  };
}

function report(
  fixture: Omit<MetabolicLabReportFixture, 'observations'> & {
    readonly rows: readonly {
      readonly id: string;
      readonly text: string;
    }[];
  },
): MetabolicLabReportFixture {
  return Object.freeze({
    id: fixture.id,
    locale: fixture.locale,
    specimenType: fixture.specimenType,
    collectionDateText: fixture.collectionDateText,
    observations: Object.freeze(
      fixture.rows.map((row, index) => observation(row.id, row.text, index, fixture.locale)),
    ),
    expected: fixture.expected,
  });
}

/**
 * The set covers all five families across realistic specimen contexts, US/EU units, and decimal
 * separators. The extra German rows are deliberately measurement-shaped exceptions: local
 * extraction must preserve them for review, but must not silently treat them as comparable
 * measurements.
 */
export const metabolicLabReportFixtures: readonly MetabolicLabReportFixture[] = Object.freeze([
  report({
    id: 'metabolic-report-en-v1',
    locale: 'en-US',
    specimenType: 'blood',
    collectionDateText: '08/20/2026',
    rows: [
      { id: 'en-header', text: 'Synthetic Diagnostics · Patient: DE-IDENTIFIED' },
      { id: 'en-glucose', text: 'Glucose 126 mg/dL 70-99' },
      // A1c is the unambiguous short alias; the generic `Hb` alias is intentionally not combined
      // with it because production extraction preserves overlapping identities for review.
      { id: 'en-hba1c', text: 'A1c 5.8 % 4.0-5.6 NGSP' },
      { id: 'en-footer', text: 'Synthetic report · Page 1 of 1 · synthetic.example' },
    ],
    expected: {
      credible: [
        { observationId: 'en-glucose', biomarkerId: 'biomarker.glucose' },
        { observationId: 'en-hba1c', biomarkerId: 'biomarker.hba1c' },
      ],
      needsReview: [],
      excludedObservationIds: ['en-header', 'en-footer'],
    },
  }),
  report({
    id: 'metabolic-report-de-v1',
    locale: 'de-DE',
    specimenType: 'serum',
    collectionDateText: '20.08.2026',
    rows: [
      { id: 'de-header', text: 'Synthetisches Labor · Material: Serum' },
      { id: 'de-glucose', text: 'Glukose 6,4 mmol/L 3,9-5,5' },
      { id: 'de-ferritin', text: 'Ferritin 58 µg/L 15-150' },
      {
        id: 'de-vitamin-d',
        text: '25-Hydroxyvitamin D LC-MS/MS 72 nmol/L 50-125',
      },
      { id: 'de-vitamin-b12', text: 'Vitamin B12 ECLIA 510 pmol/L 150-700' },
      { id: 'de-vitamin-d-missing-method', text: '25-OH Vitamin D 28 nmol/L 50-125' },
      { id: 'de-vitamin-d3', text: 'Vitamin D3 18 nmol/L 50-125' },
      { id: 'de-footer', text: 'Synthetischer Befund · Seite 1 von 1 · synthetic.example' },
    ],
    expected: {
      credible: [
        { observationId: 'de-glucose', biomarkerId: 'biomarker.glucose' },
        { observationId: 'de-ferritin', biomarkerId: 'biomarker.ferritin' },
        { observationId: 'de-vitamin-d', biomarkerId: 'biomarker.vitamin_d_total' },
        { observationId: 'de-vitamin-b12', biomarkerId: 'biomarker.vitamin_b12_total' },
      ],
      needsReview: [
        {
          observationId: 'de-vitamin-d-missing-method',
          biomarkerId: 'biomarker.vitamin_d_total',
          reason: 'incompatible-method',
        },
        { observationId: 'de-vitamin-d3', biomarkerId: null, reason: 'ambiguous-assay' },
      ],
      excludedObservationIds: ['de-header', 'de-footer'],
    },
  }),
  report({
    id: 'metabolic-report-lt-v1',
    locale: 'lt-LT',
    specimenType: 'serum',
    collectionDateText: '20.08.2026',
    rows: [
      { id: 'lt-header', text: 'Sintetinė laboratorija · Mėginys: kraujo serumas' },
      { id: 'lt-glucose', text: 'Gliukozė 5,7 mmol/L 4,1-5,9' },
      { id: 'lt-ferritin', text: 'Ferritin 44 µg/L 15-150' },
      {
        id: 'lt-vitamin-d',
        text: '25-hidroksivitaminas D LC-MS/MS 68 nmol/L 50-125',
      },
      { id: 'lt-vitamin-b12', text: 'Kobalamina ECLIA 390 pmol/L 150-700' },
      { id: 'lt-footer', text: 'Sintetinė ataskaita · Puslapis 1 iš 1 · synthetic.example' },
    ],
    expected: {
      credible: [
        { observationId: 'lt-glucose', biomarkerId: 'biomarker.glucose' },
        { observationId: 'lt-ferritin', biomarkerId: 'biomarker.ferritin' },
        { observationId: 'lt-vitamin-d', biomarkerId: 'biomarker.vitamin_d_total' },
        { observationId: 'lt-vitamin-b12', biomarkerId: 'biomarker.vitamin_b12_total' },
      ],
      needsReview: [],
      excludedObservationIds: ['lt-header', 'lt-footer'],
    },
  }),
]);
