import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertEvaluationCandidateManifest,
  candidateEvaluationManifests,
  gemmaEvaluationManifest,
  qwenEvaluationManifest,
  qwen3EvaluationManifest,
  sourceSelectorCandidateManifests,
  lfm2_350mExtractEvaluationManifest,
  lfm2_1_2bExtractEvaluationManifest,
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
    assert.equal(qwen3EvaluationManifest.model.filename, 'Qwen3-1.7B-Q4_K_M.gguf');
    assert.equal(qwen3EvaluationManifest.model.repository, 'ggml-org/Qwen3-1.7B-GGUF');
    assert.equal(
      qwen3EvaluationManifest.model.revision,
      'daeb8e2d528a760970442092f6bf1e55c3b659eb',
    );
    assert.equal(qwen3EvaluationManifest.model.bytes, 1_282_439_264);
    assert.equal(
      qwen3EvaluationManifest.model.sha256,
      'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    );
    assert.equal(qwen3EvaluationManifest.prompt.chatTemplate, 'qwen3-v1');
    assert.equal(qwen3EvaluationManifest.prompt.thinking, false);
    assert.deepEqual(Object.keys(candidateEvaluationManifests).sort(), ['gemma4', 'qwen']);
    assert.deepEqual(Object.keys(sourceSelectorCandidateManifests).sort(), [
      'gemma4',
      'lfm2-1.2b-extract',
      'lfm2-350m-extract',
      'qwen',
      'qwen3',
    ]);
  });

  it('pins both LFM2 Extract artifacts and their source templates', () => {
    const cases = [
      [
        lfm2_350mExtractEvaluationManifest,
        'LFM2-350M-Extract-Q4_K_M.gguf',
        229_310_080,
        '687a31c3e7864647aa181e1feb156e4e5da33978c174d7dbf0d289f6014a5621',
        'b8f758b9ff37b0cad9bedfc5223cb71e31aebe9c',
        'd99a6f06ea16a2f83998789389a64b66d40c4198',
        'LiquidAI/LFM2-350M-Extract-GGUF',
        'LiquidAI/LFM2-350M-Extract',
      ],
      [
        lfm2_1_2bExtractEvaluationManifest,
        'LFM2-1.2B-Extract-Q4_K_M.gguf',
        730_894_048,
        '09b60b507ee7d1698b2b4dfce184c75083d7790c7701910ed60afa2801024702',
        'ef65f6005f6a4de8a8e7a60279242b1c96be229a',
        'e68bdd9af162cfca7d806b456a7a56406e6194fa',
        'LiquidAI/LFM2-1.2B-Extract-GGUF',
        'LiquidAI/LFM2-1.2B-Extract',
      ],
    ] as const;
    for (const [
      manifest,
      filename,
      bytes,
      sha256,
      revision,
      sourceRevision,
      modelRepository,
      sourceRepository,
    ] of cases) {
      assert.equal(manifest.model.filename, filename);
      assert.equal(manifest.model.repository, modelRepository);
      assert.equal(manifest.model.bytes, bytes);
      assert.equal(manifest.model.sha256, sha256);
      assert.equal(manifest.model.revision, revision);
      assert.equal(manifest.model.publisher, 'LiquidAI');
      assert.equal(manifest.model.license, 'LFM-Open-License-v1.0');
      assert.equal(manifest.model.format, 'GGUF');
      assert.equal(manifest.model.quantization, 'Q4_K_M');
      assert.equal(manifest.sourceModel?.repository, sourceRepository);
      assert.equal(manifest.sourceModel?.revision, sourceRevision);
      assert.equal(manifest.sourceModel?.chatTemplateRevision, sourceRevision);
      assert.equal(
        manifest.sourceModel?.chatTemplateUrl,
        `https://huggingface.co/${manifest.sourceModel?.repository}/resolve/${sourceRevision}/chat_template.jinja`,
      );
      assert.equal(manifest.prompt.chatTemplate, 'lfm2-v1');
      assert.equal(manifest.prompt.thinking, false);
      assert.deepEqual(manifest.languages, ['en', 'ar', 'zh', 'fr', 'de', 'ja', 'ko', 'pt', 'es']);
      assert.equal(manifest.languages.includes('lt'), false);
      assert.equal(manifest.languages.includes('pl'), false);
    }
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
