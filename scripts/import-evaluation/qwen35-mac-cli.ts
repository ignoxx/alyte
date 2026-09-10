/**
 * Evaluation-only Qwen3.5-2B adapter.
 *
 * The production manifest describes the shipped Qwen3-VL pack. This module keeps the same
 * local llama-mtmd/document grammar seam while pinning the separately cached Qwen3.5 artifacts
 * and their measured hashes in the evaluation provenance.
 */
import {
  createQwenMacDocumentVLM as createBaseQwenMacDocumentVLM,
  DEFAULT_BINARY,
  type QwenMacOptions,
  type QwenMacPaths,
} from './qwen-mac-cli';

export const QWEN35_MODEL_ID = 'qwen3.5-2b-q4_k_m' as const;
export const QWEN35_MODEL_REVISION =
  'lm-studio-community/Qwen3.5-2B-GGUF@0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc' as const;
export const QWEN35_MODEL_SHA256 =
  '0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc' as const;
export const QWEN35_PROJECTOR_SHA256 =
  '31a8b681d34e70eaef158f7bacf1bc726a7a29babd185119ab3ebf402890dfbc' as const;
export const QWEN35_RUNTIME_REVISION = 'llama.cpp-c1d0e7a00-build-10621' as const;
export const QWEN35_DEFAULT_MODEL =
  '/Users/ignas/.cache/lm-studio/models/lmstudio-community/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf' as const;
export const QWEN35_DEFAULT_MMPROJ =
  '/Users/ignas/.cache/lm-studio/models/lmstudio-community/Qwen3.5-2B-GGUF/mmproj-Qwen3.5-2B-BF16.gguf' as const;

export async function createQwenMacDocumentVLM(
  options: QwenMacOptions = {},
): ReturnType<typeof createBaseQwenMacDocumentVLM> {
  const paths: Partial<QwenMacPaths> = {
    binary: options.paths?.binary ?? DEFAULT_BINARY,
    model: options.paths?.model ?? QWEN35_DEFAULT_MODEL,
    mmproj: options.paths?.mmproj ?? QWEN35_DEFAULT_MMPROJ,
    ...(options.paths?.privateRoot === undefined ? {} : { privateRoot: options.paths.privateRoot }),
  };
  return createBaseQwenMacDocumentVLM({
    ...options,
    paths,
    provenance: {
      adapterVersion: 'alyte.qwen3.5-2b.document-extractor.mac-cli.eval.v1',
      modelId: QWEN35_MODEL_ID,
      modelRevision: QWEN35_MODEL_REVISION,
      modelExpectedSha256: QWEN35_MODEL_SHA256,
      projectorExpectedSha256: QWEN35_PROJECTOR_SHA256,
      runtimeRevision: QWEN35_RUNTIME_REVISION,
      ...options.provenance,
    },
  });
}
