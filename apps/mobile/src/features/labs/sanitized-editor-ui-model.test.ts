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
  assert.deepEqual(
    sanitizedEditorErrorPresentation({
      kind: 'sanitization-verification',
      message: error,
      recovery: 'sanitize',
    }),
    {
      kind: 'sanitization-verification',
      title: 'Sanitized Report needs attention',
      body: 'Verification failed. Retry or cancel to keep the Original Report unchanged.',
      recovery: 'sanitize',
      mode: 'compact',
      maxVisibleLines: 2,
      accessibilityText:
        'Sanitized Report needs attention. Verification failed. Retry or cancel to keep the Original Report unchanged. A long verification explanation remains available to VoiceOver.',
    },
  );
  assert.deepEqual(
    sanitizedEditorErrorPresentation({
      kind: 'document-load',
      message: 'The Sanitized Report editor could not open.',
      recovery: 'load',
    }),
    {
      kind: 'document-load',
      title: 'The Sanitized Report editor could not open.',
      body: 'The Sanitized Report editor could not open.',
      recovery: 'load',
      mode: 'blocking',
      maxVisibleLines: null,
      accessibilityText:
        'The Sanitized Report editor could not open. The Sanitized Report editor could not open.',
    },
  );
  assert.deepEqual(
    sanitizedEditorErrorPresentation({
      kind: 'viewer-load',
      message: 'The document view could not be refreshed. Continue editing or cancel.',
      recovery: null,
    }),
    {
      kind: 'viewer-load',
      title: 'Document preview needs attention',
      body: 'The document view could not be refreshed. Continue editing or cancel.',
      recovery: null,
      mode: 'compact',
      maxVisibleLines: 2,
      accessibilityText:
        'Document preview needs attention. The document view could not be refreshed. Continue editing or cancel.',
    },
  );
});

test('edit-operation failures stay actionable without offering an unsafe replay', () => {
  assert.deepEqual(
    sanitizedEditorErrorPresentation({
      kind: 'edit-operation',
      message: 'That redaction edit could not be applied.',
      recovery: null,
    }),
    {
      kind: 'edit-operation',
      title: 'Edit could not be applied',
      body: 'Your last edit was not applied. Continue editing or cancel.',
      recovery: null,
      mode: 'compact',
      maxVisibleLines: 2,
      accessibilityText:
        'Edit could not be applied. Your last edit was not applied. Continue editing or cancel. That redaction edit could not be applied.',
    },
  );
});

/* Keep the initial loading error blocking while loaded-document errors preserve the workspace. */
test('document-load errors remain retryable only before the workspace is available', () => {
  assert.equal(
    sanitizedEditorErrorPresentation({
      kind: 'document-load',
      message: 'The Sanitized Report editor could not open.',
      recovery: 'load',
    }).recovery,
    'load',
  );
  assert.equal(
    sanitizedEditorErrorPresentation({
      kind: 'viewer-load',
      message: 'The document view could not be refreshed. Continue editing or cancel.',
      recovery: null,
    }).recovery,
    null,
  );
});
