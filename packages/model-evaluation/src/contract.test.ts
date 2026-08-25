import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCanonicalEvaluationContract } from './contract';
import { gemmaEvaluationManifest, qwenEvaluationManifest } from './manifest';

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

  it('selects Gemma provenance and template without changing the fixture corpus', () => {
    const qwen = createCanonicalEvaluationContract(qwenEvaluationManifest);
    const gemma = createCanonicalEvaluationContract(gemmaEvaluationManifest);
    assert.equal(qwen.contractVersion, 'alyte.qwen-evaluation.contract.v1');
    assert.equal(gemma.contractVersion, 'alyte.gemma4-e2b-evaluation.contract.v1');
    assert.equal(gemma.promptBundleVersion, 'alyte.gemma4-e2b-evaluation.prompt.v2');
    assert.equal(gemma.manifestVersion, gemmaEvaluationManifest.manifestVersion);
    assert.equal(gemma.model.repository, 'ggml-org/gemma-4-E2B-it-GGUF');
    assert.equal(gemma.model.filename, 'gemma-4-E2B-it-Q4_0.gguf');
    assert.equal(
      gemma.model.sha256,
      '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    );
    assert.deepEqual(gemma.sourceModel, {
      id: 'gemma-4-e2b-it',
      repository: 'google/gemma-4-E2B-it',
      revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
    });
    assert.equal(gemma.chatTemplate, 'gemma4-v1');
    assert.equal(gemma.chatTemplateSource, 'explicit-pinned-google-gemma-4-template-v1');
    assert.equal(qwen.promptBundleVersion, undefined);
    assert.deepEqual(
      gemma.fixtures.map((fixture) => fixture.id),
      qwen.fixtures.map((fixture) => fixture.id),
    );
    assert.deepEqual(
      gemma.fixtures.map((fixture) => fixture.expected),
      qwen.fixtures.map((fixture) => fixture.expected),
    );
    assert.deepEqual(
      gemma.fixtures.map((fixture) => fixture.serializedInput),
      qwen.fixtures.map((fixture) => fixture.serializedInput),
    );
  });
});
