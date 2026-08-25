/**
 * Synthetic OCR observations for the blood-count and liver-enzyme extraction journey.
 *
 * These rows are deliberately document-shaped inputs, not screenshots or copies of a person's
 * report. The production mobile test decodes them as Vision output, groups them by table/row,
 * and resolves them through the running catalogue alias and method-policy projection.
 */

export type BloodLiverFixtureSpecimen = 'blood' | 'serum' | 'plasma' | 'urine' | 'unknown';

export type BloodLiverOCRObservation = {
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

export type BloodLiverExpectedMeasurement = {
  readonly observationId: string;
  readonly biomarkerId: string;
  readonly specimenType: BloodLiverFixtureSpecimen;
  readonly value: number;
  readonly valueString: string;
  readonly unit: string;
  readonly referenceInterval: string;
  /** Source-only laboratory context printed with the row, when present. */
  readonly sourceContext?: string;
  /** Source-only laboratory flag; Alyte must preserve it without interpreting it. */
  readonly flag?: string | null;
  readonly canonicalUnit: string;
  readonly normalizedValue: number;
};

export type BloodLiverExpectedReview = {
  readonly observationId: string;
  readonly biomarkerId: string | null;
  readonly specimenType: BloodLiverFixtureSpecimen;
  readonly reason:
    'incompatible-method' | 'incompatible-unit' | 'incompatible-specimen' | 'ambiguous-assay';
};

export type BloodLiverLabReportFixture = {
  readonly id: string;
  readonly locale: 'en-US' | 'de-DE' | 'lt-LT';
  readonly collectionDateText: string;
  readonly expectedCollectionDate: string;
  readonly observations: readonly BloodLiverOCRObservation[];
  readonly expected: {
    readonly credible: readonly BloodLiverExpectedMeasurement[];
    readonly needsReview: readonly BloodLiverExpectedReview[];
    readonly excludedObservationIds: readonly string[];
    readonly specimenContexts: readonly {
      readonly tableId: string;
      readonly specimenType: BloodLiverFixtureSpecimen;
      readonly observationIds: readonly string[];
    }[];
  };
};

type ReportRow = {
  readonly id: string;
  readonly text: string;
  readonly tableId: string;
};

function observation(row: ReportRow, rowIndex: number, language: string): BloodLiverOCRObservation {
  return {
    id: row.id,
    text: row.text,
    alternatives: [],
    boundingBox: { x: 0.06, y: 0.02 + rowIndex * 0.04, width: 0.88, height: 0.025 },
    pageIndex: 0,
    orientation: 0,
    structure: {
      kind: 'table-cell',
      tableId: row.tableId,
      rowIndex,
      columnIndex: 0,
    },
    recognition: { level: 'accurate', language, internalConfidence: null },
  };
}

function report(
  input: Omit<BloodLiverLabReportFixture, 'observations'> & {
    readonly rows: readonly ReportRow[];
  },
): BloodLiverLabReportFixture {
  return Object.freeze({
    id: input.id,
    locale: input.locale,
    collectionDateText: input.collectionDateText,
    expectedCollectionDate: input.expectedCollectionDate,
    observations: Object.freeze(
      input.rows.map((row, rowIndex) => observation(row, rowIndex, input.locale)),
    ),
    expected: input.expected,
  });
}

const cbcBlood = 'cbc-blood';
const liverSerum = 'liver-serum';
const liverPlasma = 'liver-plasma';

/**
 * Complete six-biomarker report set. The three reports intentionally vary source language,
 * decimal separator, Hb/Hct units, and serum/plasma context while keeping enzyme metadata in the
 * explicit IFCC profile required by the production catalogue.
 */
export const bloodLiverLabReportFixtures: readonly BloodLiverLabReportFixture[] = Object.freeze([
  report({
    id: 'blood-liver-report-en-us-v1',
    locale: 'en-US',
    collectionDateText: '08/20/2026',
    expectedCollectionDate: '2026-08-20',
    rows: [
      {
        id: 'en-collection-date',
        text: 'Collection date 08/20/2026',
        tableId: 'metadata',
      },
      { id: 'en-cbc-header', text: 'Complete Blood Count · Whole blood', tableId: cbcBlood },
      {
        id: 'en-hemoglobin',
        text: 'Hemoglobin · Synthetic Lab A · adult male 14.2 g/dL 13.5-17.5',
        tableId: cbcBlood,
      },
      { id: 'en-hematocrit', text: 'Hematocrit 42.6 % 40-52 H', tableId: cbcBlood },
      { id: 'en-mcv', text: 'MCV 88.5 fL 80-100', tableId: cbcBlood },
      { id: 'en-liver-header', text: 'Liver enzymes · Serum', tableId: liverSerum },
      {
        id: 'en-alt',
        text: 'ALT IFCC 37 C with P5P 24 U/L 7-56',
        tableId: liverSerum,
      },
      {
        id: 'en-ast',
        text: 'AST IFCC 37 C with P5P 22 U/L 10-40',
        tableId: liverSerum,
      },
      {
        id: 'en-ggt',
        text: 'GGT IFCC 37 C with P5P 18 U/L 9-48',
        tableId: liverSerum,
      },
      {
        id: 'en-footer',
        text: 'Synthetic report · Page 1 of 1 · synthetic.example',
        tableId: 'footer',
      },
    ],
    expected: {
      credible: [
        {
          observationId: 'en-hemoglobin',
          biomarkerId: 'biomarker.hemoglobin',
          specimenType: 'blood',
          value: 14.2,
          valueString: '14.2',
          unit: 'g/dL',
          referenceInterval: '13.5-17.5',
          sourceContext: 'Synthetic Lab A · adult male',
          canonicalUnit: 'g/dL',
          normalizedValue: 14.2,
        },
        {
          observationId: 'en-hematocrit',
          biomarkerId: 'biomarker.hematocrit',
          specimenType: 'blood',
          value: 42.6,
          valueString: '42.6',
          unit: '%',
          referenceInterval: '40-52',
          flag: 'H',
          canonicalUnit: '%',
          normalizedValue: 42.6,
        },
        {
          observationId: 'en-mcv',
          biomarkerId: 'biomarker.mcv',
          specimenType: 'blood',
          value: 88.5,
          valueString: '88.5',
          unit: 'fL',
          referenceInterval: '80-100',
          canonicalUnit: 'fL',
          normalizedValue: 88.5,
        },
        {
          observationId: 'en-alt',
          biomarkerId: 'biomarker.alt',
          specimenType: 'serum',
          value: 24,
          valueString: '24',
          unit: 'U/L',
          referenceInterval: '7-56',
          canonicalUnit: 'U/L',
          normalizedValue: 24,
        },
        {
          observationId: 'en-ast',
          biomarkerId: 'biomarker.ast',
          specimenType: 'serum',
          value: 22,
          valueString: '22',
          unit: 'U/L',
          referenceInterval: '10-40',
          canonicalUnit: 'U/L',
          normalizedValue: 22,
        },
        {
          observationId: 'en-ggt',
          biomarkerId: 'biomarker.ggt',
          specimenType: 'serum',
          value: 18,
          valueString: '18',
          unit: 'U/L',
          referenceInterval: '9-48',
          canonicalUnit: 'U/L',
          normalizedValue: 18,
        },
      ],
      needsReview: [],
      excludedObservationIds: [
        'en-collection-date',
        'en-cbc-header',
        'en-liver-header',
        'en-footer',
      ],
      specimenContexts: [
        {
          tableId: cbcBlood,
          specimenType: 'blood',
          observationIds: ['en-cbc-header', 'en-hemoglobin', 'en-hematocrit', 'en-mcv'],
        },
        {
          tableId: liverSerum,
          specimenType: 'serum',
          observationIds: ['en-liver-header', 'en-alt', 'en-ast', 'en-ggt'],
        },
        { tableId: 'footer', specimenType: 'unknown', observationIds: ['en-footer'] },
      ],
    },
  }),
  report({
    id: 'blood-liver-report-de-eu-v1',
    locale: 'de-DE',
    collectionDateText: '21.08.2026',
    expectedCollectionDate: '2026-08-21',
    rows: [
      {
        id: 'de-collection-date',
        text: 'Probenentnahme 21.08.2026',
        tableId: 'metadata',
      },
      { id: 'de-lab-context', text: 'Synthetic Lab B · adult female', tableId: cbcBlood },
      { id: 'de-cbc-header', text: 'Blutbild · Vollblut', tableId: cbcBlood },
      {
        id: 'de-hemoglobin',
        text: 'Hämoglobin 142 g/L 135-175',
        tableId: cbcBlood,
      },
      {
        id: 'de-hematocrit',
        text: 'Hämatokrit 0,426 L/L 0,400-0,520',
        tableId: cbcBlood,
      },
      {
        id: 'de-mcv',
        text: 'Mittleres korpuskuläres Volumen 88,5 fL 80-100',
        tableId: cbcBlood,
      },
      { id: 'de-liver-header', text: 'Leberenzyme · Plasma', tableId: liverPlasma },
      {
        id: 'de-alt',
        text: 'ALAT IFCC 37 C with P5P 24,0 U/L 7-56 H',
        tableId: liverPlasma,
      },
      {
        id: 'de-ast',
        text: 'ASAT IFCC 37 C with P5P 21,5 U/L 10-40',
        tableId: liverPlasma,
      },
      {
        id: 'de-ggt',
        text: 'Gamma-GT IFCC 37 C with P5P 17,0 U/L 9-48',
        tableId: liverPlasma,
      },
      {
        id: 'de-footer',
        text: 'Synthetischer Befund · Seite 1 von 1 · synthetic.example',
        tableId: 'footer',
      },
    ],
    expected: {
      credible: [
        {
          observationId: 'de-hemoglobin',
          biomarkerId: 'biomarker.hemoglobin',
          specimenType: 'blood',
          value: 142,
          valueString: '142',
          unit: 'g/L',
          referenceInterval: '135-175',
          sourceContext: 'Synthetic Lab B · adult female',
          canonicalUnit: 'g/dL',
          normalizedValue: 14.2,
        },
        {
          observationId: 'de-hematocrit',
          biomarkerId: 'biomarker.hematocrit',
          specimenType: 'blood',
          value: 0.426,
          valueString: '0,426',
          unit: 'L/L',
          referenceInterval: '0,400-0,520',
          canonicalUnit: '%',
          normalizedValue: 42.6,
        },
        {
          observationId: 'de-mcv',
          biomarkerId: 'biomarker.mcv',
          specimenType: 'blood',
          value: 88.5,
          valueString: '88,5',
          unit: 'fL',
          referenceInterval: '80-100',
          canonicalUnit: 'fL',
          normalizedValue: 88.5,
        },
        {
          observationId: 'de-alt',
          biomarkerId: 'biomarker.alt',
          specimenType: 'plasma',
          value: 24,
          valueString: '24,0',
          unit: 'U/L',
          referenceInterval: '7-56',
          flag: 'H',
          canonicalUnit: 'U/L',
          normalizedValue: 24,
        },
        {
          observationId: 'de-ast',
          biomarkerId: 'biomarker.ast',
          specimenType: 'plasma',
          value: 21.5,
          valueString: '21,5',
          unit: 'U/L',
          referenceInterval: '10-40',
          canonicalUnit: 'U/L',
          normalizedValue: 21.5,
        },
        {
          observationId: 'de-ggt',
          biomarkerId: 'biomarker.ggt',
          specimenType: 'plasma',
          value: 17,
          valueString: '17,0',
          unit: 'U/L',
          referenceInterval: '9-48',
          canonicalUnit: 'U/L',
          normalizedValue: 17,
        },
      ],
      needsReview: [],
      excludedObservationIds: [
        'de-collection-date',
        'de-lab-context',
        'de-cbc-header',
        'de-liver-header',
        'de-footer',
      ],
      specimenContexts: [
        {
          tableId: cbcBlood,
          specimenType: 'blood',
          observationIds: [
            'de-lab-context',
            'de-cbc-header',
            'de-hemoglobin',
            'de-hematocrit',
            'de-mcv',
          ],
        },
        {
          tableId: liverPlasma,
          specimenType: 'plasma',
          observationIds: ['de-liver-header', 'de-alt', 'de-ast', 'de-ggt'],
        },
        { tableId: 'footer', specimenType: 'unknown', observationIds: ['de-footer'] },
      ],
    },
  }),
  report({
    id: 'blood-liver-report-lt-eu-v1',
    locale: 'lt-LT',
    collectionDateText: '22.08.2026',
    expectedCollectionDate: '2026-08-22',
    rows: [
      {
        id: 'lt-collection-date',
        text: 'Mėginio paėmimo data 22.08.2026',
        tableId: 'metadata',
      },
      { id: 'lt-cbc-header', text: 'Bendras kraujo tyrimas · Kraujas', tableId: cbcBlood },
      {
        id: 'lt-hemoglobin',
        text: 'Hemoglobinas · Synthetic Lab C · adult 141 g/L 130-170',
        tableId: cbcBlood,
      },
      {
        id: 'lt-hematocrit',
        text: 'Hematokritas 0,425 L/L 0,390-0,510',
        tableId: cbcBlood,
      },
      {
        id: 'lt-mcv',
        text: 'Vidutinis eritrocitų tūris 89 fL 80-100',
        tableId: cbcBlood,
      },
      { id: 'lt-liver-header', text: 'Kepenų fermentai · Serumas', tableId: liverSerum },
      {
        id: 'lt-alt',
        text: 'ALAT IFCC 37 C with P5P 23,4 U/L 7-56',
        tableId: liverSerum,
      },
      {
        id: 'lt-ast',
        text: 'ASAT IFCC 37 C with P5P 20,8 U/L 10-40',
        tableId: liverSerum,
      },
      {
        id: 'lt-ggt',
        text: 'Gama glutamil transferase IFCC 37 C with P5P 16,2 U/L 9-48 L',
        tableId: liverSerum,
      },
      {
        id: 'lt-footer',
        text: 'Sintetinė ataskaita · Puslapis 1 iš 1 · synthetic.example',
        tableId: 'footer',
      },
    ],
    expected: {
      credible: [
        {
          observationId: 'lt-hemoglobin',
          biomarkerId: 'biomarker.hemoglobin',
          specimenType: 'blood',
          value: 141,
          valueString: '141',
          unit: 'g/L',
          referenceInterval: '130-170',
          sourceContext: 'Synthetic Lab C · adult',
          canonicalUnit: 'g/dL',
          normalizedValue: 14.1,
        },
        {
          observationId: 'lt-hematocrit',
          biomarkerId: 'biomarker.hematocrit',
          specimenType: 'blood',
          value: 0.425,
          valueString: '0,425',
          unit: 'L/L',
          referenceInterval: '0,390-0,510',
          canonicalUnit: '%',
          normalizedValue: 42.5,
        },
        {
          observationId: 'lt-mcv',
          biomarkerId: 'biomarker.mcv',
          specimenType: 'blood',
          value: 89,
          valueString: '89',
          unit: 'fL',
          referenceInterval: '80-100',
          canonicalUnit: 'fL',
          normalizedValue: 89,
        },
        {
          observationId: 'lt-alt',
          biomarkerId: 'biomarker.alt',
          specimenType: 'serum',
          value: 23.4,
          valueString: '23,4',
          unit: 'U/L',
          referenceInterval: '7-56',
          canonicalUnit: 'U/L',
          normalizedValue: 23.4,
        },
        {
          observationId: 'lt-ast',
          biomarkerId: 'biomarker.ast',
          specimenType: 'serum',
          value: 20.8,
          valueString: '20,8',
          unit: 'U/L',
          referenceInterval: '10-40',
          canonicalUnit: 'U/L',
          normalizedValue: 20.8,
        },
        {
          observationId: 'lt-ggt',
          biomarkerId: 'biomarker.ggt',
          specimenType: 'serum',
          value: 16.2,
          valueString: '16,2',
          unit: 'U/L',
          referenceInterval: '9-48',
          flag: 'L',
          canonicalUnit: 'U/L',
          normalizedValue: 16.2,
        },
      ],
      needsReview: [],
      excludedObservationIds: [
        'lt-collection-date',
        'lt-cbc-header',
        'lt-liver-header',
        'lt-footer',
      ],
      specimenContexts: [
        {
          tableId: cbcBlood,
          specimenType: 'blood',
          observationIds: ['lt-cbc-header', 'lt-hemoglobin', 'lt-hematocrit', 'lt-mcv'],
        },
        {
          tableId: liverSerum,
          specimenType: 'serum',
          observationIds: ['lt-liver-header', 'lt-alt', 'lt-ast', 'lt-ggt'],
        },
        { tableId: 'footer', specimenType: 'unknown', observationIds: ['lt-footer'] },
      ],
    },
  }),
]);

/**
 * Safety rows stay in the Extraction Draft for focused review or are filtered as document
 * furniture. They deliberately exercise unknown and incompatible specimens, an incompatible
 * unit, sibling aliases, incomplete enzyme metadata, and an unsafe method marker.
 */
export const bloodLiverSafetyReportFixture: BloodLiverLabReportFixture = report({
  id: 'blood-liver-report-safety-v1',
  locale: 'en-US',
  collectionDateText: '08/23/2026',
  expectedCollectionDate: '2026-08-23',
  rows: [
    {
      id: 'safety-collection-date',
      text: 'Collection date 08/23/2026',
      tableId: 'metadata',
    },
    {
      id: 'safety-unknown-header',
      text: 'Additional result · specimen not stated',
      tableId: 'unknown-section',
    },
    { id: 'safety-unknown-mcv', text: 'MCV 91 fL 80-100', tableId: 'unknown-section' },
    { id: 'safety-urine-header', text: 'Urine microscopy', tableId: 'urine-section' },
    {
      id: 'safety-urine-hemoglobin',
      text: 'Hemoglobin 14 g/dL 12-18',
      tableId: 'urine-section',
    },
    { id: 'safety-unit-header', text: 'CBC unit exception · Blood', tableId: 'unit-section' },
    { id: 'safety-blood-mcv', text: 'MCV 92 fL 80-100', tableId: 'unit-section' },
    {
      id: 'safety-incompatible-unit',
      text: 'Hematocrit 42 mg/dL 40-52',
      tableId: 'unit-section',
    },
    {
      id: 'safety-method-header',
      text: 'Liver enzyme method review · Serum',
      tableId: 'method-section',
    },
    {
      id: 'safety-ambiguous-sibling',
      text: 'ALT / AST IFCC 37 C with P5P 20 U/L 7-56',
      tableId: 'method-section',
    },
    {
      id: 'safety-plasma-header',
      text: 'Additional enzyme result · Plasma',
      tableId: 'plasma-section',
    },
    {
      id: 'safety-plasma-ggt',
      text: 'GGT IFCC 37 C with P5P 19 U/L 9-48',
      tableId: 'plasma-section',
    },
    {
      id: 'safety-incomplete-alt-method',
      text: 'ALT IFCC 37 C 22 U/L 7-56',
      tableId: 'method-section',
    },
    {
      id: 'safety-incompatible-ast-unit',
      text: 'AST IFCC 37 C with P5P 20 mmol/L 10-40',
      tableId: 'method-section',
    },
    {
      id: 'safety-unsafe-ggt-method',
      text: 'GGT IFCC 37 C with P5P legacy 18 U/L 9-48',
      tableId: 'method-section',
    },
    {
      id: 'safety-footer',
      text: 'Synthetic report · Page 1 of 1 · synthetic.example',
      tableId: 'footer',
    },
  ],
  expected: {
    credible: [
      {
        observationId: 'safety-unknown-mcv',
        biomarkerId: 'biomarker.mcv',
        specimenType: 'unknown',
        value: 91,
        valueString: '91',
        unit: 'fL',
        referenceInterval: '80-100',
        canonicalUnit: 'fL',
        normalizedValue: 91,
      },
      {
        observationId: 'safety-blood-mcv',
        biomarkerId: 'biomarker.mcv',
        specimenType: 'blood',
        value: 92,
        valueString: '92',
        unit: 'fL',
        referenceInterval: '80-100',
        canonicalUnit: 'fL',
        normalizedValue: 92,
      },
      {
        observationId: 'safety-plasma-ggt',
        biomarkerId: 'biomarker.ggt',
        specimenType: 'plasma',
        value: 19,
        valueString: '19',
        unit: 'U/L',
        referenceInterval: '9-48',
        canonicalUnit: 'U/L',
        normalizedValue: 19,
      },
    ],
    needsReview: [
      {
        observationId: 'safety-urine-hemoglobin',
        biomarkerId: 'biomarker.hemoglobin',
        specimenType: 'urine',
        reason: 'incompatible-specimen',
      },
      {
        observationId: 'safety-incompatible-unit',
        biomarkerId: 'biomarker.hematocrit',
        specimenType: 'blood',
        reason: 'incompatible-unit',
      },
      {
        observationId: 'safety-ambiguous-sibling',
        biomarkerId: null,
        specimenType: 'serum',
        reason: 'ambiguous-assay',
      },
      {
        observationId: 'safety-incomplete-alt-method',
        biomarkerId: 'biomarker.alt',
        specimenType: 'serum',
        reason: 'incompatible-method',
      },
      {
        observationId: 'safety-incompatible-ast-unit',
        biomarkerId: 'biomarker.ast',
        specimenType: 'serum',
        reason: 'incompatible-unit',
      },
      {
        observationId: 'safety-unsafe-ggt-method',
        biomarkerId: null,
        specimenType: 'serum',
        reason: 'ambiguous-assay',
      },
    ],
    excludedObservationIds: [
      'safety-unknown-header',
      'safety-urine-header',
      'safety-unit-header',
      'safety-method-header',
      'safety-plasma-header',
      'safety-footer',
      'safety-collection-date',
    ],
    specimenContexts: [
      {
        tableId: 'unknown-section',
        specimenType: 'unknown',
        observationIds: ['safety-unknown-header', 'safety-unknown-mcv'],
      },
      {
        tableId: 'urine-section',
        specimenType: 'urine',
        observationIds: ['safety-urine-header', 'safety-urine-hemoglobin'],
      },
      {
        tableId: 'unit-section',
        specimenType: 'blood',
        observationIds: ['safety-unit-header', 'safety-blood-mcv', 'safety-incompatible-unit'],
      },
      {
        tableId: 'method-section',
        specimenType: 'serum',
        observationIds: [
          'safety-method-header',
          'safety-ambiguous-sibling',
          'safety-incomplete-alt-method',
          'safety-incompatible-ast-unit',
          'safety-unsafe-ggt-method',
        ],
      },
      {
        tableId: 'plasma-section',
        specimenType: 'plasma',
        observationIds: ['safety-plasma-header', 'safety-plasma-ggt'],
      },
      {
        tableId: 'metadata',
        specimenType: 'unknown',
        observationIds: ['safety-collection-date'],
      },
      { tableId: 'footer', specimenType: 'unknown', observationIds: ['safety-footer'] },
    ],
  },
});
