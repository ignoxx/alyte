#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly project="${repo_root}/apps/mobile/modules/alyte-vision/AlyteVisionBoundary.xcodeproj"
readonly scheme="AlyteVisionBoundary"
simulator_id="${ALYTE_IOS_SIMULATOR_UDID:-}"
booted_by_script=0

cleanup() {
  if [[ "${booted_by_script}" -eq 1 && -n "${simulator_id}" ]]; then
    xcrun simctl shutdown "${simulator_id}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command in xcodebuild xcrun jq; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "${command} is required to run AlyteVision native tests" >&2
    exit 1
  }
done

if [[ -z "${simulator_id}" ]]; then
  simulator_id="$(xcrun simctl list devices available -j | jq -r '
    [.devices[][] | select(.isAvailable == true and (.name | startswith("iPhone"))) |
      select(.state == "Booted" or .state == "Shutdown")][0].udid // empty
  ')"
fi
if [[ -z "${simulator_id}" ]]; then
  echo "No available iPhone Simulator; install an iOS 26 Simulator runtime" >&2
  exit 1
fi

state="$(xcrun simctl list devices -j | jq -r --arg id "${simulator_id}" '
  [.devices[][] | select(.udid == $id) | .state][0] // empty
')"
if [[ "${state}" == "Shutdown" ]]; then
  xcrun simctl boot "${simulator_id}" >/dev/null
  xcrun simctl bootstatus "${simulator_id}" -b >/dev/null
  booted_by_script=1
elif [[ "${state}" != "Booted" ]]; then
  echo "Simulator ${simulator_id} is not booted or shutdown (state: ${state:-unknown})" >&2
  exit 1
fi

xcodebuild \
  -project "${project}" \
  -scheme "${scheme}" \
  -destination "id=${simulator_id}" \
  test \
  CODE_SIGNING_ALLOWED=NO
