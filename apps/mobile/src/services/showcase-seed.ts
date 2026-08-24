import {
  canonicalId,
  type CreateIntakeEventInput,
  type CreateLabRecordInput,
  type CreateMeasurementInput,
  type CanonicalId,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
import type { ShowcaseSnapshot } from '@alyte/fixtures';
import type { LabsService } from '../features/labs/service';

function localDateTime(localDate: string, localTime: string): string {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = localTime.split(':').map(Number) as [number, number];
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString();
}

/** Stable local-day fixture inputs keep showcase rows inside one day across cold launches. */
export function showcaseIntakeInputs(
  snapshot: ShowcaseSnapshot,
  localDate: string,
): readonly CreateIntakeEventInput[] {
  return snapshot.intakeEvents.map((fixture) => ({
    id: fixture.id,
    eventType: fixture.eventType,
    occurredAt: localDateTime(localDate, fixture.localTime),
    localDate,
    origin: 'manual',
    provenance: 'user-entered',
    components: [
      {
        name: fixture.name,
        amount: { kind: 'unknown', reason: 'not-provided' },
      },
    ],
  }));
}

export function missingShowcaseIntakeInputs(
  inputs: readonly CreateIntakeEventInput[],
  existingIds: ReadonlySet<string>,
): readonly CreateIntakeEventInput[] {
  return inputs.filter((input) => input.id === undefined || !existingIds.has(input.id));
}

type MeasurementFixture = {
  readonly id: string;
  readonly biomarker: string;
  readonly label: string;
  readonly value: MeasurementValue;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly specimenType?: SpecimenType;
  readonly panelLabel: string;
  readonly provenance?: CreateMeasurementInput['provenance'];
};

type FamilyFixture = {
  readonly id: string;
  readonly label: string;
  readonly specimenType: 'blood' | 'serum';
  readonly panelLabel: string;
  readonly first: { readonly value: number; readonly unit: string; readonly reference: string };
  readonly second: { readonly value: number; readonly unit: string; readonly reference: string };
};

const numeric = (value: number): MeasurementValue => ({ kind: 'numeric', value });
const bounded = (comparator: '<' | '>', value: number): MeasurementValue => ({
  kind: 'bounded',
  comparator,
  value,
});

const family = (
  id: string,
  label: string,
  specimenType: FamilyFixture['specimenType'],
  panelLabel: string,
  first: FamilyFixture['first'],
  second: FamilyFixture['second'],
): FamilyFixture => ({ id, label, specimenType, panelLabel, first, second });

const metabolicFamilies: readonly FamilyFixture[] = [
  family(
    'glucose',
    'Glucose',
    'serum',
    'Metabolic panel',
    { value: 5.2, unit: 'mmol/L', reference: '3.9–5.5 mmol/L' },
    { value: 5.5, unit: 'mmol/L', reference: '3.9–5.5 mmol/L' },
  ),
  family(
    'ferritin',
    'Ferritin',
    'serum',
    'Micronutrients',
    { value: 48, unit: 'µg/L', reference: '15–150 µg/L' },
    { value: 52, unit: 'ng/mL', reference: '15–150 ng/mL' },
  ),
  family(
    'vitamin_d_total',
    'Total 25-hydroxyvitamin D (LC-MS/MS)',
    'serum',
    'Micronutrients',
    { value: 62.5, unit: 'nmol/L', reference: '50–125 nmol/L' },
    { value: 25, unit: 'ng/mL', reference: '20–50 ng/mL' },
  ),
  family(
    'vitamin_b12_total',
    'Total vitamin B12 (immunoassay)',
    'serum',
    'Micronutrients',
    { value: 290, unit: 'pmol/L', reference: '150–600 pmol/L' },
    { value: 420, unit: 'pg/mL', reference: '150–600 pg/mL' },
  ),
];

const bloodFamilies: readonly FamilyFixture[] = [
  family(
    'hba1c',
    'HbA1c (NGSP)',
    'blood',
    'Blood count',
    { value: 5.4, unit: '%', reference: '<5.7%' },
    { value: 5.6, unit: '%', reference: '<5.7%' },
  ),
  family(
    'hemoglobin',
    'Hemoglobin',
    'blood',
    'Blood count',
    { value: 145, unit: 'g/L', reference: '120–170 g/L' },
    { value: 148, unit: 'g/L', reference: '120–170 g/L' },
  ),
  family(
    'hematocrit',
    'Hematocrit',
    'blood',
    'Blood count',
    { value: 0.43, unit: 'L/L', reference: '0.36–0.50 L/L' },
    { value: 0.45, unit: 'L/L', reference: '0.36–0.50 L/L' },
  ),
  family(
    'mcv',
    'MCV',
    'blood',
    'Blood count',
    { value: 88, unit: 'fL', reference: '80–100 fL' },
    { value: 90, unit: 'fL', reference: '80–100 fL' },
  ),
  family(
    'alt',
    'ALT (IFCC 37 C with P5P)',
    'blood',
    'Liver panel',
    { value: 22, unit: 'U/L', reference: '<40 U/L' },
    { value: 25, unit: 'U/L', reference: '<40 U/L' },
  ),
  family(
    'ast',
    'AST (IFCC 37 C with P5P)',
    'blood',
    'Liver panel',
    { value: 20, unit: 'U/L', reference: '<40 U/L' },
    { value: 22, unit: 'U/L', reference: '<40 U/L' },
  ),
  family(
    'ggt',
    'GGT (IFCC 37 C with P5P)',
    'blood',
    'Liver panel',
    { value: 18, unit: 'U/L', reference: '<55 U/L' },
    { value: 20, unit: 'U/L', reference: '<55 U/L' },
  ),
];

export const showcaseNonLipidBiomarkerIds: readonly CanonicalId[] = [
  ...metabolicFamilies,
  ...bloodFamilies,
].map((familyFixture) => canonicalId(`biomarker.${familyFixture.id}`));

function showcaseMeasurement(fixture: MeasurementFixture): CreateMeasurementInput {
  const valueString =
    fixture.value.kind === 'numeric' || fixture.value.kind === 'bounded'
      ? `${fixture.value.kind === 'bounded' ? fixture.value.comparator : ''}${fixture.value.value}`
      : fixture.value.value;
  return {
    id: fixture.id,
    biomarkerId: canonicalId(`biomarker.${fixture.biomarker}`),
    ...(fixture.specimenType === undefined ? {} : { specimenType: fixture.specimenType }),
    panelLabel: fixture.panelLabel,
    label: fixture.label,
    value: fixture.value,
    valueString,
    unit: fixture.unit,
    referenceInterval: fixture.referenceInterval,
    provenance: fixture.provenance ?? 'user-entered',
    reviewState: 'confirmed',
  };
}

function record(
  id: string,
  collectionDate: string | null,
  specimenType: 'blood' | 'serum',
  measurements: readonly MeasurementFixture[],
  notes = 'Synthetic showcase data',
): CreateLabRecordInput {
  return {
    id,
    collectionDate:
      collectionDate === null ? { kind: 'missing' } : { kind: 'known', value: collectionDate },
    specimenType,
    laboratoryName: 'Synthetic Laboratory',
    notes,
    measurements: measurements.map(showcaseMeasurement),
  };
}

function familyMeasurement(
  familyFixture: FamilyFixture,
  suffix: string,
  value: MeasurementValue,
  unit: string,
  referenceInterval: string,
  overrides: Partial<Pick<MeasurementFixture, 'label' | 'specimenType' | 'unit'>> = {},
): MeasurementFixture {
  return {
    id: `showcase-${familyFixture.id}-${suffix}`,
    biomarker: familyFixture.id,
    label: overrides.label ?? familyFixture.label,
    value,
    unit: overrides.unit ?? unit,
    referenceInterval,
    panelLabel: familyFixture.panelLabel,
    ...(overrides.specimenType === undefined ? {} : { specimenType: overrides.specimenType }),
  };
}

function exactRecord(
  id: string,
  collectionDate: string,
  families: readonly FamilyFixture[],
  which: 'first' | 'second',
): CreateLabRecordInput {
  return record(
    id,
    collectionDate,
    families[0]?.specimenType ?? 'serum',
    families.map((familyFixture) => {
      const result = familyFixture[which];
      return familyMeasurement(
        familyFixture,
        `${which}-${collectionDate}`,
        numeric(result.value),
        result.unit,
        result.reference,
      );
    }),
    `Synthetic showcase data · ${families[0]?.panelLabel ?? 'panel'} exact values`,
  );
}

function nonPointRecord(
  id: string,
  collectionDate: string | null,
  families: readonly FamilyFixture[],
  kind: 'date-missing' | 'bounded' | 'incompatible',
): CreateLabRecordInput {
  const incompatible: Record<
    string,
    Partial<Pick<MeasurementFixture, 'label' | 'specimenType' | 'unit'>>
  > = {
    glucose: { unit: 'g/L' },
    ferritin: { specimenType: 'blood' },
    vitamin_d_total: { label: 'Total 25-hydroxyvitamin D' },
    vitamin_b12_total: { label: 'Total vitamin B12' },
    hba1c: { unit: 'mg/dL' },
    hemoglobin: { specimenType: 'serum' },
    hematocrit: { unit: 'g/dL' },
    mcv: { unit: 'pg' },
    alt: { specimenType: 'serum' },
    ast: { label: 'AST' },
    ggt: { unit: 'ukat/L' },
  };
  return record(
    id,
    collectionDate,
    families[0]?.specimenType ?? 'serum',
    families.map((familyFixture) => {
      const result = familyFixture.second;
      if (kind === 'date-missing') {
        return familyMeasurement(
          familyFixture,
          kind,
          numeric(result.value),
          result.unit,
          result.reference,
        );
      }
      if (kind === 'bounded') {
        return familyMeasurement(
          familyFixture,
          kind,
          bounded('<', result.value),
          result.unit,
          result.reference,
        );
      }
      const override = incompatible[familyFixture.id] ?? {};
      return familyMeasurement(
        familyFixture,
        kind,
        numeric(result.value),
        result.unit,
        result.reference,
        override,
      );
    }),
    `Synthetic showcase data · ${kind} context`,
  );
}

function lipidRecordInputs(): readonly CreateLabRecordInput[] {
  const lipid = (
    biomarker: string,
    label: string,
    value: MeasurementValue,
    referenceInterval: string,
    suffix: string,
  ): MeasurementFixture => ({
    id: `showcase-${biomarker.replace('biomarker.', '')}-${suffix}`,
    biomarker: biomarker.replace('biomarker.', ''),
    label,
    value,
    unit: 'mg/dL',
    referenceInterval,
    panelLabel: 'Lipids',
    provenance: 'user-entered',
  });
  return [
    record('showcase-lab-record-2026-01', '2026-01-15', 'serum', [
      lipid('biomarker.total_cholesterol', 'Total cholesterol', numeric(212), '<200', '2026-01'),
      lipid('biomarker.ldl_c', 'LDL-C', numeric(121), '<100', '2026-01'),
      lipid('biomarker.hdl_c', 'HDL-C', numeric(47), '>=40', '2026-01'),
      lipid('biomarker.triglycerides', 'Triglycerides', numeric(162), '<150', '2026-01'),
    ]),
    record('showcase-lab-record-2026-03', '2026-03-15', 'serum', [
      lipid('biomarker.total_cholesterol', 'Total cholesterol', numeric(198), '<200', '2026-03'),
      lipid('biomarker.ldl_c', 'LDL-C', numeric(108), '<100', '2026-03'),
      lipid('biomarker.hdl_c', 'HDL-C', numeric(52), '>=40', '2026-03'),
      lipid('biomarker.triglycerides', 'Triglycerides', numeric(141), '<150', '2026-03'),
    ]),
    record('showcase-lab-record-date-missing', null, 'serum', [
      lipid('biomarker.ldl_c', 'LDL-C', numeric(102), '<100', 'date-missing'),
      lipid('biomarker.hdl_c', 'HDL-C', numeric(50), '>=40', 'date-missing'),
    ]),
    record('showcase-lab-record-2026-05', '2026-05-15', 'serum', [
      lipid('biomarker.ldl_c', 'LDL-C', bounded('<', 100), '<100', '2026-05'),
      lipid('biomarker.total_cholesterol', 'Total cholesterol', numeric(195), '<200', '2026-05'),
    ]),
  ];
}

/**
 * Deterministic local-only data for the native history route. Each non-lipid Biomarker gets two
 * compatible dated points; non-points stay visible for review without creating inferred values.
 */
export function showcaseLabRecordInputs(): readonly CreateLabRecordInput[] {
  return [
    ...lipidRecordInputs(),
    exactRecord('showcase-lab-record-metabolic-2026-01', '2026-01-15', metabolicFamilies, 'first'),
    exactRecord('showcase-lab-record-metabolic-2026-03', '2026-03-15', metabolicFamilies, 'second'),
    nonPointRecord(
      'showcase-lab-record-metabolic-date-missing',
      null,
      metabolicFamilies,
      'date-missing',
    ),
    nonPointRecord(
      'showcase-lab-record-metabolic-2026-05',
      '2026-05-15',
      metabolicFamilies,
      'bounded',
    ),
    nonPointRecord(
      'showcase-lab-record-metabolic-2026-06',
      '2026-06-15',
      metabolicFamilies,
      'incompatible',
    ),
    exactRecord('showcase-lab-record-blood-2026-01', '2026-01-15', bloodFamilies, 'first'),
    exactRecord('showcase-lab-record-blood-2026-03', '2026-03-15', bloodFamilies, 'second'),
    nonPointRecord('showcase-lab-record-blood-date-missing', null, bloodFamilies, 'date-missing'),
    nonPointRecord('showcase-lab-record-blood-2026-05', '2026-05-15', bloodFamilies, 'bounded'),
    nonPointRecord(
      'showcase-lab-record-blood-2026-06',
      '2026-06-15',
      bloodFamilies,
      'incompatible',
    ),
  ];
}

export function missingShowcaseLabRecordInputs(
  inputs: readonly CreateLabRecordInput[],
  existingIds: ReadonlySet<string>,
): readonly CreateLabRecordInput[] {
  return inputs.filter((input) => input.id === undefined || !existingIds.has(input.id));
}

/** Seed at service composition time; failures remain retryable on the next development launch. */
export async function seedShowcaseLabRecords(labs: LabsService): Promise<void> {
  try {
    const existingIds = new Set((await labs.listRecords()).map((record) => record.id));
    for (const input of missingShowcaseLabRecordInputs(showcaseLabRecordInputs(), existingIds)) {
      try {
        await labs.createRecord(input);
      } catch {
        // A later launch retries a missing synthetic fixture without overwriting local records.
      }
    }
  } catch {
    // Showcase seeding is an optional development aid; local mode stays usable if its store is unavailable.
  }
}
