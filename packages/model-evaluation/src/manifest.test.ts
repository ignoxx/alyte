import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEvaluationCandidateManifest,
  candidateEvaluationManifests,
  gemmaEvaluationManifest,
  qwenEvaluationManifest,
} from './manifest';

describe('evaluation candidate manifests', () => {
  it('keeps the Qwen identity and pins the Gemma artifact independently', () => {
    assert.equal(qwenEvaluationManifest.model.filename, 'Qwen3.5-0.8B-Q4_0.gguf');
    assert.equal(qwenEvaluationManifest.model.bytes, 563_036_064);
    assert.equal(
      qwenEvaluationManifest.model.sha256,
      '57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf',
    );
    assert.equal(gemmaEvaluationManifest.model.filename, 'gemma-4-E2B-it-Q4_0.gguf');
    assert.equal(gemmaEvaluationManifest.model.bytes, 2_841_481_184);
    assert.equal(
      gemmaEvaluationManifest.model.sha256,
      '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    );
    assert.equal(gemmaEvaluationManifest.model.license, 'Apache-2.0');
    assert.equal(
      gemmaEvaluationManifest.promptBundleVersion,
      'alyte.gemma4-e2b-evaluation.prompt.v2',
    );
    assert.deepEqual(gemmaEvaluationManifest.sourceModel, {
      id: 'gemma-4-e2b-it',
      repository: 'google/gemma-4-E2B-it',
      revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
    });
    assert.equal(gemmaEvaluationManifest.prompt.chatTemplate, 'gemma4-v1');
    assert.equal(gemmaEvaluationManifest.prompt.thinking, false);
    assert.deepEqual(Object.keys(candidateEvaluationManifests).sort(), ['gemma4', 'qwen']);
  });

  it('rejects a tampered candidate identity before contract or aggregate emission', () => {
    const tampered = {
      ...gemmaEvaluationManifest,
      model: {
        ...gemmaEvaluationManifest.model,
        repository: 'ggml-org/other-GGUF',
      },
    };
    assert.throws(
      () => assertEvaluationCandidateManifest(tampered),
      /unsupported_evaluation_candidate_manifest/,
    );

    const tamperedPromptBundle = {
      ...gemmaEvaluationManifest,
      promptBundleVersion: 'alyte.gemma4-e2b-evaluation.prompt.v1',
    };
    assert.throws(
      () => assertEvaluationCandidateManifest(tamperedPromptBundle),
      /unsupported_evaluation_candidate_manifest/,
    );
  });
});
