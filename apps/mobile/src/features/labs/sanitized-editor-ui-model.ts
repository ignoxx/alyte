import type { SanitizationPageRecipe } from '@alyte/domain';

export type SanitizedEditorToolbarState = {
  readonly redactDisabled: boolean;
  readonly undoDisabled: boolean;
  readonly redoDisabled: boolean;
  readonly removeDisabled: boolean;
  readonly pagesDisabled: boolean;
  readonly sanitizeDisabled: boolean;
};

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
