import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRedaction,
  createSanitizationRecipe,
  removeRedaction,
  reorderSanitizationPages,
  sanitizationRecipeHash,
  transformRectForPage,
  updateRedaction,
  updateSanitizationPage,
  type NormalizedRect,
} from './sanitization.js';

const crop: NormalizedRect = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
const sourceRect: NormalizedRect = { x: 0.2, y: 0.3, width: 0.1, height: 0.1 };

function recipe() {
  return createSanitizationRecipe('report-1', [
    { pageIndex: 0, selected: true, crop: null, rotation: 0, redactions: [] },
    { pageIndex: 1, selected: false, crop, rotation: 90, redactions: [] },
  ]);
}

describe('sanitization recipe domain', () => {
  it('keeps edits immutable and preserves the original page recipe', () => {
    const original = recipe();
    const withRegion = addRedaction(original, 0, {
      id: 'redaction-1',
      rect: sourceRect,
      origin: 'user',
      label: 'identifier',
    });
    const moved = updateRedaction(withRegion, 0, 'redaction-1', {
      x: 0.25,
      y: 0.3,
      width: 0.08,
      height: 0.1,
    });
    assert.equal(original.pages[0]?.redactions.length, 0);
    assert.equal(withRegion.pages[0]?.redactions[0]?.rect.x, 0.2);
    assert.equal(moved.pages[0]?.redactions[0]?.rect.x, 0.25);
    assert.equal(removeRedaction(moved, 0, 'redaction-1').pages[0]?.redactions.length, 0);
    assert.equal(sanitizationRecipeHash(original), sanitizationRecipeHash(recipe()));
    assert.notEqual(sanitizationRecipeHash(original), sanitizationRecipeHash(withRegion));
  });

  it('transforms redactions after crop and clockwise rotation', () => {
    const transformed = transformRectForPage(sourceRect, crop, 90);
    // Local crop coordinates are x=.2, y=.25, w=.2, h=.25; clockwise rotation maps them to
    // x=.5, y=.2, w=.25, h=.2.
    assert.deepEqual(transformed, { x: 0.5, y: 0.2, width: 0.25, height: 0.2 });
    const rotated = transformRectForPage(sourceRect, null, 180);
    assert.ok(Math.abs(rotated.x - 0.7) < 1e-12);
    assert.deepEqual(
      { y: rotated.y, width: rotated.width, height: rotated.height },
      { y: 0.6, width: 0.1, height: 0.1 },
    );
    assert.throws(() => transformRectForPage({ x: 0, y: 0, width: 0.2, height: 0.2 }, crop, 0));
  });

  it('supports page selection and rotation without changing other pages', () => {
    const changed = updateSanitizationPage(recipe(), 1, { selected: true, rotation: 270 });
    assert.equal(changed.pages[0]?.selected, true);
    assert.equal(changed.pages[1]?.selected, true);
    assert.equal(changed.pages[1]?.rotation, 270);
    assert.equal(recipe().pages[1]?.rotation, 90);
  });

  it('allows only a complete, duplicate-free page reorder', () => {
    const reordered = reorderSanitizationPages(recipe(), [1, 0]);
    assert.deepEqual(
      reordered.pages.map((page) => page.pageIndex),
      [1, 0],
    );
    assert.throws(() => reorderSanitizationPages(recipe(), [0]));
    assert.throws(() => reorderSanitizationPages(recipe(), [0, 0]));
  });

  it('rejects duplicate pages, out-of-bounds regions, and non-right-angle rotation', () => {
    assert.throws(() =>
      createSanitizationRecipe('report-1', [
        { pageIndex: 0, selected: true, crop: null, rotation: 0, redactions: [] },
        { pageIndex: 0, selected: true, crop: null, rotation: 0, redactions: [] },
      ]),
    );
    assert.throws(() =>
      createSanitizationRecipe('report-1', [
        {
          pageIndex: 0,
          selected: true,
          crop: null,
          rotation: 0,
          redactions: [
            {
              id: 'outside',
              rect: { x: 0.9, y: 0, width: 0.2, height: 0.2 },
              origin: 'user',
              label: null,
            },
          ],
        },
      ]),
    );
    assert.throws(() => updateSanitizationPage(recipe(), 0, { rotation: 45 as never }));
  });
});
