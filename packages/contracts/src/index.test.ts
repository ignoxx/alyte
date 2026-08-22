import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION } from './index.js';

describe('cloud contracts', () => {
  it('has an explicit version', () => {
    assert.match(CONTRACT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });
});
