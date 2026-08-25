#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly package_path="${repo_root}/scripts/native-local-model-tests"

command -v swift >/dev/null 2>&1 || {
  echo "swift is required to run Alyte local-model native tests" >&2
  exit 1
}

swift test --package-path "${package_path}"
