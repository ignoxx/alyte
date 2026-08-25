# Issue 66 — Gemma 4 E2B device evaluation

This directory records the reproducible procedure for the Gemma 4 E2B feasibility run. The
physical-device aggregate is intentionally not checked in by the harness owner; Sol adds
aggregate-only evidence after an unlocked, signed device run.

The evaluator uses the exact same six-locale, 12-measurement synthetic contract as issue #50.
Only the target GGUF, artifact path/name/checksum metadata, and prompt template differ. No model
weights, prompts, raw responses, OCR text, or personal data belong in this repository or the
result bundle.

## Prepare the external contract

Generate the Gemma contract outside the repository and verify the generated file before the device
run:

```sh
mkdir -p "$ALYTE_MODEL_EVAL_CACHE"
npx tsx scripts/model-evaluation-contract.ts \
  --candidate gemma4 \
  --output "$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v1.json"
npx tsx scripts/model-evaluation-contract.ts \
  --candidate gemma4 \
  --output "$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v1.json" \
  --check
```

The target-specific model must already exist at:

```text
$ALYTE_MODEL_EVAL_CACHE/gemma-4-E2B-it-Q4_0.gguf
```

The runner verifies the exact 2,841,481,184-byte artifact and SHA-256
`8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`; it never downloads the GGUF.

## Run on the paired current device

Use the same external pinned llama.cpp checkout and XCFramework variables as issue #50, then run:

```sh
ALYTE_MODEL_EVAL_CANDIDATE=gemma4 \
ALYTE_MODEL_EVAL_CONTRACT_PATH="$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v1.json" \
ALYTE_MODEL_EVAL_CACHE="$ALYTE_MODEL_EVAL_CACHE" \
ALYTE_MODEL_EVAL_RUNTIME_SOURCE="$ALYTE_MODEL_EVAL_RUNTIME_SOURCE" \
ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK="$ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK" \
ALYTE_MODEL_EVAL_DERIVED_DATA="$ALYTE_MODEL_EVAL_DERIVED_DATA" \
ALYTE_MODEL_EVAL_XCRESULT="$ALYTE_MODEL_EVAL_XCRESULT" \
ALYTE_MODEL_EVAL_TEAM_ID="$ALYTE_MODEL_EVAL_TEAM_ID" \
./scripts/run-model-evaluation-device.sh
```

Set `ALYTE_MODEL_EVAL_AGGREGATE_PATH` to a new external path when retaining the aggregate. Keep the
phone unlocked for XCTest. The script uninstalls the temporary evaluator app on exit and never
places the model in the app bundle.
