#!/bin/zsh
set -euo pipefail

if [[ "$#" != "1" || ! -f "$1" ]]; then
  print -u2 "Expected one existing binary path"
  exit 2
fi

binary="$1"
scratch_directory=""
if ! scratch_directory="$(mktemp -d "${TMPDIR:-/tmp}/alyte-eval-llama-hash.XXXXXX")"; then
  print -u2 "Could not create a hashing workspace"
  exit 1
fi

cleanup() {
  local exit_code=$?
  set +e
  if [[ -n "${scratch_directory}" ]]; then
    rm -rf "${scratch_directory}"
    local cleanup_code=$?
    if [[ "${exit_code}" == "0" && "${cleanup_code}" != "0" ]]; then
      exit_code="${cleanup_code}"
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

if ! ditto "${binary}" "${scratch_directory}/binary"; then
  print -u2 "Could not copy binary for hashing"
  exit 1
fi

# Unsigned frameworks are valid inputs; signed ones must be stripped successfully before their
# appended code-signature blob is ignored for identity comparison.
if codesign --display --verbose=2 "${scratch_directory}/binary" >/dev/null 2>&1; then
  if ! codesign --remove-signature "${scratch_directory}/binary" >/dev/null 2>&1; then
    print -u2 "Could not remove the binary code signature for hashing"
    exit 1
  fi
fi

hash_line=""
if ! hash_line="$(shasum -a 256 "${scratch_directory}/binary")"; then
  print -u2 "Could not hash binary"
  exit 1
fi
hash="${hash_line%% *}"
if [[ -z "${hash}" ]]; then
  print -u2 "Binary hash was empty"
  exit 1
fi
print -r -- "${hash}"
