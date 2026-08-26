import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderedPagePosition,
  sanitizedEditorErrorPresentation,
  sanitizedEditorToolbarState,
  sanitizedPageCounter,
} from './sanitized-editor-ui-model';

const pages = [{ pageIndex: 0 }, { pageIndex: 1 }, { pageIndex: 2 }];

test('sanitization busy state disables every recipe-mutating toolbar action', () => {
  assert.deepEqual(
    sanitizedEditorToolbarState({
      busy: true,
      canUndo: true,
      canRedo: true,
      hasSelection: true,
    }),
    {
      redactDisabled: true,
      undoDisabled: true,
      redoDisabled: true,
      removeDisabled: true,
      pagesDisabled: true,
      sanitizeDisabled: true,
    },
  );
  assert.deepEqual(
    sanitizedEditorToolbarState({
      busy: false,
      canUndo: false,
      canRedo: true,
      hasSelection: false,
    }),
    {
      redactDisabled: false,
      undoDisabled: true,
      redoDisabled: false,
      removeDisabled: true,
      pagesDisabled: false,
      sanitizeDisabled: false,
    },
  );
});

test('page counter follows ordered recipe pages after reordering', () => {
  const reordered = [{ pageIndex: 2 }, { pageIndex: 0 }, { pageIndex: 1 }];
  assert.deepEqual(orderedPagePosition(reordered, 0), { position: 2, total: 3 });
  assert.equal(sanitizedPageCounter(reordered, 0, 'Pages'), 'Pages 2/3');
  assert.equal(sanitizedPageCounter(reordered, 2, 'Pages'), 'Pages 1/3');
  assert.equal(orderedPagePosition(reordered, 99), null);
});

test('page counter remains a plain readable string at any text size', () => {
  assert.equal(sanitizedPageCounter(pages, 1, 'Pages'), 'Pages 2/3');
  assert.equal(sanitizedPageCounter(pages, 1, 'Страницы'), 'Страницы 2/3');
});

test('sanitizer failures stay compact when the source document remains available', () => {
  const error = 'A long verification explanation remains available to VoiceOver.';
  assert.deepEqual(sanitizedEditorErrorPresentation({ error, documentAvailable: true }), {
    mode: 'compact',
    maxVisibleLines: 2,
    accessibilityText: error,
  });
  assert.deepEqual(sanitizedEditorErrorPresentation({ error, documentAvailable: false }), {
    mode: 'blocking',
    maxVisibleLines: null,
    accessibilityText: error,
  });
});
