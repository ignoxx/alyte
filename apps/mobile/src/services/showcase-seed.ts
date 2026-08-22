import type { CreateIntakeEventInput } from '@alyte/domain';
import type { ShowcaseSnapshot } from '@alyte/fixtures';

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
