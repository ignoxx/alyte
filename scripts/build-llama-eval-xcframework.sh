#!/bin/zsh
set -euo pipefail

# Build only the pinned runtime; this script never downloads model weights and never writes into
# the Alyte repository. The source checkout and llama.cpp build output are external task cache data.
: "${ALYTE_MODEL_EVAL_RUNTIME_SOURCE:?Set ALYTE_MODEL_EVAL_RUNTIME_SOURCE to an external llama.cpp checkout}"

readonly pinned_runtime_revision="bb4caa7540188872173c44d161602d9271386413"
readonly source="${ALYTE_MODEL_EVAL_RUNTIME_SOURCE}"
readonly alyte_repo_root="$(cd "$(dirname "$0")/.." && pwd)"

case "${source}" in
  "${alyte_repo_root}"|"${alyte_repo_root}"/*)
    print -u2 "Runtime source must be outside the Alyte repository"
    exit 2
    ;;
esac

if [[ ! -x "${source}/build-xcframework.sh" ]]; then
  print -u2 "Missing pinned llama.cpp build script: ${source}/build-xcframework.sh"
  exit 2
fi
if [[ "$(git -C "${source}" rev-parse HEAD)" != "${pinned_runtime_revision}" ]]; then
  print -u2 "Runtime checkout is not pinned to ${pinned_runtime_revision}"
  exit 2
fi
if [[ -n "$(git -C "${source}" status --porcelain --untracked-files=all)" ]]; then
  print -u2 "Runtime checkout must be clean before building the pinned XCFramework"
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
readonly device_framework="${framework}/ios-arm64/llama.framework"
readonly device_binary="${device_framework}/llama"
readonly manifest="${framework}.alyte-eval.json"
if [[ ! -f "${device_binary}" || ! -f "${device_framework}/Headers/llama.h" ]]; then
  print -u2 "Pinned runtime build is missing the llama device binary or public header"
  exit 2
fi
if [[ -n "$(git -C "${source}" status --porcelain --untracked-files=all)" ]]; then
  print -u2 "Runtime checkout changed while building the pinned XCFramework"
  exit 2
fi
readonly device_sha256="$(shasum -a 256 "${device_binary}" | cut -d ' ' -f 1)"
node - "${manifest}" "${framework}" "${device_sha256}" "${pinned_runtime_revision}" <<'NODE'
const fs = require('node:fs');
const [manifest, frameworkPath, deviceBinarySha256, runtimeRevision] = process.argv.slice(2);
fs.writeFileSync(manifest, `${JSON.stringify({
  runtimeRepository: 'ggml-org/llama.cpp',
  runtimeRelease: 'v0.2.0',
  runtimeRevision,
  sourceRevision: runtimeRevision,
  platform: 'ios-device',
  module: 'llama',
  frameworkPath,
  deviceBinarySha256,
}, null, 2)}\n`);
NODE
print "${framework}"
print "${manifest}"
