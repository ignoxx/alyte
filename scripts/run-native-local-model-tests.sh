#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly package_path="${repo_root}/scripts/native-local-model-tests"
readonly runtime_activation_source="${repo_root}/apps/mobile/modules/alyte-local-models/ios/AlyteLocalModelRuntimeActivation.c"
readonly runtime_activation_header="${repo_root}/apps/mobile/modules/alyte-local-models/ios"
readonly runtime_activation_harness="${package_path}/RuntimeActivationHarness.c"

command -v swift >/dev/null 2>&1 || {
  echo "swift is required to run Alyte local-model native tests" >&2
  exit 1
}

swift test --package-path "${package_path}"

readonly runtime_activation_build="$(mktemp -d "${TMPDIR:-/tmp}/alyte-local-model-runtime.XXXXXX")"
trap 'rm -rf "${runtime_activation_build}"' EXIT
clang -std=c11 -Wall -Wextra -Werror \
  -I "${runtime_activation_header}" \
  "${runtime_activation_source}" \
  "${runtime_activation_harness}" \
  -o "${runtime_activation_build}/activation"
"${runtime_activation_build}/activation"
