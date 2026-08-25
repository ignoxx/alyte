#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly module_root="${repo_root}/apps/mobile/modules/alyte-protection"
readonly package_template="${repo_root}/scripts/native-tests/Package.swift"
readonly requested_simulator_name="${ALYTE_IOS_SIMULATOR_NAME:-}"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild is required to run AlyteProtection native tests" >&2
  exit 1
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun is required to run AlyteProtection native tests" >&2
  exit 1
fi
if ! command -v swift >/dev/null 2>&1; then
  echo "swift is required to resolve AlyteProtection native tests" >&2
  exit 1
fi

if ! grep -Eq "dependency ['\"]ZIPFoundation['\"], ['\"]0\.9\.20['\"]" \
  "${module_root}/ios/AlyteProtection.podspec"; then
  echo "AlyteProtection.podspec must pin ZIPFoundation to 0.9.20" >&2
  exit 1
fi

simulator_created=0
simulator_id=""
simulator_name=""
harness_root=""

cleanup() {
  if [[ "${simulator_created}" -eq 1 && -n "${simulator_id}" ]]; then
    xcrun simctl delete "${simulator_id}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${harness_root}" && -d "${harness_root}" ]]; then
    rm -rf "${harness_root}"
  fi
}
trap cleanup EXIT

simulator_selection="$(xcrun simctl list devices available | awk -v requested="${requested_simulator_name}" '
  function version_key(version, parts) {
    split(version, parts, ".")
    return (parts[1] + 0) * 1000000 + (parts[2] + 0) * 1000 + (parts[3] + 0)
  }
  function device_rank(name) {
    if (name ~ /^iPhone [0-9]+$/) return 0
    if (name ~ /^iPhone [0-9]+e$/) return 1
    return 2
  }
  /^-- iOS / {
    runtime_version = $3
    runtime_key = version_key(runtime_version)
    next
  }
  /iPhone/ && match($0, /\([A-F0-9-]{36}\)/) {
    name = substr($0, 1, RSTART - 1)
    sub(/^[[:space:]]+/, "", name)
    sub(/[[:space:]]+$/, "", name)
    id = substr($0, RSTART + 1, RLENGTH - 2)
    rank = device_rank(name)
    if (requested != "") {
      if (name == requested) {
        print name "\t" id
        exit
      }
      next
    }
    if (best_id == "" || runtime_key > best_runtime ||
        (runtime_key == best_runtime && rank < best_rank) ||
        (runtime_key == best_runtime && rank == best_rank && name < best_name)) {
      best_name = name
      best_id = id
      best_runtime = runtime_key
      best_rank = rank
    }
  }
  END {
    if (requested == "" && best_id != "") print best_name "\t" best_id
  }
')"

if [[ -n "${simulator_selection}" ]]; then
  simulator_name="${simulator_selection%%$'\t'*}"
  simulator_id="${simulator_selection#*$'\t'}"
else
  if [[ -n "${requested_simulator_name}" ]]; then
    echo "No available iPhone Simulator named '${requested_simulator_name}'. Set ALYTE_IOS_SIMULATOR_NAME to an available iPhone name or unset it for automatic selection." >&2
    exit 1
  fi

  runtime_id="$(xcrun simctl list runtimes available | awk '
    /com\.apple\.CoreSimulator\.SimRuntime\.iOS-/ {
      match($0, /com\.apple\.CoreSimulator\.SimRuntime\.iOS-[^ )]+/)
      print substr($0, RSTART, RLENGTH)
      exit
    }
  ')"
  device_type_id="$(xcrun simctl list devicetypes | awk '
    /^iPhone [0-9]+ \(/ {
      match($0, /com\.apple\.CoreSimulator\.SimDeviceType\.[^ )]+/)
      print substr($0, RSTART, RLENGTH)
      exit
    }
  ')"
  if [[ -z "${runtime_id}" || -z "${device_type_id}" ]]; then
    echo "No available iOS runtime and standard iPhone device type were found; install an iOS Simulator runtime in Xcode." >&2
    exit 1
  fi

  simulator_name="AlyteProtection Ephemeral iPhone"
  if ! simulator_id="$(xcrun simctl create "${simulator_name}" "${device_type_id}" "${runtime_id}")"; then
    echo "Could not create an ephemeral iPhone Simulator for native protection tests; install an iOS Simulator runtime in Xcode." >&2
    exit 1
  fi
  simulator_created=1
fi

harness_root="$(mktemp -d "${TMPDIR:-/tmp}/alyte-protection-native-tests.XXXXXX")"

mkdir -p "${harness_root}/Sources/AlyteProtection" "${harness_root}/Tests/AlyteProtectionTests"
cp "${package_template}" "${harness_root}/Package.swift"
cp "${module_root}/ios/AlyteProtectionArchive.swift" \
  "${module_root}/ios/AlyteProtectionFilePolicy.swift" \
  "${harness_root}/Sources/AlyteProtection/"
cp "${module_root}/ios/AlyteProtectionArchiveTests.swift" \
  "${module_root}/ios/AlyteProtectionFilePolicyTests.swift" \
  "${harness_root}/Tests/AlyteProtectionTests/"

echo "Running AlyteProtection XCTest fixtures on ${simulator_name} (iOS Simulator)"
result_bundle="${harness_root}/TestResults.xcresult"
set +e
(
  cd "${harness_root}"
  xcodebuild test \
    -scheme AlyteProtectionNativeTests \
    -destination "platform=iOS Simulator,id=${simulator_id}" \
    -derivedDataPath "${harness_root}/DerivedData" \
    -resultBundlePath "${result_bundle}" \
    IPHONEOS_DEPLOYMENT_TARGET=16.4 \
    CODE_SIGNING_ALLOWED=NO \
    -skipPackageUpdates
)
test_exit=$?
set -e

if [[ -d "${result_bundle}" ]] && command -v xcrun >/dev/null 2>&1; then
  summary="$(xcrun xcresulttool get test-results summary --path "${result_bundle}" 2>/dev/null || true)"
  passed="$(printf '%s\n' "${summary}" | sed -n 's/.*"passedTests" : \([0-9][0-9]*\).*/\1/p' | sed -n '1p')"
  failed="$(printf '%s\n' "${summary}" | sed -n 's/.*"failedTests" : \([0-9][0-9]*\).*/\1/p' | sed -n '1p')"
  total="$(printf '%s\n' "${summary}" | sed -n 's/.*"totalTestCount" : \([0-9][0-9]*\).*/\1/p' | sed -n '1p')"
  if [[ -n "${passed}" && -n "${failed}" && -n "${total}" ]]; then
    echo "AlyteProtection XCTest summary: ${passed} passed, ${failed} failed, ${total} total"
  fi
fi

exit "${test_exit}"
