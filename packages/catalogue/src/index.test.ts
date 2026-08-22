import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { catalogueManifest } from './index.js';

describe('catalogue boundary', () => {
  it('ships a versioned, reviewable manifest', () => {
    assert.equal(catalogueManifest.status, 'review-pending');
    assert.match(catalogueManifest.version, /^\d+\.\d+\.\d+$/);
  });
});
