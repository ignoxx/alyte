#!/bin/zsh
set -euo pipefail

# Build only the pinned runtime; this script never downloads model weights and never writes into
# the Alyte repository. The source checkout and llama.cpp build output are external task cache data.
: "${ALYTE_MODEL_EVAL_RUNTIME_SOURCE:?Set ALYTE_MODEL_EVAL_RUNTIME_SOURCE to an external llama.cpp checkout}"

readonly pinned_runtime_revision="bb4caa7540188872173c44d161602d9271386413"
readonly source="${ALYTE_MODEL_EVAL_RUNTIME_SOURCE}"

if [[ ! -x "${source}/build-xcframework.sh" ]]; then
  print -u2 "Missing pinned llama.cpp build script: ${source}/build-xcframework.sh"
  exit 2
fi
if [[ "$(git -C "${source}" rev-parse HEAD)" != "${pinned_runtime_revision}" ]]; then
  print -u2 "Runtime checkout is not pinned to ${pinned_runtime_revision}"
  exit 2
fi

# v0.2.0's upstream script creates build-apple/llama.xcframework beside the exact checkout.
# The output remains external and is intentionally not copied into DerivedData or the repository.
(cd "${source}" && ./build-xcframework.sh ios-device)
readonly framework="${source}/build-apple/llama.xcframework"
if [[ ! -d "${framework}" ]]; then
  print -u2 "Pinned runtime build did not produce ${framework}"
  exit 2
fi
print "${framework}"
