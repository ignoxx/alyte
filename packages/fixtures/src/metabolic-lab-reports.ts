/**
 * Synthetic OCR observations for the metabolic/micronutrient extraction journey.
 *
 * These are de-identified document-shaped inputs, not screenshots or copies of a person's
 * report. Keep the fixture text close to what Vision returns so extraction tests exercise the
 * production parser and catalogue aliases rather than a fixture-only adapter.
 */

export type SyntheticLabSpecimen = 'blood' | 'serum' | 'plasma' | 'urine' | 'unknown';

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
      readonly value: number;
      readonly valueString: string;
      readonly unit: string;
      readonly referenceInterval: string;
      readonly canonicalUnit: string;
      readonly normalizedValue: number;
    }[];
    readonly needsReview: readonly {
      readonly observationId: string;
      readonly biomarkerId: string | null;
      readonly reason: 'incompatible-method' | 'ambiguous-assay' | 'incompatible-specimen';
    }[];
    readonly excludedObservationIds: readonly string[];
    readonly specimenContexts?: readonly {
      readonly tableId: string;
      readonly specimenType: SyntheticLabSpecimen;
      readonly observationIds: readonly string[];
    }[];
  };
};

function observation(
  id: string,
  text: string,
  rowIndex: number,
  language: string,
  tableId: string,
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
      tableId,
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
      readonly tableId?: string;
    }[];
  },
): MetabolicLabReportFixture {
  return Object.freeze({
    id: fixture.id,
    locale: fixture.locale,
    specimenType: fixture.specimenType,
    collectionDateText: fixture.collectionDateText,
    observations: Object.freeze(
      fixture.rows.map((row, index) =>
        observation(row.id, row.text, index, fixture.locale, row.tableId ?? 'synthetic-results'),
      ),
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
        {
          observationId: 'en-glucose',
          biomarkerId: 'biomarker.glucose',
          value: 126,
          valueString: '126',
          unit: 'mg/dL',
          referenceInterval: '70-99',
          canonicalUnit: 'mg/dL',
          normalizedValue: 126,
        },
        {
          observationId: 'en-hba1c',
          biomarkerId: 'biomarker.hba1c',
          value: 5.8,
          valueString: '5.8',
          unit: '%',
          referenceInterval: '4.0-5.6',
          canonicalUnit: '%',
          normalizedValue: 5.8,
        },
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
        {
          observationId: 'de-glucose',
          biomarkerId: 'biomarker.glucose',
          value: 6.4,
          valueString: '6,4',
          unit: 'mmol/L',
          referenceInterval: '3,9-5,5',
          canonicalUnit: 'mg/dL',
          normalizedValue: 115.31531531531532,
        },
        {
          observationId: 'de-ferritin',
          biomarkerId: 'biomarker.ferritin',
          value: 58,
          valueString: '58',
          unit: 'µg/L',
          referenceInterval: '15-150',
          canonicalUnit: 'ng/mL',
          normalizedValue: 58,
        },
        {
          observationId: 'de-vitamin-d',
          biomarkerId: 'biomarker.vitamin_d_total',
          value: 72,
          valueString: '72',
          unit: 'nmol/L',
          referenceInterval: '50-125',
          canonicalUnit: 'ng/mL',
          normalizedValue: 28.8,
        },
        {
          observationId: 'de-vitamin-b12',
          biomarkerId: 'biomarker.vitamin_b12_total',
          value: 510,
          valueString: '510',
          unit: 'pmol/L',
          referenceInterval: '150-700',
          canonicalUnit: 'pg/mL',
          normalizedValue: 691.0569105691057,
        },
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
        {
          observationId: 'lt-glucose',
          biomarkerId: 'biomarker.glucose',
          value: 5.7,
          valueString: '5,7',
          unit: 'mmol/L',
          referenceInterval: '4,1-5,9',
          canonicalUnit: 'mg/dL',
          normalizedValue: 102.7027027027027,
        },
        {
          observationId: 'lt-ferritin',
          biomarkerId: 'biomarker.ferritin',
          value: 44,
          valueString: '44',
          unit: 'µg/L',
          referenceInterval: '15-150',
          canonicalUnit: 'ng/mL',
          normalizedValue: 44,
        },
        {
          observationId: 'lt-vitamin-d',
          biomarkerId: 'biomarker.vitamin_d_total',
          value: 68,
          valueString: '68',
          unit: 'nmol/L',
          referenceInterval: '50-125',
          canonicalUnit: 'ng/mL',
          normalizedValue: 27.2,
        },
        {
          observationId: 'lt-vitamin-b12',
          biomarkerId: 'biomarker.vitamin_b12_total',
          value: 390,
          valueString: '390',
          unit: 'pmol/L',
          referenceInterval: '150-700',
          canonicalUnit: 'pg/mL',
          normalizedValue: 528.4552845528455,
        },
      ],
      needsReview: [],
      excludedObservationIds: ['lt-header', 'lt-footer'],
    },
  }),
]);

/**
 * A single document can contain separate specimen sections. The fixture deliberately does not
 * provide one report-wide answer: tests resolve each table/row context and keep unknown or
 * incompatible rows visible instead of borrowing the neighboring section's specimen.
 */
export const mixedSpecimenMetabolicLabReportFixture: MetabolicLabReportFixture = report({
  id: 'metabolic-report-mixed-specimen-v1',
  locale: 'en-US',
  specimenType: 'unknown',
  collectionDateText: '08/21/2026',
  rows: [
    { id: 'mixed-serum-header', text: 'Serum section', tableId: 'serum-panel' },
    {
      id: 'mixed-serum-ferritin',
      text: 'Ferritin 42 ng/mL 15-300',
      tableId: 'serum-panel',
    },
    {
      id: 'mixed-serum-vitamin-d',
      text: 'Total 25-hydroxyvitamin D LC-MS/MS 31 ng/mL 20-50',
      tableId: 'serum-panel',
    },
    { id: 'mixed-plasma-header', text: 'Plasma section', tableId: 'plasma-panel' },
    {
      id: 'mixed-plasma-glucose',
      text: 'Glucose 5.7 mmol/L 4.0-5.9',
      tableId: 'plasma-panel',
    },
    {
      id: 'mixed-plasma-b12',
      text: 'Total vitamin B12 immunoassay 410 pg/mL 200-900',
      tableId: 'plasma-panel',
    },
    {
      id: 'mixed-unknown-glucose',
      text: 'Glucose 100 mg/dL 70-110',
      tableId: 'unknown-row',
    },
    {
      id: 'mixed-urine-glucose',
      text: 'Glucose 1.2 mmol/L 0-1',
      tableId: 'incompatible-row',
    },
    {
      id: 'mixed-footer',
      text: 'Synthetic mixed report · specimen context intentionally varied',
      tableId: 'footer',
    },
  ],
  expected: {
    credible: [
      {
        observationId: 'mixed-serum-ferritin',
        biomarkerId: 'biomarker.ferritin',
        value: 42,
        valueString: '42',
        unit: 'ng/mL',
        referenceInterval: '15-300',
        canonicalUnit: 'ng/mL',
        normalizedValue: 42,
      },
      {
        observationId: 'mixed-serum-vitamin-d',
        biomarkerId: 'biomarker.vitamin_d_total',
        value: 31,
        valueString: '31',
        unit: 'ng/mL',
        referenceInterval: '20-50',
        canonicalUnit: 'ng/mL',
        normalizedValue: 31,
      },
      {
        observationId: 'mixed-plasma-glucose',
        biomarkerId: 'biomarker.glucose',
        value: 5.7,
        valueString: '5.7',
        unit: 'mmol/L',
        referenceInterval: '4.0-5.9',
        canonicalUnit: 'mg/dL',
        normalizedValue: 102.7027027027027,
      },
      {
        observationId: 'mixed-plasma-b12',
        biomarkerId: 'biomarker.vitamin_b12_total',
        value: 410,
        valueString: '410',
        unit: 'pg/mL',
        referenceInterval: '200-900',
        canonicalUnit: 'pg/mL',
        normalizedValue: 410,
      },
      {
        observationId: 'mixed-unknown-glucose',
        biomarkerId: 'biomarker.glucose',
        value: 100,
        valueString: '100',
        unit: 'mg/dL',
        referenceInterval: '70-110',
        canonicalUnit: 'mg/dL',
        normalizedValue: 100,
      },
    ],
    needsReview: [
      {
        observationId: 'mixed-urine-glucose',
        biomarkerId: 'biomarker.glucose',
        reason: 'incompatible-specimen',
      },
    ],
    excludedObservationIds: ['mixed-serum-header', 'mixed-plasma-header', 'mixed-footer'],
    specimenContexts: [
      {
        tableId: 'serum-panel',
        specimenType: 'serum',
        observationIds: ['mixed-serum-header', 'mixed-serum-ferritin', 'mixed-serum-vitamin-d'],
      },
      {
        tableId: 'plasma-panel',
        specimenType: 'plasma',
        observationIds: ['mixed-plasma-header', 'mixed-plasma-glucose', 'mixed-plasma-b12'],
      },
      {
        tableId: 'unknown-row',
        specimenType: 'unknown',
        observationIds: ['mixed-unknown-glucose'],
      },
      {
        tableId: 'incompatible-row',
        specimenType: 'urine',
        observationIds: ['mixed-urine-glucose'],
      },
    ],
  },
});
