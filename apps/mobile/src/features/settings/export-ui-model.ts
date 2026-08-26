export type ExportMediaStatus = 'loading' | 'ready' | 'unavailable';

export type ExportMediaOptionState = {
  readonly disabled: boolean;
  readonly selected: boolean;
  /** True only when the media query completed and found no files in this category. */
  readonly unavailable: boolean;
};

/**
 * Keep the visible toggle and the export request bound to the same known availability state.
 * A failed or in-flight count query is not treated as an empty category, but it is not selectable
 * until the query succeeds. A completed zero count is explicitly unavailable and always clears a
 * stale selection.
 */
export function exportMediaOptionState(
  status: ExportMediaStatus,
  count: number,
  selected: boolean,
): ExportMediaOptionState {
  const hasKnownAvailability = status === 'ready';
  const available = hasKnownAvailability && count > 0;

  return {
    disabled: !available,
    selected: available && selected,
    unavailable: hasKnownAvailability && count <= 0,
  };
}
