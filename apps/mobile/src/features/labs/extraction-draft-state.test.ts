import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractionDraft } from '@alyte/domain';
import {
  extractionDraftRouteNeedsLoad,
  extractionDraftViewReducer,
  initialExtractionDraftViewState,
} from './extraction-draft-state';

test('the mounted route does not need an initial load again after editor dismissal', () => {
  assert.equal(extractionDraftRouteNeedsLoad('report:draft', 'report:draft'), false);
  assert.equal(extractionDraftRouteNeedsLoad(null, 'report:draft'), true);
  assert.equal(extractionDraftRouteNeedsLoad('report:old-draft', 'report:new-draft'), true);
});

function draft(id: string): ExtractionDraft {
  return { id } as ExtractionDraft;
}

test('a mutation replaces the mounted draft without entering a loading state', () => {
  const current = { ...initialExtractionDraftViewState, draft: draft('current'), loading: false };
  const next = draft('updated');

  assert.deepEqual(extractionDraftViewReducer(current, { type: 'mutation-success', draft: next }), {
    draft: next,
    loading: false,
    loadError: false,
    actionError: null,
  });
});

test('a refocus refresh replaces the mounted draft without clearing it first', () => {
  const current = { ...initialExtractionDraftViewState, draft: draft('current'), loading: false };
  const next = draft('refreshed');

  assert.deepEqual(extractionDraftViewReducer(current, { type: 'refresh-success', draft: next }), {
    draft: next,
    loading: false,
    loadError: false,
    actionError: null,
  });
  assert.deepEqual(extractionDraftViewReducer(current, { type: 'refresh-failure' }), {
    draft: current.draft,
    loading: false,
    loadError: true,
    actionError: null,
  });
});

test('a failed retry keeps the existing draft and its edits available', () => {
  const current = { ...initialExtractionDraftViewState, draft: draft('edited'), loading: false };

  assert.deepEqual(
    extractionDraftViewReducer(current, {
      type: 'action-failure',
      message: 'The Original Report is unavailable. Try again.',
    }),
    {
      draft: current.draft,
      loading: false,
      loadError: false,
      actionError: 'The Original Report is unavailable. Try again.',
    },
  );
  assert.equal(
    extractionDraftViewReducer(
      extractionDraftViewReducer(current, {
        type: 'action-failure',
        message: 'Try again.',
      }),
      { type: 'clear-action-error' },
    ).actionError,
    null,
  );
});

test('an explicit initial load clears stale rows, while its success restores one draft', () => {
  const current = { ...initialExtractionDraftViewState, draft: draft('stale'), loading: false };
  const loading = extractionDraftViewReducer(current, { type: 'load-start' });
  assert.deepEqual(loading, initialExtractionDraftViewState);

  const loaded = draft('loaded');
  assert.deepEqual(extractionDraftViewReducer(loading, { type: 'load-success', draft: loaded }), {
    draft: loaded,
    loading: false,
    loadError: false,
    actionError: null,
  });
});
