import {
  CATALOGUE_VERSION,
  type BiomarkerCatalogueEntry,
  type CatalogueReviewMetadata,
  type CatalogueSource,
  type GeneralGuidance,
  type GeneralGuidanceThreshold,
  type UnitConversion,
} from './schema.js';

export const conversionSource: CatalogueSource = {
  id: 'source.ahrq.lipid-conversion-factors',
  title: 'Lipid Conversion Factors',
  publisher: 'Agency for Healthcare Research and Quality / NCBI Bookshelf',
  url: 'https://www.ncbi.nlm.nih.gov/books/NBK83505/',
  publicationDate: '2011-10',
  accessedAt: '2026-08-24',
  sourceKind: 'reference',
};

export const cdcLipidSource: CatalogueSource = {
  id: 'source.cdc.ldl-hdl-triglycerides',
  title: 'LDL and HDL Cholesterol and Triglycerides',
  publisher: 'Centers for Disease Control and Prevention',
  url: 'https://www.cdc.gov/cholesterol/about/ldl-and-hdl-cholesterol-and-triglycerides.html',
  publicationDate: '2024-05-15',
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const nhlbiLipidSource: CatalogueSource = {
  id: 'source.nhlbi.blood-cholesterol-diagnosis',
  title: 'Blood Cholesterol — Diagnosis',
  publisher: 'National Heart, Lung, and Blood Institute / NIH',
  url: 'https://www.nhlbi.nih.gov/health/blood-cholesterol/diagnosis',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const lipidSources: readonly CatalogueSource[] = [
  conversionSource,
  cdcLipidSource,
  nhlbiLipidSource,
];

export const reviewPending: CatalogueReviewMetadata = {
  status: 'pending-human-publication',
  contentVersion: CATALOGUE_VERSION,
  reviewedAt: null,
  reviewer: null,
  reviewNotes:
    'Agent-authored draft. Clinical/content owner must review applicability, wording, and sources before publication.',
};

const lipidConversions = (factor: number): readonly UnitConversion[] => [
  { from: 'mmol/L', to: 'mg/dL', factor, offset: 0, sourceId: conversionSource.id },
  {
    from: 'mg/dL',
    to: 'mmol/L',
    factor: 1 / factor,
    offset: 0,
    sourceId: conversionSource.id,
  },
];

const lipidGuidance = (
  id: string,
  label: string,
  thresholds: readonly GeneralGuidanceThreshold[],
  limitations: readonly string[] = [],
): readonly GeneralGuidance[] => [
  {
    id,
    label,
    description:
      'A population screening reference point from an identified authority. It is not a personal target and does not replace the laboratory interval.',
    thresholds,
    applicability: {
      population: 'adults',
      jurisdiction: 'US',
      context: 'screening',
      limitations,
    },
    disagreement:
      'Authorities use context-dependent thresholds; this baseline records the cited screening point without resolving it into a personal target.',
    sources: [cdcLipidSource.id, nhlbiLipidSource.id],
    review: reviewPending,
  },
];

const lipidEntry = (
  entry: Omit<
    BiomarkerCatalogueEntry,
    | 'valueType'
    | 'canonicalUnit'
    | 'unitConversions'
    | 'specimenCompatibility'
    | 'explanation'
    | 'sources'
    | 'review'
    | 'generalGuidance'
  > & {
    readonly explanation: string;
    readonly sources: readonly CatalogueSource[];
    readonly generalGuidance: readonly GeneralGuidance[];
    readonly unitConversions: readonly UnitConversion[];
  },
): BiomarkerCatalogueEntry => ({
  ...entry,
  valueType: 'numeric',
  canonicalUnit: 'mg/dL',
  unitConversions: entry.unitConversions,
  specimenCompatibility: [['blood', 'serum', 'plasma'], ['unknown']],
  explanation: entry.explanation,
  sources: entry.sources,
  review: reviewPending,
  generalGuidance: entry.generalGuidance,
});

export const lipidBiomarkers: readonly BiomarkerCatalogueEntry[] = [
  lipidEntry({
    id: 'biomarker.total_cholesterol',
    aliases: [
      'total cholesterol',
      'cholesterol total',
      'gesamtcholesterin',
      'cholestérol total',
      'colesterol total',
      'colesterolo totale',
      'totaal cholesterol',
      'cholesterol całkowity',
      'bendras cholesterolis',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
    explanation:
      'Measures the total amount of cholesterol carried in blood. It is commonly included in a lipid panel with LDL-C, HDL-C, and triglycerides. Interpretation depends on the laboratory interval and broader context.',
    sources: [cdcLipidSource, nhlbiLipidSource],
    unitConversions: lipidConversions(38.67),
    generalGuidance: lipidGuidance(
      'guidance.total-cholesterol.screening-us',
      'Adult screening reference point',
      [{ operator: '<', value: 200, unit: 'mg/dL' }],
    ),
  }),
  lipidEntry({
    id: 'biomarker.ldl_c',
    aliases: [
      'ldl',
      'ldl-c',
      'ldl cholesterol',
      'ldl-cholesterin',
      'ldl-cholesterol',
      'cholestérol ldl',
      'colesterol ldl',
      'colesterolo ldl',
      'cholesterol ldl',
      'mažo tankio lipoproteinų cholesterolis',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
    explanation:
      'Measures cholesterol carried by low-density lipoproteins. Persistently higher LDL-C is associated with cardiovascular risk; this app does not interpret an individual result.',
    sources: [cdcLipidSource, nhlbiLipidSource],
    unitConversions: lipidConversions(38.67),
    generalGuidance: lipidGuidance(
      'guidance.ldl-c.screening-us',
      'Adult screening reference point',
      [{ operator: '<', value: 100, unit: 'mg/dL' }],
    ),
  }),
  lipidEntry({
    id: 'biomarker.hdl_c',
    aliases: [
      'hdl',
      'hdl-c',
      'hdl cholesterol',
      'hdl-cholesterin',
      'cholestérol hdl',
      'colesterol hdl',
      'colesterolo hdl',
      'didelio tankio lipoproteinų cholesterolis',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
    explanation:
      'Measures cholesterol carried by high-density lipoproteins. It is considered with LDL-C, triglycerides, and other context; a single HDL-C result is not interpreted on its own.',
    sources: [cdcLipidSource, nhlbiLipidSource],
    unitConversions: lipidConversions(38.67),
    generalGuidance: lipidGuidance(
      'guidance.hdl-c.screening-us',
      'Adult screening reference points by sex',
      [
        { operator: '>=', value: 40, unit: 'mg/dL' },
        { operator: '>=', value: 50, unit: 'mg/dL' },
      ],
      ['The cited thresholds are sex-specific; do not collapse them into one value.'],
    ),
  }),
  lipidEntry({
    id: 'biomarker.triglycerides',
    aliases: [
      'triglycerides',
      'triglyceride',
      'triglyzeride',
      'triglycérides',
      'triglicéridos',
      'trigliceridi',
      'triglyceriden',
      'triglicerydy',
      'trigliceridai',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
    explanation:
      'Measures triglycerides, a type of fat transported in blood. Levels can vary with fasting state and other context, so the laboratory interval and collection context remain relevant.',
    sources: [cdcLipidSource, nhlbiLipidSource],
    unitConversions: lipidConversions(88.57),
    generalGuidance: lipidGuidance(
      'guidance.triglycerides.screening-us',
      'Adult screening reference point',
      [{ operator: '<', value: 150, unit: 'mg/dL' }],
      ['Fasting status and other collection context can affect interpretation.'],
    ),
  }),
];
