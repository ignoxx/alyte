export const CATALOGUE_VERSION = '0.1.0';

export interface CatalogueManifest {
  readonly version: typeof CATALOGUE_VERSION;
  readonly status: 'review-pending';
}

export const catalogueManifest: CatalogueManifest = {
  version: CATALOGUE_VERSION,
  status: 'review-pending',
};

/**
 * The local extraction alias surface is deliberately small and explicit. Display labels are
 * translated/source-shaped; only these stable IDs may be proposed as Biomarkers.
 */
export type CatalogueSpecimen =
  'blood' | 'serum' | 'plasma' | 'urine' | 'stool' | 'saliva' | 'unknown';

export type BiomarkerCatalogueEntry = {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly specimens: readonly CatalogueSpecimen[];
  readonly units: readonly string[];
};

export const comparableBiomarkers: readonly BiomarkerCatalogueEntry[] = [
  {
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
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
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
      'ldl-cholesterol',
      'cholesterol ldl',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.hdl_c',
    aliases: [
      'hdl',
      'hdl-c',
      'hdl cholesterol',
      'hdl-cholesterin',
      'cholestérol hdl',
      'colesterol hdl',
      'colesterolo hdl',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.triglycerides',
    aliases: [
      'triglycerides',
      'triglyceride',
      'triglyceride',
      'triglyzeride',
      'triglycérides',
      'triglicéridos',
      'trigliceridi',
      'triglyceriden',
      'triglicerydy',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.glucose',
    aliases: [
      'glucose',
      'glukose',
      'glucose à jeun',
      'glucosa',
      'glicemia',
      'glucose nuchter',
      'glukoza',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.hba1c',
    aliases: [
      'hba1c',
      'hb a1c',
      'glycated hemoglobin',
      'glykiertes hämoglobin',
      'hémoglobine glyquée',
      'hemoglobina glicosilada',
      'emoglobina glicata',
      'geglyceerd hemoglobine',
      'hemoglobina glikowana',
    ],
    specimens: ['blood', 'unknown'],
    units: ['%', 'mmol/mol'],
  },
  {
    id: 'biomarker.hemoglobin',
    aliases: [
      'hemoglobin',
      'hämoglobin',
      'hémoglobine',
      'hemoglobina',
      'emoglobina',
      'hemoglobine',
      'hemoglobina',
    ],
    specimens: ['blood', 'unknown'],
    units: ['g/dL', 'g/L'],
  },
  {
    id: 'biomarker.hematocrit',
    aliases: [
      'hematocrit',
      'haematocrit',
      'hämatokrit',
      'hématocrite',
      'hematocrito',
      'ematocrito',
      'hematocriet',
      'hematokryt',
    ],
    specimens: ['blood', 'unknown'],
    units: ['%', 'L/L'],
  },
  {
    id: 'biomarker.mcv',
    aliases: [
      'mcv',
      'mean corpuscular volume',
      'mittleres korpuskuläres volumen',
      'volume globulaire moyen',
      'volumen corpuscular medio',
      'volume corpuscolare medio',
      'gemiddeld corpusculair volume',
      'średnia objętość krwinki',
    ],
    specimens: ['blood', 'unknown'],
    units: ['fL'],
  },
  {
    id: 'biomarker.ferritin',
    aliases: ['ferritin', 'ferritine', 'ferritina', 'ferritine', 'ferrytyna'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['ng/mL', 'µg/L', 'ug/L'],
  },
  {
    id: 'biomarker.alt',
    aliases: [
      'alt',
      'alanine aminotransferase',
      'alat',
      'alanin-aminotransferase',
      'alanine aminotransférase',
      'alanina aminotransferasa',
      'alanina aminotransferasi',
      'alanine-aminotransferase',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
  },
  {
    id: 'biomarker.ast',
    aliases: [
      'ast',
      'aspartate aminotransferase',
      'asat',
      'aspartat-aminotransferase',
      'aspartate aminotransférase',
      'aspartato aminotransferasa',
      'aspartato aminotransferasi',
      'aspartaataminotransferase',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
  },
  {
    id: 'biomarker.ggt',
    aliases: [
      'ggt',
      'gamma-gt',
      'gamma glutamyl transferase',
      'gamma-glutamyltransferase',
      'gamma-glutamyl transférase',
      'gamma glutamil transferasa',
      'gamma glutamil transferasi',
      'gamma-glutamyltransferase',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['U/L'],
  },
  {
    id: 'biomarker.vitamin_d_total',
    aliases: [
      'vitamin d',
      '25-oh vitamin d',
      '25 hydroxyvitamin d',
      '25-oh-vitamin d',
      'vitamine d',
      'vitamina d',
      'vitamina d totale',
      'vitamine d totaal',
      'witamina d',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['ng/mL', 'nmol/L'],
  },
  {
    id: 'biomarker.vitamin_b12_total',
    aliases: [
      'vitamin b12',
      'b12',
      'vitamine b12',
      'vitamina b12',
      'vitamina b12 totale',
      'witamina b12',
    ],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['pg/mL', 'pmol/L'],
  },
] as const;
