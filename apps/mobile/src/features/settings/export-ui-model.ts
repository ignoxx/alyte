export type ExportMediaSummaryStatus = 'loading' | 'ready' | 'failed';

export type ExportMediaOptionAvailability = 'unknown' | 'available' | 'empty';

export type ExportMediaOptionState = {
  readonly disabled: boolean;
  readonly selected: boolean;
  /** Distinguishes a failed summary query from a successfully known empty category. */
  readonly availability: ExportMediaOptionAvailability;
};

/**
 * Keep the visible toggle and the export request bound to the same summary state. A failed or
 * in-flight count query is unknown, not empty, and is not selectable until the query succeeds. A
 * completed zero count is explicitly empty and always clears a stale selection.
 */
export function exportMediaOptionState(
  status: ExportMediaSummaryStatus,
  count: number,
  selected: boolean,
): ExportMediaOptionState {
  if (status !== 'ready') {
    return { disabled: true, selected: false, availability: 'unknown' };
  }

  if (count <= 0) {
    return { disabled: true, selected: false, availability: 'empty' };
  }

  return {
    disabled: false,
    selected,
    availability: 'available',
  };
}
