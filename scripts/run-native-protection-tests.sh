#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly module_root="${repo_root}/apps/mobile/modules/alyte-protection"
readonly package_template="${repo_root}/scripts/native-tests/Package.swift"
readonly package_lock="${repo_root}/scripts/native-tests/Package.resolved"
readonly pod_lock="${repo_root}/apps/mobile/ios/Podfile.lock"
readonly cloud_result_vector="${repo_root}/packages/contracts/test-vectors/cloud-result-envelope-v1.json"
readonly requested_simulator_name="${ALYTE_IOS_SIMULATOR_NAME:-}"
readonly zipfoundation_version="0.9.20"
readonly zipfoundation_revision="22787ffb59de99e5dc1fbfe80b19c97a904ad48d"
readonly zipfoundation_pod_checksum="dfd3d681c4053ff7e2f7350bc4e53b5dba3f5351"

for command in xcodebuild xcrun swift jq; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required to run AlyteProtection native tests" >&2
    exit 1
  fi
done

if ! grep -Eq "dependency ['\"]ZIPFoundation['\"], ['\"]${zipfoundation_version}['\"]" \
  "${module_root}/ios/AlyteProtection.podspec"; then
  echo "AlyteProtection.podspec must pin ZIPFoundation to ${zipfoundation_version}" >&2
  exit 1
fi
if ! grep -Eq "exact: ['\"]${zipfoundation_version}['\"]" "${package_template}"; then
  echo "SwiftPM test harness must resolve ZIPFoundation ${zipfoundation_version} exactly" >&2
  exit 1
fi
if ! jq -e \
  --arg version "${zipfoundation_version}" \
  --arg revision "${zipfoundation_revision}" \
  'any(.pins[]; .identity == "zipfoundation" and .location == "https://github.com/weichsel/ZIPFoundation.git" and .state.version == $version and .state.revision == $revision)' \
  "${package_lock}" >/dev/null; then
  echo "SwiftPM lock must pin ZIPFoundation ${zipfoundation_version} at ${zipfoundation_revision}" >&2
  exit 1
fi

if [[ -f "${pod_lock}" ]]; then
  if ! grep -Eq "^[[:space:]]+- ZIPFoundation \(${zipfoundation_version}\)$" "${pod_lock}"; then
    echo "CocoaPods resolved ZIPFoundation does not match ${zipfoundation_version}" >&2
    exit 1
  fi
  pod_checksum="$(awk '
    /^SPEC CHECKSUMS:/ { section = 1; next }
    section && /^  ZIPFoundation: / { print $2; exit }
    section && /^[A-Z]/ { exit }
  ' "${pod_lock}")"
  if [[ "${pod_checksum}" != "${zipfoundation_pod_checksum}" ]]; then
    echo "CocoaPods ZIPFoundation checksum is not ${zipfoundation_pod_checksum}" >&2
    exit 1
  fi
fi

simulator_created=0
simulator_booted_by_harness=0
simulator_id=""
simulator_name=""
simulator_state=""
simulator_runtime_version=""
harness_root=""
final_status=0

device_state() {
  xcrun simctl list devices -j | jq -r --arg udid "$1" '
    [.devices[][] | select(.udid == $udid) | .state] | .[0] // empty
  '
}

cleanup() {
  local previous_status=$?
  local cleanup_failure=0
  local current_state=""

  if [[ "${simulator_booted_by_harness}" -eq 1 && -n "${simulator_id}" ]]; then
    if ! current_state="$(device_state "${simulator_id}")"; then
      echo "Could not inspect simulator ${simulator_id}; cleanup is incomplete" >&2
      cleanup_failure=1
      current_state=""
    fi
    if [[ "${current_state}" == "Booted" ]]; then
      if ! xcrun simctl shutdown "${simulator_id}" >/dev/null 2>&1; then
        echo "Could not shut down simulator ${simulator_id}; cleanup is incomplete" >&2
        cleanup_failure=1
      fi
    elif [[ -n "${current_state}" && "${current_state}" != "Shutdown" ]]; then
      echo "Simulator ${simulator_id} ended in unexpected state '${current_state}'" >&2
      cleanup_failure=1
    fi
  fi

  if [[ "${simulator_created}" -eq 1 && -n "${simulator_id}" ]]; then
    if ! current_state="$(device_state "${simulator_id}")"; then
      echo "Could not inspect ephemeral simulator ${simulator_id}; cleanup is incomplete" >&2
      cleanup_failure=1
      current_state=""
    fi
    if [[ -n "${current_state}" ]] && ! xcrun simctl delete "${simulator_id}" >/dev/null 2>&1; then
      echo "Could not delete ephemeral simulator ${simulator_id}" >&2
      cleanup_failure=1
    fi
  fi

  if [[ -n "${harness_root}" && -d "${harness_root}" ]] && ! rm -rf "${harness_root}"; then
    echo "Could not remove ephemeral native test harness ${harness_root}" >&2
    cleanup_failure=1
  fi

  if [[ "${final_status}" -eq 0 && "${previous_status}" -ne 0 ]]; then
    final_status="${previous_status}"
  fi
  if [[ "${final_status}" -eq 0 && "${cleanup_failure}" -ne 0 ]]; then
    final_status=1
  fi
  exit "${final_status}"
}
trap cleanup EXIT

devices_json="$(xcrun simctl list devices available -j)"
runtimes_json="$(xcrun simctl list runtimes available -j)"

if [[ -n "${requested_simulator_name}" ]]; then
  explicit_count="$(jq -nr \
    --argjson devices "${devices_json}" \
    --argjson runtimes "${runtimes_json}" \
    --arg requested "${requested_simulator_name}" '
      ($runtimes.runtimes | map(select(.isAvailable == true) | .identifier)) as $runtimeIds |
      [$devices.devices | to_entries[] as $entry | select($runtimeIds | index($entry.key)) | $entry.value[] |
        select(.isAvailable == true and .name == $requested)] | length
    '
  )"
  if [[ "${explicit_count}" -eq 0 ]]; then
    echo "No available iPhone Simulator named '${requested_simulator_name}'" >&2
    exit 1
  fi
  if [[ "${explicit_count}" -ne 1 ]]; then
    echo "Simulator name '${requested_simulator_name}' is ambiguous across available runtimes; unset ALYTE_IOS_SIMULATOR_NAME or use a unique name" >&2
    exit 1
  fi
  simulator_selection="$(jq -nr \
    --argjson devices "${devices_json}" \
    --argjson runtimes "${runtimes_json}" \
    --arg requested "${requested_simulator_name}" '
      ($runtimes.runtimes | map(select(.isAvailable == true) | {id: .identifier, version: .version})) as $runtimesById |
      [$devices.devices | to_entries[] as $entry |
        ($runtimesById[] | select(.id == $entry.key)) as $runtime |
        $entry.value[] | select(.isAvailable == true and .name == $requested) |
        {name, udid, state, runtimeVersion: $runtime.version}] | .[0] |
        [.name, .udid, .state, .runtimeVersion] | @tsv
    '
  )"
else
  simulator_selection="$(jq -nr \
    --argjson devices "${devices_json}" \
    --argjson runtimes "${runtimes_json}" '
      def parts: (.version | split(".") | map(tonumber) + [0, 0, 0])[0:3];
      def rank:
        if (.name | test("^iPhone [0-9]+$")) then 0
        elif (.name | test("^iPhone [0-9]+e$")) then 1
        else 2
        end;
      ($runtimes.runtimes | map(select(.isAvailable == true) | {id: .identifier, version: .version, versionParts: parts})) as $runtimesById |
      [$devices.devices | to_entries[] as $entry |
        ($runtimesById[] | select(.id == $entry.key)) as $runtime |
        $entry.value[] |
        select(.isAvailable == true and (.deviceTypeIdentifier | startswith("com.apple.CoreSimulator.SimDeviceType.iPhone"))) |
        {name, udid, state, runtimeVersion: $runtime.version, versionParts: $runtime.versionParts, rank: rank}
      ] |
      if length == 0 then empty
      else sort_by([.versionParts[0], .versionParts[1], .versionParts[2], (2 - .rank), .name, .udid]) | .[-1] |
        [.name, .udid, .state, .runtimeVersion] | @tsv
      end
    '
  )"
fi

if [[ -n "${simulator_selection}" ]]; then
  IFS=$'\t' read -r simulator_name simulator_id simulator_state simulator_runtime_version <<< "${simulator_selection}"
else
  fallback_selection="$(jq -nr \
    --argjson runtimes "${runtimes_json}" '
      def parts: (.version | split(".") | map(tonumber) + [0, 0, 0])[0:3];
      [$runtimes.runtimes[] | select(.isAvailable == true) |
        ([.supportedDeviceTypes[] | select(.productFamily == "iPhone" and (.name | test("^iPhone [0-9]+$")))] | sort_by(.name) | .[-1]) as $standard |
        ([.supportedDeviceTypes[] | select(.productFamily == "iPhone")] | sort_by(.name) | .[-1]) as $any |
        ($standard // $any) as $type | select($type != null) |
        {runtimeId: .identifier, runtimeVersion: .version, versionParts: parts, typeId: $type.identifier, typeName: $type.name}
      ] |
      if length == 0 then empty
      else sort_by([.versionParts[0], .versionParts[1], .versionParts[2], .typeName]) | .[-1] |
        [.typeName, .typeId, .runtimeId, .runtimeVersion] | @tsv
      end
    '
  )"
  if [[ -z "${fallback_selection}" ]]; then
    echo "No available iOS runtime with a compatible iPhone device type; install an iOS Simulator runtime in Xcode" >&2
    exit 1
  fi
  IFS=$'\t' read -r device_type_name device_type_id runtime_id simulator_runtime_version <<< "${fallback_selection}"
  simulator_name="AlyteProtection Ephemeral iPhone"
  if ! simulator_id="$(xcrun simctl create "${simulator_name}" "${device_type_id}" "${runtime_id}")"; then
    echo "Could not create an ephemeral iPhone Simulator; install an iOS Simulator runtime in Xcode" >&2
    exit 1
  fi
  simulator_created=1
  simulator_state="Shutdown"
fi

if [[ "${simulator_state}" == "Shutdown" ]]; then
  if xcrun simctl boot "${simulator_id}" >/dev/null 2>&1; then
    simulator_booted_by_harness=1
  else
    final_status=$?
    echo "Could not boot iOS Simulator '${simulator_name}' (${simulator_runtime_version})" >&2
    exit "${final_status}"
  fi
  if xcrun simctl bootstatus "${simulator_id}" -b >/dev/null 2>&1; then
    :
  else
    final_status=$?
    echo "iOS Simulator '${simulator_name}' did not finish booting" >&2
    exit "${final_status}"
  fi
elif [[ "${simulator_state}" != "Booted" ]]; then
  echo "Simulator '${simulator_name}' has unsupported state '${simulator_state}'" >&2
  exit 1
fi

harness_root="$(mktemp -d "${TMPDIR:-/tmp}/alyte-protection-native-tests.XXXXXX")"

mkdir -p "${harness_root}/Sources/AlyteProtection" "${harness_root}/Tests/AlyteProtectionTests"
cp "${package_template}" "${harness_root}/Package.swift"
cp "${package_lock}" "${harness_root}/Package.resolved"
cp "${module_root}/ios/AlyteProtectionArchive.swift" \
  "${module_root}/ios/AlyteProtectionFilePolicy.swift" \
  "${module_root}/ios/AlyteProtectionSnapshotShield.swift" \
  "${module_root}/ios/AlyteDeviceCrypto.swift" \
  "${harness_root}/Sources/AlyteProtection/"
cp "${module_root}/ios/AlyteProtectionArchiveTests.swift" \
  "${module_root}/ios/AlyteProtectionFilePolicyTests.swift" \
  "${module_root}/ios/AlyteProtectionSnapshotShieldTests.swift" \
  "${module_root}/ios/AlyteDeviceCryptoTests.swift" \
  "${harness_root}/Tests/AlyteProtectionTests/"
cp "${cloud_result_vector}" "${harness_root}/Tests/AlyteProtectionTests/cloud-result-envelope-v1.json"

echo "Running AlyteProtection XCTest fixtures on ${simulator_name} (iOS Simulator ${simulator_runtime_version})"
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
final_status=$?
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

exit "${final_status}"
