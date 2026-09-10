import type { ExtractionDraft } from '@alyte/domain';

export type ExtractionDraftViewState = {
  readonly draft: ExtractionDraft | null;
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly actionError: string | null;
};

export type ExtractionDraftViewAction =
  | { readonly type: 'load-start' }
  | { readonly type: 'load-success'; readonly draft: ExtractionDraft }
  | { readonly type: 'load-failure' }
  | { readonly type: 'refresh-success'; readonly draft: ExtractionDraft }
  | { readonly type: 'refresh-failure' }
  | { readonly type: 'mutation-success'; readonly draft: ExtractionDraft }
  | { readonly type: 'clear-action-error' }
  | { readonly type: 'action-failure'; readonly message: string };

export const initialExtractionDraftViewState: ExtractionDraftViewState = {
  draft: null,
  loading: true,
  loadError: false,
  actionError: null,
};

/** A mounted draft does not need another read just because its editor sheet lost focus. */
export function extractionDraftRouteNeedsLoad(
  loadedRouteKey: string | null,
  routeKey: string,
): boolean {
  return loadedRouteKey !== routeKey;
}

/**
 * Keep screen state transitions explicit so a local action can update the mounted draft without
 * triggering a fresh read. Action failures retain the current draft and therefore retain every
 * edit the person can still review or retry.
 */
export function extractionDraftViewReducer(
  state: ExtractionDraftViewState,
  action: ExtractionDraftViewAction,
): ExtractionDraftViewState {
  switch (action.type) {
    case 'load-start':
      return { draft: null, loading: true, loadError: false, actionError: null };
    case 'load-success':
      return { draft: action.draft, loading: false, loadError: false, actionError: null };
    case 'load-failure':
      return { draft: null, loading: false, loadError: true, actionError: null };
    case 'refresh-success':
      return { draft: action.draft, loading: false, loadError: false, actionError: null };
    case 'refresh-failure':
      return { ...state, loading: false, loadError: true, actionError: null };
    case 'mutation-success':
      return { ...state, draft: action.draft, loading: false, actionError: null };
    case 'clear-action-error':
      return { ...state, actionError: null };
    case 'action-failure':
      return { ...state, loading: false, actionError: action.message };
  }
}
