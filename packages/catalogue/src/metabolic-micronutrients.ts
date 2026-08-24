import {
  CATALOGUE_VERSION,
  type BiomarkerCatalogueEntry,
  type CatalogueReviewMetadata,
  type CatalogueSource,
  type GeneralGuidance,
  type UnitConversion,
} from './schema.js';

/** Sources are deliberately limited to public authorities and the HbA1c standardization body. */
export const cdcDiabetesTestingSource: CatalogueSource = {
  id: 'source.cdc.diabetes-testing',
  title: 'Diabetes Testing',
  publisher: 'Centers for Disease Control and Prevention',
  url: 'https://www.cdc.gov/diabetes/diabetes-testing/index.html',
  publicationDate: '2024-05-15',
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const niddkDiabetesConversionsSource: CatalogueSource = {
  id: 'source.niddk.diabetes-conversions',
  title: 'Diabetes in America, 3rd Edition — Appendix 1: Conversions',
  publisher: 'National Institute of Diabetes and Digestive and Kidney Diseases',
  url: 'https://www.niddk.nih.gov/-/media/Files/Strategic-Plans/Diabetes-in-America-3rd-Edition/DIA_Conversions.pdf',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const ngspIfccSource: CatalogueSource = {
  id: 'source.ngsp.ifcc-hba1c-standardization',
  title: 'IFCC Standardization Overview',
  publisher: 'National Glycohemoglobin Standardization Program',
  url: 'https://ngsp.org/ifcc.asp',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'professional-guideline',
};

export const whoFerritinSource: CatalogueSource = {
  id: 'source.who.ferritin-guideline',
  title:
    'WHO guideline on use of ferritin concentrations to assess iron status in individuals and populations',
  publisher: 'World Health Organization',
  url: 'https://www.who.int/publications/i/item/9789240000124',
  publicationDate: '2020-04-21',
  accessedAt: '2026-08-24',
  sourceKind: 'professional-guideline',
};

export const nihVitaminDSource: CatalogueSource = {
  id: 'source.nih.ods.vitamin-d-health-professional',
  title: 'Vitamin D — Health Professional Fact Sheet',
  publisher: 'National Institutes of Health, Office of Dietary Supplements',
  url: 'https://ods.od.nih.gov/factsheets/VITAMIND-HealthProfessional/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const nihVitaminB12Source: CatalogueSource = {
  id: 'source.nih.ods.vitamin-b12-health-professional',
  title: 'Vitamin B12 — Health Professional Fact Sheet',
  publisher: 'National Institutes of Health, Office of Dietary Supplements',
  url: 'https://ods.od.nih.gov/factsheets/VitaminB12-HealthProfessional/',
  publicationDate: '2025-07-02',
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

/** Unit factors are deterministic catalogue data; models never perform these conversions. */
export const metabolicSources: readonly CatalogueSource[] = [
  cdcDiabetesTestingSource,
  niddkDiabetesConversionsSource,
  ngspIfccSource,
  whoFerritinSource,
  nihVitaminDSource,
  nihVitaminB12Source,
];

export const metabolicReviewPending: CatalogueReviewMetadata = {
  status: 'pending-human-publication',
  contentVersion: CATALOGUE_VERSION,
  reviewedAt: null,
  reviewer: null,
  reviewNotes:
    'Agent-authored draft. A qualified content owner must review wording, applicability, method identity, disagreements, and sources before publication.',
};

const conversion = (
  from: string,
  to: string,
  factor: number,
  offset: number,
  sourceId: string,
): UnitConversion => ({ from, to, factor, offset, sourceId });

const guidance = (
  id: string,
  label: string,
  threshold: {
    readonly operator: '<' | '<=' | '>' | '>=';
    readonly value: number;
    readonly unit: string;
  },
  fasting: 'any' | 'fasting',
  source: CatalogueSource,
): GeneralGuidance => ({
  id,
  label,
  description:
    'A population screening comparison point from an identified public-health authority. It does not replace the laboratory interval or act as a personal target.',
  thresholds: [threshold],
  applicability: {
    population: 'adults',
    jurisdiction: 'US',
    context: 'screening',
    sex: 'all',
    fasting,
    limitations: [
      'Shown only when the adult population, US jurisdiction, and required collection context are explicit.',
      'The issuing laboratory interval and source context remain primary.',
    ],
  },
  disagreement:
    'Screening cutoffs are context-dependent and are not resolved into an individual clinical conclusion.',
  authority: source.publisher,
  publicationVersion: source.publicationDate ?? 'current-page',
  reviewDate: null,
  unit: threshold.unit,
  boundarySemantics: 'exclusive',
  sources: [source.id],
  review: metabolicReviewPending,
});

type MetabolicEntryInput = Omit<
  BiomarkerCatalogueEntry,
  | 'catalogueVersion'
  | 'canonicalLabel'
  | 'valueType'
  | 'canonicalUnit'
  | 'unitConversions'
  | 'specimenCompatibility'
  | 'explanation'
  | 'sources'
  | 'review'
  | 'generalGuidance'
> & {
  readonly canonicalLabel: string;
  readonly canonicalUnit: string;
  readonly unitConversions: readonly UnitConversion[];
  readonly specimenCompatibility: NonNullable<BiomarkerCatalogueEntry['specimenCompatibility']>;
  readonly explanation: string;
  readonly sources: readonly CatalogueSource[];
  readonly generalGuidance?: readonly GeneralGuidance[];
};

function metabolicEntry({
  generalGuidance = [],
  ...entry
}: MetabolicEntryInput): BiomarkerCatalogueEntry {
  return {
    ...entry,
    catalogueVersion: CATALOGUE_VERSION,
    valueType: 'numeric',
    canonicalLabel: entry.canonicalLabel,
    canonicalUnit: entry.canonicalUnit,
    unitConversions: entry.unitConversions,
    specimenCompatibility: entry.specimenCompatibility,
    explanation: entry.explanation,
    sources: entry.sources,
    review: metabolicReviewPending,
    generalGuidance,
  };
}

const glucoseConversionSource = niddkDiabetesConversionsSource;

const glucoseConversions: readonly UnitConversion[] = [
  conversion('mmol/L', 'mg/dL', 18, 0, glucoseConversionSource.id),
  conversion('mg/dL', 'mmol/L', 1 / 18, 0, glucoseConversionSource.id),
];

const hba1cConversions: readonly UnitConversion[] = [
  // NGSP = (0.09148 × IFCC) + 2.152, the published master equation.
  conversion('mmol/mol', '%', 0.09148, 2.152, ngspIfccSource.id),
  // Published reciprocal equation (rounded as specified by NGSP).
  conversion('%', 'mmol/mol', 10.93, -23.5, ngspIfccSource.id),
];

const ferritinConversions: readonly UnitConversion[] = [
  conversion('µg/L', 'ng/mL', 1, 0, whoFerritinSource.id),
  conversion('ng/mL', 'µg/L', 1, 0, whoFerritinSource.id),
  conversion('ug/L', 'ng/mL', 1, 0, whoFerritinSource.id),
  conversion('ng/mL', 'ug/L', 1, 0, whoFerritinSource.id),
];

const vitaminDConversions: readonly UnitConversion[] = [
  conversion('nmol/L', 'ng/mL', 0.4, 0, nihVitaminDSource.id),
  conversion('ng/mL', 'nmol/L', 2.5, 0, nihVitaminDSource.id),
];

const vitaminB12Conversions: readonly UnitConversion[] = [
  conversion('pmol/L', 'pg/mL', 1 / 0.738, 0, nihVitaminB12Source.id),
  conversion('pg/mL', 'pmol/L', 0.738, 0, nihVitaminB12Source.id),
];

export const metabolicMicronutrientBiomarkers: readonly BiomarkerCatalogueEntry[] = [
  metabolicEntry({
    id: 'biomarker.glucose',
    canonicalLabel: 'Glucose',
    aliases: [
      'glucose',
      'blood glucose',
      'blood sugar',
      'fasting glucose',
      'fasting blood glucose',
      'glukose',
      'blutzucker',
      'nüchternblutzucker',
      'glucose à jeun',
      'glycémie',
      'glucosa',
      'glicemia',
      'glucose nuchter',
      'glukoza',
      'gliukozė',
    ],
    specimens: ['blood', 'serum', 'plasma'],
    units: ['mg/dL', 'mmol/L'],
    canonicalUnit: 'mg/dL',
    unitConversions: glucoseConversions,
    specimenCompatibility: [['blood'], ['serum', 'plasma']],
    explanation:
      'Measures glucose concentration in the sampled blood. Results vary with fasting status, timing after food, specimen context, and collection conditions; the laboratory interval and source context remain important.',
    sources: [cdcDiabetesTestingSource, niddkDiabetesConversionsSource],
    generalGuidance: [
      guidance(
        'guidance.glucose.fasting-screening-us',
        'Adult fasting screening comparison point',
        { operator: '<', value: 100, unit: 'mg/dL' },
        'fasting',
        cdcDiabetesTestingSource,
      ),
    ],
  }),
  metabolicEntry({
    id: 'biomarker.hba1c',
    canonicalLabel: 'HbA1c',
    aliases: [
      'hba1c',
      'hb a1c',
      'a1c',
      'hemoglobin a1c',
      'glycated hemoglobin',
      'glycosylated hemoglobin',
      'glykiertes hämoglobin',
      'hämoglobin a1c',
      'hémoglobine glyquée',
      'hemoglobina glicosilada',
      'emoglobina glicata',
      'geglyceerd hemoglobine',
      'hemoglobina glikowana',
      'langzeitblutzucker',
    ],
    specimens: ['blood'],
    units: ['%', 'mmol/mol'],
    canonicalUnit: '%',
    unitConversions: hba1cConversions,
    specimenCompatibility: [['blood']],
    explanation:
      'Measures the proportion of hemoglobin with glucose attached and reflects an approximate prior two-to-three-month period. It is distinct from a single glucose result; hemoglobin variants and conditions affecting red-cell lifespan can affect the assay result.',
    sources: [cdcDiabetesTestingSource, ngspIfccSource],
    generalGuidance: [
      guidance(
        'guidance.hba1c.screening-us',
        'Adult HbA1c screening comparison point',
        { operator: '<', value: 5.7, unit: '%' },
        'any',
        cdcDiabetesTestingSource,
      ),
    ],
  }),
  metabolicEntry({
    id: 'biomarker.ferritin',
    canonicalLabel: 'Ferritin',
    aliases: [
      'ferritin',
      'serum ferritin',
      'plasma ferritin',
      'ferritine',
      'ferritina',
      'ferrytyna',
      'ferritine sérique',
    ],
    specimens: ['serum', 'plasma'],
    units: ['ng/mL', 'µg/L', 'ug/L'],
    canonicalUnit: 'ng/mL',
    unitConversions: ferritinConversions,
    specimenCompatibility: [['serum', 'plasma']],
    explanation:
      'Measures circulating ferritin, an iron-storage protein. Concentration can reflect iron stores but may also change with inflammation or infection, so the laboratory interval and collection context remain primary.',
    sources: [whoFerritinSource],
  }),
  metabolicEntry({
    id: 'biomarker.vitamin_d_total',
    canonicalLabel: 'Total 25-hydroxyvitamin D',
    aliases: [
      '25-oh vitamin d',
      '25-oh-vitamin d',
      '25 hydroxyvitamin d',
      '25-hydroxyvitamin d',
      '25 oh vitamin d',
      '25(oh)d',
      '25-oh d',
      'total 25-hydroxyvitamin d',
      'calcidiol',
      '25-hydroxyvitamine d',
      '25-hidroxivitamina d',
      '25-idrossivitamina d',
      '25-hydroksywitamina d',
      '25-hidroksivitaminas d',
    ],
    specimens: ['serum'],
    units: ['ng/mL', 'nmol/L'],
    canonicalUnit: 'ng/mL',
    unitConversions: vitaminDConversions,
    specimenCompatibility: [['serum']],
    explanation:
      'Measures total 25-hydroxyvitamin D [25(OH)D], the main serum indicator used when assessing vitamin D status. It is distinct from 1,25-dihydroxyvitamin D; assay variability and differing authority interpretations remain relevant.',
    sources: [nihVitaminDSource],
  }),
  metabolicEntry({
    id: 'biomarker.vitamin_b12_total',
    canonicalLabel: 'Total vitamin B12',
    aliases: [
      'vitamin b12',
      'vitamin b-12',
      'serum vitamin b12',
      'plasma vitamin b12',
      'total vitamin b12',
      'total cobalamin',
      'cobalamin',
      'vitamine b12',
      'vitamina b12',
      'vitamina b12 totale',
      'witamina b12',
      'kobalamina',
    ],
    specimens: ['serum', 'plasma'],
    units: ['pg/mL', 'pmol/L'],
    canonicalUnit: 'pg/mL',
    unitConversions: vitaminB12Conversions,
    specimenCompatibility: [['serum', 'plasma']],
    explanation:
      'Measures total vitamin B12 (cobalamin) in serum or plasma. Values can vary by method and laboratory; active B12 and related metabolites are distinct measurements, so this result alone does not resolve status.',
    sources: [nihVitaminB12Source],
  }),
];

export const metabolicBiomarkers = metabolicMicronutrientBiomarkers;
