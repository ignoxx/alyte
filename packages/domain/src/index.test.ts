import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId } from './index.js';

describe('canonical IDs', () => {
  it('accepts stable lowercase identifiers', () => {
    assert.equal(canonicalId('biomarker.ldl_c'), 'biomarker.ldl_c');
  });

  it('rejects display strings and whitespace', () => {
    assert.throws(() => canonicalId('LDL Cholesterol'));
  });
});
