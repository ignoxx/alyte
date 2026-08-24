import { canonicalId, type CreateIntakeEventInput, type CreateLabRecordInput } from '@alyte/domain';
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

/** Four lipid entries plus honest missing/bounded/date-missing context for deterministic UI checks. */
export function showcaseLabRecordInputs(): readonly CreateLabRecordInput[] {
  const lipid = (
    biomarker: string,
    label: string,
    value:
      number | { readonly kind: 'bounded'; readonly comparator: '<' | '>'; readonly value: number },
    referenceInterval: string,
  ) => ({
    biomarkerId: canonicalId(biomarker),
    specimenType: 'serum' as const,
    panelLabel: 'Lipids',
    label,
    value: typeof value === 'number' ? { kind: 'numeric' as const, value } : value,
    valueString: typeof value === 'number' ? String(value) : `${value.comparator}${value.value}`,
    unit: 'mg/dL',
    referenceInterval,
    provenance: 'user-entered' as const,
    reviewState: 'confirmed' as const,
  });
  return [
    {
      id: 'showcase-lab-record-2026-01',
      collectionDate: { kind: 'known', value: '2026-01-15' },
      specimenType: 'serum',
      laboratoryName: 'Synthetic Laboratory',
      notes: 'Synthetic showcase data',
      measurements: [
        lipid('biomarker.total_cholesterol', 'Total cholesterol', 212, '<200'),
        lipid('biomarker.ldl_c', 'LDL-C', 121, '<100'),
        lipid('biomarker.hdl_c', 'HDL-C', 47, '>=40'),
        lipid('biomarker.triglycerides', 'Triglycerides', 162, '<150'),
      ],
    },
    {
      id: 'showcase-lab-record-2026-03',
      collectionDate: { kind: 'known', value: '2026-03-15' },
      specimenType: 'serum',
      laboratoryName: 'Synthetic Laboratory',
      notes: 'Synthetic showcase data',
      measurements: [
        lipid('biomarker.total_cholesterol', 'Total cholesterol', 198, '<200'),
        lipid('biomarker.ldl_c', 'LDL-C', 108, '<100'),
        lipid('biomarker.hdl_c', 'HDL-C', 52, '>=40'),
        lipid('biomarker.triglycerides', 'Triglycerides', 141, '<150'),
      ],
    },
    {
      id: 'showcase-lab-record-date-missing',
      collectionDate: { kind: 'missing' },
      specimenType: 'serum',
      laboratoryName: 'Synthetic Laboratory',
      notes: 'Synthetic showcase data',
      measurements: [
        lipid('biomarker.ldl_c', 'LDL-C', 102, '<100'),
        lipid('biomarker.hdl_c', 'HDL-C', 50, '>=40'),
      ],
    },
    {
      id: 'showcase-lab-record-2026-05',
      collectionDate: { kind: 'known', value: '2026-05-15' },
      specimenType: 'serum',
      laboratoryName: 'Synthetic Laboratory',
      notes: 'Synthetic showcase data',
      measurements: [
        lipid(
          'biomarker.ldl_c',
          'LDL-C',
          {
            kind: 'bounded',
            comparator: '<',
            value: 100,
          },
          '<100',
        ),
        lipid('biomarker.total_cholesterol', 'Total cholesterol', 195, '<200'),
      ],
    },
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
