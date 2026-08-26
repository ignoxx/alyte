import type { SanitizationPageRecipe } from '@alyte/domain';
import { t } from '../../localization';

export type SanitizedEditorToolbarState = {
  readonly redactDisabled: boolean;
  readonly undoDisabled: boolean;
  readonly redoDisabled: boolean;
  readonly removeDisabled: boolean;
  readonly pagesDisabled: boolean;
  readonly sanitizeDisabled: boolean;
};

export type SanitizedEditorError =
  | { readonly kind: 'document-load'; readonly message: string; readonly recovery: 'load' }
  | {
      readonly kind: 'sanitization-verification';
      readonly message: string;
      readonly recovery: 'sanitize';
    }
  | { readonly kind: 'edit-operation'; readonly message: string; readonly recovery: null }
  | { readonly kind: 'viewer-load'; readonly message: string; readonly recovery: null };

export type SanitizedEditorErrorPresentation = {
  readonly kind: SanitizedEditorError['kind'];
  readonly title: string;
  readonly body: string;
  readonly recovery: SanitizedEditorError['recovery'];
  /** Loaded documents keep their editor and header actions available after a failure. */
  readonly mode: 'compact' | 'blocking';
  /** The compact banner may ellipsize visually, while accessibilityText remains complete. */
  readonly maxVisibleLines: 2 | null;
  readonly accessibilityText: string;
};

function errorCopy(error: SanitizedEditorError): { readonly title: string; readonly body: string } {
  switch (error.kind) {
    case 'document-load':
      return {
        title: t('labs.sanitizedEditorLoadError'),
        body: error.message,
      };
    case 'sanitization-verification':
      return {
        title: t('labs.sanitizedEditorVerificationFailureTitle'),
        body: t('labs.sanitizedEditorVerificationFailureBody'),
      };
    case 'edit-operation':
      return {
        title: t('labs.sanitizedEditorEditFailureTitle'),
        body: t('labs.sanitizedEditorEditFailureBody'),
      };
    case 'viewer-load':
      return {
        title: t('labs.sanitizedEditorViewerFailureTitle'),
        body: t('labs.sanitizedEditorViewerFailureBody'),
      };
  }
}

function sentence(value: string): string {
  return /[.!?…]$/.test(value.trim()) ? value : `${value}.`;
}

/**
 * Keep a long verification failure from taking over the document workspace at XL text sizes.
 * Initial loading failures remain blocking because there is no document to preserve yet.
 */
export function sanitizedEditorErrorPresentation(
  error: SanitizedEditorError,
): SanitizedEditorErrorPresentation {
  const copy = errorCopy(error);
  const mode = error.kind === 'document-load' ? 'blocking' : 'compact';
  const title = sentence(copy.title);
  const body = sentence(copy.body);
  return {
    kind: error.kind,
    title: copy.title,
    body: copy.body,
    recovery: error.recovery,
    mode,
    maxVisibleLines: mode === 'compact' ? 2 : null,
    accessibilityText:
      error.message === copy.body
        ? `${title} ${body}`
        : `${title} ${body} ${sentence(error.message)}`,
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
