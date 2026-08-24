import {
  CATALOGUE_VERSION,
  type BiomarkerCatalogueEntry,
  type CatalogueMethodPolicy,
  type CatalogueReviewMetadata,
  type CatalogueSource,
  type UnitConversion,
} from './schema.js';

/** Public, non-personal sources for the blood-count and liver-enzyme draft content. */
export const medlineplusCompleteBloodCountSource: CatalogueSource = {
  id: 'source.medlineplus.complete-blood-count',
  title: 'Complete Blood Count (CBC)',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/complete-blood-count-cbc/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusHemoglobinSource: CatalogueSource = {
  id: 'source.medlineplus.hemoglobin-test',
  title: 'Hemoglobin Test',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/hemoglobin-test/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusHematocritSource: CatalogueSource = {
  id: 'source.medlineplus.hematocrit-test',
  title: 'Hematocrit Test',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/hematocrit-test/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusMcvSource: CatalogueSource = {
  id: 'source.medlineplus.mcv-test',
  title: 'MCV (Mean Corpuscular Volume)',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/mcv-mean-corpuscular-volume/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusLiverFunctionSource: CatalogueSource = {
  id: 'source.medlineplus.liver-function-tests',
  title: 'Liver Function Tests',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/liver-function-tests/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusAltSource: CatalogueSource = {
  id: 'source.medlineplus.alt-test',
  title: 'ALT Blood Test',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/alt-blood-test/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusAstSource: CatalogueSource = {
  id: 'source.medlineplus.ast-test',
  title: 'AST Test',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/ast-test/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const medlineplusGgtSource: CatalogueSource = {
  id: 'source.medlineplus.ggt-test',
  title: 'Gamma-glutamyl Transferase (GGT) Test',
  publisher: 'MedlinePlus, U.S. National Library of Medicine',
  url: 'https://medlineplus.gov/lab-tests/gamma-glutamyl-transferase-ggt-test/',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'public-health-authority',
};

export const ifccAltReferenceSource: CatalogueSource = {
  id: 'source.ifcc.alt-reference-procedure',
  title:
    'IFCC primary reference procedures for catalytic activity concentrations of enzymes at 37 °C. Part 4. Reference procedure for the measurement of catalytic concentration of alanine aminotransferase',
  publisher: 'International Federation of Clinical Chemistry and Laboratory Medicine',
  url: 'https://pubmed.ncbi.nlm.nih.gov/12241021/',
  publicationDate: '2002-07',
  accessedAt: '2026-08-24',
  sourceKind: 'professional-guideline',
};

export const ifccAstReferenceSource: CatalogueSource = {
  id: 'source.ifcc.ast-reference-procedure',
  title:
    'IFCC primary reference procedures for catalytic activity concentrations of enzymes at 37 °C. Part 5. Reference procedure for the measurement of catalytic concentration of aspartate aminotransferase',
  publisher: 'International Federation of Clinical Chemistry and Laboratory Medicine',
  url: 'https://pubmed.ncbi.nlm.nih.gov/12241022/',
  publicationDate: '2002-07',
  accessedAt: '2026-08-24',
  sourceKind: 'professional-guideline',
};

export const ifccGgtReferenceSource: CatalogueSource = {
  id: 'source.ifcc.ggt-reference-procedure',
  title:
    'IFCC primary reference procedures for catalytic activity concentrations of enzymes at 37 °C. Part 6. Reference procedure for the measurement of catalytic concentration of gamma-glutamyltransferase',
  publisher: 'International Federation of Clinical Chemistry and Laboratory Medicine',
  url: 'https://pubmed.ncbi.nlm.nih.gov/12241023/',
  publicationDate: '2002-07',
  accessedAt: '2026-08-24',
  sourceKind: 'professional-guideline',
};

export const nistUnitDefinitionsSource: CatalogueSource = {
  id: 'source.nist.si-unit-definitions',
  title: 'NIST SI Units and Metric Prefixes',
  publisher: 'National Institute of Standards and Technology',
  url: 'https://www.nist.gov/pml/owm/si-units-volume',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'reference',
};

export const nistPercentageDefinitionsSource: CatalogueSource = {
  id: 'source.nist.si-percentage-definitions',
  title: 'NIST Guide to the SI, Chapter 7: Expressing Values of Quantities',
  publisher: 'National Institute of Standards and Technology',
  url: 'https://www.nist.gov/pml/special-publication-811/nist-guide-si-chapter-7-rules-and-style-conventions-expressing-values',
  publicationDate: null,
  accessedAt: '2026-08-24',
  sourceKind: 'reference',
};

export const bloodLiverSources: readonly CatalogueSource[] = [
  medlineplusCompleteBloodCountSource,
  medlineplusHemoglobinSource,
  medlineplusHematocritSource,
  medlineplusMcvSource,
  medlineplusLiverFunctionSource,
  medlineplusAltSource,
  medlineplusAstSource,
  medlineplusGgtSource,
  ifccAltReferenceSource,
  ifccAstReferenceSource,
  ifccGgtReferenceSource,
  nistUnitDefinitionsSource,
  nistPercentageDefinitionsSource,
];

export const bloodLiverReviewPending: CatalogueReviewMetadata = {
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

const methodPolicy = (
  kind: CatalogueMethodPolicy['kind'],
  allowedMethods: readonly string[],
  unsafePatterns: readonly string[],
  rationale: string,
  profiles: CatalogueMethodPolicy['profiles'] = undefined,
): CatalogueMethodPolicy => ({
  version: '1.0.0',
  kind,
  allowedMethods,
  unsafePatterns,
  ...(profiles === undefined ? {} : { profiles }),
  rationale,
});

const enzymeProfiles = (prefix: string): NonNullable<CatalogueMethodPolicy['profiles']> => [
  {
    id: `${prefix}-ifcc-37-p5p`,
    assayPatterns: ['ifcc'],
    temperatureC: 37,
    temperaturePatterns: ['37 c', '37 degrees'],
    pyridoxalPhosphate: 'present',
    pyridoxalPhosphatePatterns: ['with p5p', 'with pyridoxal phosphate', 'p5p present'],
  },
  {
    id: `${prefix}-ifcc-30-p5p`,
    assayPatterns: ['ifcc'],
    temperatureC: 30,
    temperaturePatterns: ['30 c', '30 degrees'],
    pyridoxalPhosphate: 'present',
    pyridoxalPhosphatePatterns: ['with p5p', 'with pyridoxal phosphate', 'p5p present'],
  },
  {
    id: `${prefix}-ifcc-37-no-p5p`,
    assayPatterns: ['ifcc'],
    temperatureC: 37,
    temperaturePatterns: ['37 c', '37 degrees'],
    pyridoxalPhosphate: 'absent',
    pyridoxalPhosphatePatterns: [
      'without p5p',
      'without pyridoxal phosphate',
      'no p5p',
      'no pyridoxal phosphate',
    ],
  },
  {
    id: `${prefix}-ifcc-30-no-p5p`,
    assayPatterns: ['ifcc'],
    temperatureC: 30,
    temperaturePatterns: ['30 c', '30 degrees'],
    pyridoxalPhosphate: 'absent',
    pyridoxalPhosphatePatterns: [
      'without p5p',
      'without pyridoxal phosphate',
      'no p5p',
      'no pyridoxal phosphate',
    ],
  },
];

const hemoglobinMethodPolicy = methodPolicy(
  'method-agnostic',
  [],
  [
    'hemoglobin a1c',
    'glycated hemoglobin',
    'glycosylated hemoglobin',
    'carboxyhemoglobin',
    'methemoglobin',
    'fetal hemoglobin',
    'hemoglobin variant',
  ],
  'The entry is whole-blood hemoglobin concentration; glycated, derivative, and variant hemoglobins are distinct measurements.',
);

const hematocritMethodPolicy = methodPolicy(
  'method-agnostic',
  [],
  ['hemoglobin', 'mean corpuscular volume', 'mcv', 'red blood cell count', 'rbc'],
  'The entry is hematocrit or packed-cell volume; neighboring CBC analytes are distinct measurements.',
);

const mcvMethodPolicy = methodPolicy(
  'method-agnostic',
  [],
  [
    'mean corpuscular hemoglobin',
    'mean corpuscular hemoglobin concentration',
    'mch',
    'mchc',
    'red cell distribution width',
    'rdw',
  ],
  'The entry is mean corpuscular volume; hemoglobin indices and distribution-width indices are distinct measurements.',
);

const altMethodPolicy = methodPolicy(
  'requires-explicit-method',
  ['ifcc', 'pyridoxal phosphate', 'p5p'],
  ['non-ifcc'],
  'ALT catalytic activity is comparable only when the source states a complete supported IFCC assay profile, including temperature and PLP/P5P status; incomplete or differently named assays stay preserved-only.',
  enzymeProfiles('alt'),
);

const astMethodPolicy = methodPolicy(
  'requires-explicit-method',
  ['ifcc', 'pyridoxal phosphate', 'p5p'],
  ['non-ifcc'],
  'AST catalytic activity is comparable only when the source states a complete supported IFCC assay profile, including temperature and PLP/P5P status; incomplete or differently named assays stay preserved-only.',
  enzymeProfiles('ast'),
);

const ggtMethodPolicy = methodPolicy(
  'requires-explicit-method',
  ['ifcc'],
  ['non-ifcc', 'legacy'],
  'GGT catalytic activity is comparable only when the source states a complete supported IFCC assay profile, including temperature and PLP/P5P status; incomplete or differently named assays stay preserved-only.',
  enzymeProfiles('ggt'),
);

type BloodLiverEntryInput = Omit<
  BiomarkerCatalogueEntry,
  | 'catalogueVersion'
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
};

function bloodLiverEntry(entry: BloodLiverEntryInput): BiomarkerCatalogueEntry {
  return {
    ...entry,
    catalogueVersion: CATALOGUE_VERSION,
    valueType: 'numeric',
    canonicalUnit: entry.canonicalUnit,
    unitConversions: entry.unitConversions,
    specimenCompatibility: entry.specimenCompatibility,
    explanation: entry.explanation,
    sources: entry.sources,
    review: bloodLiverReviewPending,
    // No blood-count or enzyme threshold is portable without age, sex, physiology, laboratory,
    // and/or assay context that this catalogue can deterministically establish.
    generalGuidance: [],
  };
}

const hemoglobinConversions: readonly UnitConversion[] = [
  conversion('g/L', 'g/dL', 0.1, 0, nistUnitDefinitionsSource.id),
  conversion('g/dL', 'g/L', 10, 0, nistUnitDefinitionsSource.id),
];

const hematocritConversions: readonly UnitConversion[] = [
  conversion('L/L', '%', 100, 0, nistPercentageDefinitionsSource.id),
  conversion('%', 'L/L', 0.01, 0, nistPercentageDefinitionsSource.id),
];

export const bloodLiverBiomarkers: readonly BiomarkerCatalogueEntry[] = [
  bloodLiverEntry({
    id: 'biomarker.hemoglobin',
    canonicalLabel: 'Hemoglobin',
    aliases: [
      'hemoglobin',
      'haemoglobin',
      'hgb',
      'hb',
      'hemoglobin concentration',
      'hämoglobin',
      'hämoglobinwert',
      'hémoglobine',
      'hemoglobina',
      'emoglobina',
      'hemoglobine',
      'hemoglobinas',
    ],
    unsafeAliases: hemoglobinMethodPolicy.unsafePatterns,
    methodPolicy: hemoglobinMethodPolicy,
    specimens: ['blood', 'unknown'],
    units: ['g/dL', 'g/L'],
    canonicalUnit: 'g/dL',
    unitConversions: hemoglobinConversions,
    specimenCompatibility: [['blood'], ['unknown']],
    explanation:
      'Measures the concentration of hemoglobin in whole blood. It is commonly reported in a complete blood count and describes one part of the red-cell oxygen-carrying system. Age, sex, pregnancy, altitude, smoking, hydration, specimen handling, and laboratory method can affect the result; the issuing laboratory interval remains primary.',
    sources: [
      medlineplusCompleteBloodCountSource,
      medlineplusHemoglobinSource,
      nistUnitDefinitionsSource,
    ],
  }),
  bloodLiverEntry({
    id: 'biomarker.hematocrit',
    canonicalLabel: 'Hematocrit',
    aliases: [
      'hematocrit',
      'haematocrit',
      'hct',
      'packed cell volume',
      'pcv',
      'packed-cell volume',
      'hämatokrit',
      'hématocrite',
      'hematocrito',
      'ematocrito',
      'hematocriet',
      'hematokritas',
      'hematokryt',
    ],
    unsafeAliases: hematocritMethodPolicy.unsafePatterns,
    methodPolicy: hematocritMethodPolicy,
    specimens: ['blood', 'unknown'],
    units: ['%', 'L/L'],
    canonicalUnit: '%',
    unitConversions: hematocritConversions,
    specimenCompatibility: [['blood'], ['unknown']],
    explanation:
      'Measures the fraction of whole blood occupied by red blood cells. It is commonly reported in a complete blood count. Hydration, altitude, pregnancy, specimen handling, and laboratory method can affect the result; the issuing laboratory interval remains primary.',
    sources: [
      medlineplusCompleteBloodCountSource,
      medlineplusHematocritSource,
      nistPercentageDefinitionsSource,
    ],
  }),
  bloodLiverEntry({
    id: 'biomarker.mcv',
    canonicalLabel: 'MCV',
    aliases: [
      'mcv',
      'mean corpuscular volume',
      'mean cell volume',
      'mittleres korpuskuläres volumen',
      'volume globulaire moyen',
      'volumen corpuscular medio',
      'volume corpuscolare medio',
      'gemiddeld corpusculair volume',
      'średnia objętość krwinki',
      'vidutinis eritrocitų tūris',
    ],
    unsafeAliases: mcvMethodPolicy.unsafePatterns,
    methodPolicy: mcvMethodPolicy,
    specimens: ['blood', 'unknown'],
    units: ['fL'],
    canonicalUnit: 'fL',
    unitConversions: [],
    specimenCompatibility: [['blood'], ['unknown']],
    explanation:
      'Measures the average volume of red blood cells and is commonly reported as a red-cell index in a complete blood count. The result reflects the mixture of red-cell populations in the sample and can vary with age, specimen handling, and laboratory method; the issuing laboratory interval remains primary.',
    sources: [medlineplusCompleteBloodCountSource, medlineplusMcvSource],
  }),
  bloodLiverEntry({
    id: 'biomarker.alt',
    canonicalLabel: 'ALT',
    aliases: [
      'alt',
      'alanine aminotransferase',
      'alanine transaminase',
      'sgpt',
      'gpt',
      'alat',
      'alanin-aminotransferase',
      'alanine aminotransférase',
      'alanina aminotransferasa',
      'alanina aminotransferasi',
      'alanine-aminotransferase',
      'alanine aminotransferase ifcc',
    ],
    unsafeAliases: altMethodPolicy.unsafePatterns,
    methodPolicy: altMethodPolicy,
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
    canonicalUnit: 'U/L',
    unitConversions: [],
    specimenCompatibility: [['blood'], ['serum', 'plasma'], ['unknown']],
    explanation:
      'Measures alanine aminotransferase catalytic activity in a blood sample. ALT is commonly included with other liver-panel measurements, but it is also present outside the liver. Exercise, medicines, specimen handling, and assay method can affect the result; one measurement cannot identify a specific reason for a change.',
    sources: [medlineplusLiverFunctionSource, medlineplusAltSource, ifccAltReferenceSource],
  }),
  bloodLiverEntry({
    id: 'biomarker.ast',
    canonicalLabel: 'AST',
    aliases: [
      'ast',
      'aspartate aminotransferase',
      'aspartate transaminase',
      'sgot',
      'got',
      'asat',
      'aspartat-aminotransferase',
      'aspartate aminotransférase',
      'aspartato aminotransferasa',
      'aspartato aminotransferasi',
      'aspartaataminotransferase',
      'aspartate aminotransferase ifcc',
    ],
    unsafeAliases: astMethodPolicy.unsafePatterns,
    methodPolicy: astMethodPolicy,
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
    canonicalUnit: 'U/L',
    unitConversions: [],
    specimenCompatibility: [['blood'], ['serum', 'plasma'], ['unknown']],
    explanation:
      'Measures aspartate aminotransferase catalytic activity in a blood sample. AST is found in several tissues and is commonly considered with other liver-panel measurements. Exercise, medicines, specimen handling, and assay method can affect the result; one measurement cannot identify a specific reason for a change.',
    sources: [medlineplusLiverFunctionSource, medlineplusAstSource, ifccAstReferenceSource],
  }),
  bloodLiverEntry({
    id: 'biomarker.ggt',
    canonicalLabel: 'GGT',
    aliases: [
      'ggt',
      'ggtp',
      'gamma-gt',
      'gamma gt',
      'gamma glutamyl transferase',
      'gamma-glutamyltransferase',
      'gamma-glutamyl transferase',
      'gamma-glutamyl transpeptidase',
      'γ-glutamyltransferase',
      'gamma-glutamyl transférase',
      'gamma glutamil transferasa',
      'gamma glutamil transferasi',
      'gama glutamil transferase',
    ],
    unsafeAliases: ggtMethodPolicy.unsafePatterns,
    methodPolicy: ggtMethodPolicy,
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
    canonicalUnit: 'U/L',
    unitConversions: [],
    specimenCompatibility: [['blood'], ['serum', 'plasma'], ['unknown']],
    explanation:
      'Measures gamma-glutamyl transferase catalytic activity in a blood sample. GGT is found throughout the body and is concentrated in the liver and bile-duct system. Alcohol, medicines, exercise, specimen handling, and assay method can affect the result; one measurement cannot identify a specific reason for a change.',
    sources: [medlineplusLiverFunctionSource, medlineplusGgtSource, ifccGgtReferenceSource],
  }),
];
