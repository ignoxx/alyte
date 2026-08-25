# Issue 50 — Qwen 3.5 0.8B evaluation harness

This directory records the reproducible harness and the evidence boundary. It intentionally does
not contain model weights, prompts, OCR dumps, model responses, screenshots of health content, or
device result bundles. A future device run may add a scrubbed aggregate JSON report here only after
checking that it contains counts, timings, memory, thermal state, storage sizes, and pinned
provenance—never source text or raw output.

## Pinned preflight

- Runtime: [llama.cpp v0.2.0](https://github.com/ggml-org/llama.cpp/releases/tag/v0.2.0), commit
  `bb4caa7540188872173c44d161602d9271386413`.
- Runtime iOS build: the pinned
  [`build-xcframework.sh`](https://github.com/ggml-org/llama.cpp/blob/bb4caa7540188872173c44d161602d9271386413/build-xcframework.sh)
  provides `ios-device` and `ios-sim` builds. The source contains Qwen35 architecture support and
  the public [`llama_sampler_init_grammar`](https://github.com/ggml-org/llama.cpp/blob/bb4caa7540188872173c44d161602d9271386413/include/llama.h#L1411-L1418)
  GBNF API.
- Model: public, ungated
  [`ggml-org/Qwen3.5-0.8B-GGUF`](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF), commit
  `8fea620810c4afa23dd6443f999a48574c1611a3`.
- Artifact: `Qwen3.5-0.8B-Q4_0.gguf`, GGUF Q4_0, publisher Qwen / ggml-org, Apache-2.0,
  563,036,064 bytes, SHA-256
  `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`.
- Artifact metadata: [pinned Hugging Face tree](https://huggingface.co/api/models/ggml-org/Qwen3.5-0.8B-GGUF/tree/8fea620810c4afa23dd6443f999a48574c1611a3).
- Grammar runs with Qwen thinking disabled (`temperature = 0`, bounded context/output). The
  grammar constrains shape; the deterministic validator remains authoritative for IDs and safety.

## Run procedure

1. Clone the exact llama.cpp commit outside this repository and build its iOS device slice. The
   checked-in helper validates the immutable commit before invoking the upstream build:

```sh
export ALYTE_MODEL_EVAL_RUNTIME_SOURCE=/Users/ignas/.cache/alyte-model-eval-runtime/llama.cpp
./scripts/build-llama-eval-xcframework.sh
```

   The upstream script writes `build-apple/llama.xcframework` with an `ios-arm64/llama.framework`
   device slice.

2. Manually stage the exact GGUF outside this repository from the immutable URL above.
   Stage it at
   `/Users/ignas/.cache/alyte-model-eval/Qwen3.5-0.8B-Q4_0.gguf` (or another explicit path).
   Verify the byte size and SHA-256 before use. Do not place it in Git, an app bundle, DerivedData,
   an xcresult, source, fixtures, logs, or screenshots.
3. Set task-specific paths and run:

```sh
export ALYTE_MODEL_EVAL_CACHE=/Users/ignas/.cache/alyte-model-eval
export ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK=/Users/ignas/.cache/alyte-model-eval-runtime/llama.cpp/build-apple/llama.xcframework
export ALYTE_MODEL_EVAL_DERIVED_DATA=/Users/ignas/.cache/alyte-model-eval-derived
export ALYTE_MODEL_EVAL_XCRESULT=/Users/ignas/.cache/alyte-model-eval.xcresult
export ALYTE_MODEL_EVAL_DEVICE_UDID=9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9
./scripts/run-model-evaluation-device.sh
```

The script validates the exact target, external paths, artifact size, and SHA-256, enables the
`ALYTE_LLAMA_EVAL` native bridge, embeds only the externally staged runtime, and runs only
`AlyteModelEvaluationTests` on the requested device. The XCTest invokes all six synthetic locale
prompts and writes only the aggregate report path. It never substitutes a simulator for device
evidence. The paired current iPhone was offline during this implementation run, and no Qwen
weights were staged, so no current-device Qwen metrics are claimed here. The supported floor is an
iPhone SE (2nd generation/A13); no floor device is connected, so floor latency/memory/thermal
evidence remains pending.

## What is measured

The native evaluator uses monotonic clock timings, resident memory, and
`ProcessInfo.processInfo.thermalState`. It distinguishes cold load from warm inference and records
model-pack/runtime bytes. Qwen receives an explicit ChatML assistant prefix ending in
`<think>\n\n</think>\n\n` to disable thinking before grammar-constrained generation; the sampler chain is
grammar followed by greedy sampling. TypeScript scoring reports model row recall separately from
accepted end-to-end precision, exact source value/unit/interval preservation, schema/ID/duplicate/
authoritative-field failures, and review burden. Only aggregate metrics and pinned provenance may
be retained.

No production extraction or `report-service` code is imported by the evaluation target. The
production downloader/model lifecycle (#51), production extraction integration (#52), cloud, and
medical copy are deliberately excluded.
