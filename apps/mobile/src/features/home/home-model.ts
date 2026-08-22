import type { IntakeEvent } from '@alyte/domain';

export type IntakeTimelineGroup = {
  readonly localDate: string;
  readonly events: readonly IntakeEvent[];
};

/**
 * Home currently requests one device-local day, but keeping grouping pure means the timeline can
 * safely grow to adjacent days without making the screen responsible for ordering records.
 */
export function groupIntakeTimeline(
  events: readonly IntakeEvent[],
): readonly IntakeTimelineGroup[] {
  const groups = new Map<string, IntakeEvent[]>();
  for (const event of events) {
    const group = groups.get(event.localDate);
    if (group === undefined) {
      groups.set(event.localDate, [event]);
    } else {
      group.push(event);
    }
  }

  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([localDate, groupedEvents]) => ({
      localDate,
      events: [...groupedEvents].sort(
        (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
      ),
    }));
}
