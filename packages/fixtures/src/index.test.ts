import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadShowcaseSnapshot } from './index.js';

describe('showcase boundary', () => {
  it('is deterministic and synthetic outside production', () => {
    const first = loadShowcaseSnapshot('development', true);
    const second = loadShowcaseSnapshot('development', true);

    assert.deepEqual(first, second);
    assert.equal(first?.label, 'Synthetic showcase data');
    assert.deepEqual(
      first?.intakeEvents.map((event) => event.name),
      ['Synthetic breakfast', 'Synthetic drink'],
    );
  });

  it('cannot be enabled in production', () => {
    assert.throws(() => loadShowcaseSnapshot('production', true), /disabled in production/);
  });
});
