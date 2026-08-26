import type { SanitizationPageRecipe } from '@alyte/domain';

export type SanitizedEditorToolbarState = {
  readonly redactDisabled: boolean;
  readonly undoDisabled: boolean;
  readonly redoDisabled: boolean;
  readonly removeDisabled: boolean;
  readonly pagesDisabled: boolean;
  readonly sanitizeDisabled: boolean;
};

export type SanitizedEditorErrorPresentation = {
  /** Loaded documents keep their editor and header actions available after a failure. */
  readonly mode: 'compact' | 'blocking';
  /** The compact banner may ellipsize visually, while accessibilityText remains complete. */
  readonly maxVisibleLines: 2 | null;
  readonly accessibilityText: string;
};

/**
 * Keep a long verification failure from taking over the document workspace at XL text sizes.
 * Initial loading failures remain blocking because there is no document to preserve yet.
 */
export function sanitizedEditorErrorPresentation(input: {
  readonly error: string;
  readonly documentAvailable: boolean;
}): SanitizedEditorErrorPresentation {
  return {
    mode: input.documentAvailable ? 'compact' : 'blocking',
    maxVisibleLines: input.documentAvailable ? 2 : null,
    accessibilityText: input.error,
  };
}

/**
 * A sanitization render is a snapshot. While it is being produced, every control that could
 * change the recipe is disabled so the bytes being verified cannot diverge from the editor state.
 */
export function sanitizedEditorToolbarState(input: {
  readonly busy: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
}): SanitizedEditorToolbarState {
  return {
    redactDisabled: input.busy,
    undoDisabled: input.busy || !input.canUndo,
    redoDisabled: input.busy || !input.canRedo,
    removeDisabled: input.busy || !input.hasSelection,
    pagesDisabled: input.busy,
    sanitizeDisabled: input.busy,
  };
}

export function orderedPagePosition(
  pages: readonly Pick<SanitizationPageRecipe, 'pageIndex'>[],
  pageIndex: number,
): { readonly position: number; readonly total: number } | null {
  const index = pages.findIndex((page) => page.pageIndex === pageIndex);
  return index < 0 ? null : { position: index + 1, total: pages.length };
}

export function sanitizedPageCounter(
  pages: readonly Pick<SanitizationPageRecipe, 'pageIndex'>[],
  pageIndex: number,
  label: string,
): string {
  const position = orderedPagePosition(pages, pageIndex);
  return position === null ? label : `${label} ${position.position}/${position.total}`;
}
