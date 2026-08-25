#!/bin/zsh
set -euo pipefail

# This is the tracked device-build entry point. It builds the exact pinned llama.cpp checkout
# outside this repository, emits its provenance/checksum manifest, then validates the artifact
# consumed by the podspec. Model weights are never downloaded or copied by this step.
readonly runtime_framework="${ALYTE_MODEL_EVAL_RUNTIME_SOURCE:?Set ALYTE_MODEL_EVAL_RUNTIME_SOURCE to an external llama.cpp checkout}/build-apple/llama.xcframework"
scripts/build-llama-eval-xcframework.sh >/tmp/alyte-local-model-runtime-build.log
ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK="${runtime_framework}" \
  node scripts/check-local-model-runtime.mjs --variant "${APP_VARIANT:-production}"
print "Verified pinned local-model runtime: ${runtime_framework}"
