#!/bin/zsh
set -euo pipefail

# Required paths are deliberately explicit and external to the repository. This script never
# downloads model weights and never writes prompts or provider output to the result bundle.
: "${ALYTE_MODEL_EVAL_CACHE:?Set ALYTE_MODEL_EVAL_CACHE to an external task-specific cache}"
: "${ALYTE_MODEL_EVAL_RUNTIME_SOURCE:?Set ALYTE_MODEL_EVAL_RUNTIME_SOURCE to the pinned external llama.cpp checkout}"
: "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK:?Set ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK to the externally built llama.xcframework directory}"
: "${ALYTE_MODEL_EVAL_DERIVED_DATA:?Set ALYTE_MODEL_EVAL_DERIVED_DATA outside the repository}"
: "${ALYTE_MODEL_EVAL_XCRESULT:?Set ALYTE_MODEL_EVAL_XCRESULT outside the repository}"
: "${ALYTE_MODEL_EVAL_TEAM_ID:?Set ALYTE_MODEL_EVAL_TEAM_ID to the Apple Development team used for this evaluator build}"

eval_device_udid="${ALYTE_MODEL_EVAL_DEVICE_UDID:-9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9}"
eval_device_class="${ALYTE_MODEL_EVAL_DEVICE_CLASS:-current}"
eval_device_model="${ALYTE_MODEL_EVAL_DEVICE_MODEL:-iPhone 17 (iPhone18,3)}"
bundle_id="com.alyte.model-evaluation"
device_relative_directory="Library/Application Support/AlyteModelEvaluation"
test_model_relative_path="AlyteModelEvaluation/Qwen3.5-0.8B-Q4_0.gguf"
test_aggregate_relative_path="AlyteModelEvaluation/aggregate.json"
repo_root="$(git rev-parse --show-toplevel)"
runtime_source="${ALYTE_MODEL_EVAL_RUNTIME_SOURCE}"
model_path="${ALYTE_MODEL_EVAL_CACHE}/Qwen3.5-0.8B-Q4_0.gguf"
aggregate_path="${ALYTE_MODEL_EVAL_AGGREGATE_PATH:-${ALYTE_MODEL_EVAL_CACHE}/aggregate.json}"

case "${ALYTE_MODEL_EVAL_CACHE}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_CACHE must not be inside the repository"
    exit 2
    ;;
esac
case "${ALYTE_MODEL_EVAL_DERIVED_DATA}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_DERIVED_DATA must not be inside the repository"
    exit 2
    ;;
esac
case "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK must not be inside the repository"
    exit 2
    ;;
esac
case "${ALYTE_MODEL_EVAL_XCRESULT}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_XCRESULT must not be inside the repository"
    exit 2
    ;;
esac
case "${runtime_source}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_RUNTIME_SOURCE must not be inside the repository"
    exit 2
    ;;
esac
case "${aggregate_path}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_AGGREGATE_PATH must not be inside the repository"
    exit 2
    ;;
esac
if [[ -e "${aggregate_path}" ]]; then
  print -u2 "Aggregate destination already exists; choose a new external path"
  exit 2
fi
aggregate_parent="$(dirname "${aggregate_path}")"
mkdir -p "${aggregate_parent}"

if [[ ! -x "${runtime_source}/build-xcframework.sh" ]]; then
  print -u2 "Missing pinned llama.cpp build script: ${runtime_source}/build-xcframework.sh"
  exit 2
fi
if [[ "$(git -C "${runtime_source}" rev-parse HEAD)" != "bb4caa7540188872173c44d161602d9271386413" ]]; then
  print -u2 "Runtime checkout is not pinned to bb4caa7540188872173c44d161602d9271386413"
  exit 2
fi
if [[ -n "$(git -C "${runtime_source}" status --porcelain --untracked-files=all)" ]]; then
  print -u2 "Runtime checkout must be clean before device evaluation"
  exit 2
fi
if [[ "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" != "${runtime_source}/build-apple/llama.xcframework" ]]; then
  print -u2 "Runtime framework must be the ios-device output of the pinned checkout"
  exit 2
fi

if [[ ! -f "${model_path}" ]]; then
  print -u2 "Missing externally staged Qwen artifact: ${model_path}"
  print -u2 "Stage only the pinned public GGUF; this script does not download it."
  exit 2
fi
if [[ ! -d "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" ]]; then
  print -u2 "Missing externally built llama.xcframework: ${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}"
  exit 2
fi
runtime_manifest="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}.alyte-eval.json"
if [[ ! -f "${runtime_manifest}" ]]; then
  print -u2 "Missing pinned runtime identity manifest: ${runtime_manifest}"
  exit 2
fi
if ! node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${runtime_manifest}" >/dev/null; then
  print -u2 "Pinned runtime identity manifest is invalid JSON"
  exit 2
fi
if [[ ! -d "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64/llama.framework" ]]; then
  print -u2 "XCFramework must contain the ios-arm64 llama.framework device slice"
  exit 2
fi
manifest_field() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${runtime_manifest}" "$1"
}
runtime_revision="$(manifest_field runtimeRevision)"
source_revision="$(manifest_field sourceRevision)"
runtime_module="$(manifest_field module)"
runtime_platform="$(manifest_field platform)"
runtime_framework_path="$(manifest_field frameworkPath)"
runtime_binary_sha256="$(manifest_field deviceBinarySha256)"
if [[ "${runtime_revision}" != "bb4caa7540188872173c44d161602d9271386413" ||
      "${source_revision}" != "bb4caa7540188872173c44d161602d9271386413" ||
      "${runtime_module}" != "llama" ||
      "${runtime_platform}" != "ios-device" ||
      "${runtime_framework_path}" != "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" ]]; then
  print -u2 "Runtime identity manifest is not bound to the pinned llama.cpp iOS device build"
  exit 2
fi
device_binary="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64/llama.framework/llama"
if [[ "$(shasum -a 256 "${device_binary}" | cut -d ' ' -f 1)" != "${runtime_binary_sha256}" ]]; then
  print -u2 "llama device binary does not match the pinned runtime identity manifest"
  exit 2
fi
if [[ "$(stat -f '%z' "${model_path}")" != "563036064" ]]; then
  print -u2 "Pinned Qwen artifact has the wrong byte size"
  exit 2
fi
if [[ "$(shasum -a 256 "${model_path}" | cut -d ' ' -f 1)" != "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf" ]]; then
  print -u2 "Pinned Qwen artifact has the wrong SHA-256"
  exit 2
fi

rg_bin="$(command -v rg || true)"
if [[ -z "${rg_bin}" ]]; then
  print -u2 "ripgrep (rg) is required for target/device checks"
  exit 2
fi
if ! xcodebuild -project "${repo_root}/apps/model-evaluation/AlyteModelEvaluation.xcodeproj" -list | "${rg_bin}" -q '^        AlyteModelEvaluationTests$'; then
  print -u2 "Evaluation test target is missing"
  exit 2
fi
if ! xcrun devicectl list devices | "${rg_bin}" -q "${eval_device_udid}.*available"; then
  print -u2 "Requested paired device is unavailable: ${eval_device_udid}"
  exit 3
fi

# Build, install, stage, test, and retrieve in separate phases. The model is never put in the app
# bundle or the result bundle: it is copied into the installed app data container only after the
# signed evaluator is installed. XCTest receives container-relative paths and resolves them through
# Application Support on the phone. The evaluator is uninstalled on exit after aggregate retrieval.
app_path="${ALYTE_MODEL_EVAL_DERIVED_DATA}/Build/Products/Debug-iphoneos/AlyteModelEvaluation.app"
xctestrun_path=""
installed_app=0
cleanup() {
  local exit_code=$?
  set +e
  if [[ "${installed_app}" == "1" ]]; then
    xcrun devicectl device uninstall app \
      --device "${eval_device_udid}" \
      "${bundle_id}" >/dev/null 2>&1
    local uninstall_code=$?
    if [[ "${exit_code}" == "0" && "${uninstall_code}" != "0" ]]; then
      print -u2 "Failed to uninstall evaluation app; remove ${bundle_id} manually from the device"
      exit_code="${uninstall_code}"
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

xcodebuild \
  -project "${repo_root}/apps/model-evaluation/AlyteModelEvaluation.xcodeproj" \
  -scheme AlyteModelEvaluation \
  -destination "id=${eval_device_udid}" \
  -derivedDataPath "${ALYTE_MODEL_EVAL_DERIVED_DATA}" \
  DEVELOPMENT_TEAM="${ALYTE_MODEL_EVAL_TEAM_ID}" \
  CODE_SIGN_IDENTITY="Apple Development" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGNING_ALLOWED=YES \
  ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" \
  ALYTE_MODEL_EVAL_DEVICE_RUN=1 \
  ALYTE_MODEL_EVAL_DEVICE_CLASS="${eval_device_class}" \
  ALYTE_MODEL_EVAL_DEVICE_MODEL="${eval_device_model}" \
  ALYTE_MODEL_EVAL_MODEL_PATH="${test_model_relative_path}" \
  ALYTE_MODEL_EVAL_AGGREGATE_PATH="${test_aggregate_relative_path}" \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS="ALYTE_LLAMA_EVAL" \
  OTHER_CFLAGS="-DALYTE_LLAMA_EVAL" \
  HEADER_SEARCH_PATHS="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64/llama.framework/Headers" \
  FRAMEWORK_SEARCH_PATHS="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64" \
  OTHER_LDFLAGS="-framework llama" \
  -allowProvisioningUpdates \
  build-for-testing

if [[ ! -d "${app_path}" ]]; then
  print -u2 "Signed evaluator app was not produced: ${app_path}"
  exit 2
fi
embedded_framework="${app_path}/Frameworks/llama.framework"
embedded_binary="${embedded_framework}/llama"
if [[ ! -f "${embedded_binary}" ]]; then
  print -u2 "Signed evaluator app is missing the pinned llama.framework: ${embedded_framework}"
  exit 2
fi
embedded_binary_sha256=""
if ! embedded_binary_sha256="$("${repo_root}/scripts/hash-unsigned-binary.sh" "${embedded_binary}")"; then
  print -u2 "Could not hash the embedded llama.framework"
  exit 2
fi
device_binary_sha256=""
if ! device_binary_sha256="$("${repo_root}/scripts/hash-unsigned-binary.sh" "${device_binary}")"; then
  print -u2 "Could not hash the pinned llama.framework"
  exit 2
fi
if [[ -z "${embedded_binary_sha256}" || -z "${device_binary_sha256}" ||
      "${embedded_binary_sha256}" != "${device_binary_sha256}" ]]; then
  print -u2 "Embedded llama.framework does not match the pinned runtime identity manifest"
  exit 2
fi
if ! codesign --verify --strict --verbose=2 "${embedded_framework}" >/dev/null 2>&1; then
  print -u2 "Embedded llama.framework is not code-signed"
  exit 2
fi
if ! codesign --verify --deep --strict --verbose=2 "${app_path}" >/dev/null 2>&1; then
  print -u2 "Signed evaluator app failed code-signature verification"
  exit 2
fi
xctestrun_path="$(find "${ALYTE_MODEL_EVAL_DERIVED_DATA}/Build/Products" -maxdepth 1 -name '*.xctestrun' -type f -print -quit)"
if [[ -z "${xctestrun_path}" || ! -f "${xctestrun_path}" ]]; then
  print -u2 "Signed XCTest run specification was not produced"
  exit 2
fi
test_info="${app_path}/PlugIns/AlyteModelEvaluationTests.xctest/Info.plist"
if [[ ! -f "${test_info}" ]]; then
  print -u2 "Signed XCTest bundle is missing its Info.plist"
  exit 2
fi
if [[ "$(plutil -extract ALYTE_MODEL_EVAL_MODEL_PATH raw -o - "${test_info}")" != "${test_model_relative_path}" ||
      "$(plutil -extract ALYTE_MODEL_EVAL_AGGREGATE_PATH raw -o - "${test_info}")" != "${test_aggregate_relative_path}" ]]; then
  print -u2 "XCTest inputs are not container-relative"
  exit 2
fi

xcrun devicectl device install app \
  --device "${eval_device_udid}" \
  "${app_path}"
installed_app=1

xcrun devicectl device copy to \
  --device "${eval_device_udid}" \
  --source "${model_path}" \
  --destination "${device_relative_directory}/Qwen3.5-0.8B-Q4_0.gguf" \
  --domain-type appDataContainer \
  --domain-identifier "${bundle_id}"

xcodebuild \
  test-without-building \
  -xctestrun "${xctestrun_path}" \
  -destination "id=${eval_device_udid}" \
  -resultBundlePath "${ALYTE_MODEL_EVAL_XCRESULT}" \
  -only-testing:AlyteModelEvaluationTests

xcrun devicectl device copy from \
  --device "${eval_device_udid}" \
  --source "${device_relative_directory}/aggregate.json" \
  --destination "${aggregate_path}" \
  --domain-type appDataContainer \
  --domain-identifier "${bundle_id}"

if [[ ! -s "${aggregate_path}" ]]; then
  print -u2 "Device evaluation did not return a non-empty aggregate report"
  exit 2
fi
node - "${aggregate_path}" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const serialized = JSON.stringify(report);
if (serialized.includes('<|im_start|>') || serialized.includes('sourceFacts') || serialized.includes('rawModelOutput')) {
  throw new Error('aggregate report contains forbidden raw evaluation content');
}
if (!report.deviceMetrics || typeof report.fixtureCount !== 'number' || typeof report.expectedRowCount !== 'number') {
  throw new Error('aggregate report is missing required evaluation metrics');
}
NODE
