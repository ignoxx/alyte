# Issue 66 — Gemma 4 E2B device evaluation

This directory records the reproducible procedure for the Gemma 4 E2B feasibility run. Device
aggregates are checked in only after an unlocked, signed run has been verified to contain
aggregate-only evidence.

The evaluator uses the exact same six-locale, 12-measurement synthetic contract as issue #50.
Only the target GGUF, artifact path/name/checksum metadata, and prompt template differ. Gemma
attempt 2 uses the immutable task-instruction bundle
`alyte.gemma4-e2b-evaluation.prompt.v2`; it changes only row-grouping instructions and leaves the
chat control tokens, schema, grammar, validator, and scorer unchanged. No model weights, prompts,
raw responses, OCR text, or personal data belong in this repository or the result bundle.

## Attempt 1 evidence

[`aggregate-attempt-1-gemma4-e2b.json`](aggregate-attempt-1-gemma4-e2b.json) is the safe aggregate
from the first paired-device attempt. It is retained with an attempt-specific name so it cannot be
confused with the v2 prompt-bundle run: 10 of 12 rows were referenced (83.33% recall), 2 proposals
were accepted and correct (100% accepted precision), and the review burden was 10 rows. The six
failures were five `duplicate-source-row` failures and one `malformed-schema` failure. That
observed grouping failure motivates the v2 Gemma task instructions above; it does not change the
fixtures, expected rows, grammar, validator, or scorer.

## Prepare the external contract

Generate the Gemma contract outside the repository and verify the generated file before the device
run:

```sh
mkdir -p "$ALYTE_MODEL_EVAL_CACHE"
npx tsx scripts/model-evaluation-contract.ts \
  --candidate gemma4 \
  --output "$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v2.json"
npx tsx scripts/model-evaluation-contract.ts \
  --candidate gemma4 \
  --output "$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v2.json" \
  --check
```

The target-specific model must already exist at:

```text
$ALYTE_MODEL_EVAL_CACHE/gemma-4-E2B-it-Q4_0.gguf
```

The runner verifies the exact 2,841,481,184-byte artifact and SHA-256
`8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52`; it never downloads the GGUF.
The contract separately pins the upstream source model `google/gemma-4-E2B-it` at revision
`3e22461f65e89153144f8adb70e3b8c2cc9845a7`; this is distinct from the converted GGUF repository
revision and is checked before the evaluator build.

## Run on the paired current device

Use the same external pinned llama.cpp checkout and XCFramework variables as issue #50, then run:

```sh
ALYTE_MODEL_EVAL_CANDIDATE=gemma4 \
ALYTE_MODEL_EVAL_DEVICE_UDID=9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9 \
ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID=00008150-001875AC142A401C \
ALYTE_MODEL_EVAL_CONTRACT_PATH="$ALYTE_MODEL_EVAL_CACHE/evaluation-contract-v2.json" \
ALYTE_MODEL_EVAL_CACHE="$ALYTE_MODEL_EVAL_CACHE" \
ALYTE_MODEL_EVAL_RUNTIME_SOURCE="$ALYTE_MODEL_EVAL_RUNTIME_SOURCE" \
ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK="$ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK" \
ALYTE_MODEL_EVAL_DERIVED_DATA="$ALYTE_MODEL_EVAL_DERIVED_DATA" \
ALYTE_MODEL_EVAL_XCRESULT="$ALYTE_MODEL_EVAL_XCRESULT" \
ALYTE_MODEL_EVAL_TEAM_ID="$ALYTE_MODEL_EVAL_TEAM_ID" \
./scripts/run-model-evaluation-device.sh
```

`ALYTE_MODEL_EVAL_DEVICE_UDID` is the CoreDevice identifier used by `devicectl`; the Xcode and
`xctrace` destination uses the hardware UDID in `ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID`. If the
latter is omitted, the runner resolves `hardwareProperties.udid` from `devicectl device info
details` and fails closed if it cannot do so. The CoreDevice state must be `connected` or the
legacy `available` state.

Set `ALYTE_MODEL_EVAL_AGGREGATE_PATH` to a new external path when retaining the aggregate. Keep the
phone unlocked for XCTest. The script uninstalls the temporary evaluator app on exit and never
places the model in the app bundle.
