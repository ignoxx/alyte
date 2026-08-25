import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanonicalEvaluationContract } from './contract';

describe('canonical native evaluation contract', () => {
  it('contains the complete two-row multilingual corpus and bounded prompts', () => {
    const contract = createCanonicalEvaluationContract();
    assert.equal(contract.contractVersion, 'alyte.qwen-evaluation.contract.v1');
    assert.equal(contract.fixtures.length, 6);
    assert.deepEqual(
      contract.fixtures.map((fixture) => [
        fixture.language,
        fixture.observations.length,
        fixture.expected.length,
      ]),
      [
        ['en', 8, 2],
        ['de', 8, 2],
        ['lt', 8, 2],
        ['pl', 8, 2],
        ['fr', 8, 2],
        ['es', 8, 2],
      ],
    );
    assert.ok(
      contract.fixtures.some((fixture) =>
        fixture.observations.some((item) => item.alternatives.length > 0),
      ),
    );
    for (const fixture of contract.fixtures) {
      assert.ok(Buffer.byteLength(fixture.serializedInput) <= contract.maxInputBytes);
      assert.equal(fixture.serializedInput.includes('sourceFacts'), false);
      assert.equal(fixture.serializedInput.includes('rowId'), false);
    }
  });
});
