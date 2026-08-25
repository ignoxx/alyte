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

repo_root="$(git rev-parse --show-toplevel)"
candidate="${ALYTE_MODEL_EVAL_CANDIDATE:-qwen}"
case "${candidate}" in
  qwen)
    model_filename="Qwen3.5-0.8B-Q4_0.gguf"
    model_repository="ggml-org/Qwen3.5-0.8B-GGUF"
    model_revision="8fea620810c4afa23dd6443f999a48574c1611a3"
    model_bytes="563036064"
    model_sha256="57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf"
    source_model_id=""
    source_model_repository=""
    source_model_revision=""
    expected_contract_version="alyte.qwen-evaluation.contract.v1"
    expected_manifest_version="alyte.qwen-evaluation.manifest.v1"
    runtime_repository="ggml-org/llama.cpp"
    runtime_revision="bb4caa7540188872173c44d161602d9271386413"
    expected_chat_template=""
    expected_chat_template_source=""
    contract_path="${ALYTE_MODEL_EVAL_CONTRACT_PATH:-${repo_root}/packages/model-evaluation/generated/evaluation-contract-v1.json}"
    ;;
  gemma4)
    model_filename="gemma-4-E2B-it-Q4_0.gguf"
    model_repository="ggml-org/gemma-4-E2B-it-GGUF"
    model_revision="b4243c156154b6dca9324415f8c7ccc098b4aed1"
    model_bytes="2841481184"
    model_sha256="8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52"
    source_model_id="gemma-4-e2b-it"
    source_model_repository="google/gemma-4-E2B-it"
    source_model_revision="3e22461f65e89153144f8adb70e3b8c2cc9845a7"
    expected_contract_version="alyte.gemma4-e2b-evaluation.contract.v1"
    expected_manifest_version="alyte.gemma4-e2b-evaluation.manifest.v1"
    runtime_repository="ggml-org/llama.cpp"
    runtime_revision="bb4caa7540188872173c44d161602d9271386413"
    expected_chat_template="gemma4-v1"
    expected_chat_template_source="explicit-pinned-google-gemma-4-template-v1"
    : "${ALYTE_MODEL_EVAL_CONTRACT_PATH:?Set ALYTE_MODEL_EVAL_CONTRACT_PATH to an external Gemma contract generated with --candidate gemma4}"
    contract_path="${ALYTE_MODEL_EVAL_CONTRACT_PATH}"
    ;;
  *)
    print -u2 "Unsupported evaluation candidate: ${candidate} (expected qwen or gemma4)"
    exit 2
    ;;
esac

eval_device_coredevice_id="${ALYTE_MODEL_EVAL_DEVICE_UDID:-9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9}"
eval_device_xcode_id="${ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID:-}"
eval_device_class="${ALYTE_MODEL_EVAL_DEVICE_CLASS:-current}"
eval_device_model="${ALYTE_MODEL_EVAL_DEVICE_MODEL:-iPhone 17 (iPhone18,3)}"
bundle_id="com.alyte.model-evaluation"
device_relative_directory="Library/Application Support/AlyteModelEvaluation"
test_model_relative_path="AlyteModelEvaluation/${model_filename}"
test_aggregate_relative_path="AlyteModelEvaluation/aggregate.json"
runtime_source="${ALYTE_MODEL_EVAL_RUNTIME_SOURCE}"
model_path="${ALYTE_MODEL_EVAL_CACHE}/${model_filename}"
aggregate_path="${ALYTE_MODEL_EVAL_AGGREGATE_PATH:-${ALYTE_MODEL_EVAL_CACHE}/aggregate.json}"

if [[ ! -f "${contract_path}" ]]; then
  print -u2 "Missing ${candidate} evaluation contract: ${contract_path}"
  exit 2
fi
contract_field() {
  node -e 'const value=process.argv[2].split(".").reduce((object, key) => object?.[key], JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))); if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${contract_path}" "$1"
}
contract_model_field() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).model[process.argv[2]]; if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${contract_path}" "$1"
}
contract_optional_field() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value === undefined || value === null) process.exit(0); if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${contract_path}" "$1"
}
contract_source_model_field() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).sourceModel?.[process.argv[2]]; if (value === undefined || value === null) process.exit(0); if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${contract_path}" "$1"
}
if [[ "$(contract_field contractVersion)" != "${expected_contract_version}" ||
      "$(contract_field manifestVersion)" != "${expected_manifest_version}" ||
      "$(contract_model_field repository)" != "${model_repository}" ||
      "$(contract_model_field revision)" != "${model_revision}" ||
      "$(contract_model_field filename)" != "${model_filename}" ||
      "$(contract_model_field sha256)" != "${model_sha256}" ||
      "$(contract_field runtime.repository)" != "${runtime_repository}" ||
      "$(contract_field runtime.revision)" != "${runtime_revision}" ||
      "$(contract_source_model_field id)" != "${source_model_id}" ||
      "$(contract_source_model_field repository)" != "${source_model_repository}" ||
      "$(contract_source_model_field revision)" != "${source_model_revision}" ||
      "$(contract_optional_field chatTemplate)" != "${expected_chat_template}" ||
      "$(contract_optional_field chatTemplateSource)" != "${expected_chat_template_source}" ]]; then
  print -u2 "Evaluation contract provenance does not match candidate ${candidate}"
  exit 2
fi

rg_bin="$(command -v rg || true)"
if [[ -z "${rg_bin}" ]]; then
  print -u2 "ripgrep (rg) is required for target/device checks"
  exit 2
fi

device_listing=""
if ! device_listing="$(xcrun devicectl list devices 2>&1)"; then
  print -u2 "Could not list devices with devicectl while checking CoreDevice identifier ${eval_device_coredevice_id}"
  exit 3
fi
device_record="$(print -r -- "${device_listing}" | "${rg_bin}" -F "${eval_device_coredevice_id}" | head -1 || true)"
if [[ -z "${device_record}" ]]; then
  print -u2 "CoreDevice identifier ${eval_device_coredevice_id} was not found in devicectl device list"
  exit 3
fi
device_state="$(print -r -- "${device_record}" | awk -v id="${eval_device_coredevice_id}" 'index($0, id) > 0 { tail = $0; sub(".*" id "[[:space:]]+", "", tail); sub("^[[:space:]]+", "", tail); split(tail, fields, /[[:space:]]+/); print fields[1]; exit }')"
case "${device_state}" in
  connected|available)
    ;;
  *)
    print -u2 "CoreDevice identifier ${eval_device_coredevice_id} reported state '${device_state:-unknown}'; expected connected or available"
    exit 3
    ;;
esac

if [[ -z "${eval_device_xcode_id}" ]]; then
  details_directory="$(mktemp -d -t alyte-eval-device-details)"
  details_path="${details_directory}/details.json"
  if ! xcrun devicectl device info details \
    --device "${eval_device_coredevice_id}" \
    --json-output "${details_path}" >/dev/null 2>&1; then
    rm -rf "${details_directory}"
    print -u2 "Could not resolve the Xcode destination ID from CoreDevice identifier ${eval_device_coredevice_id} (state ${device_state}); set ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID explicitly"
    exit 3
  fi
  eval_device_xcode_id="$(node -e 'const details=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); const value=details.result?.hardwareProperties?.udid ?? details.hardwareProperties?.udid; if (typeof value !== "string") process.exit(1); process.stdout.write(value)' "${details_path}" 2>/dev/null || true)"
  rm -rf "${details_directory}"
  if [[ ! "${eval_device_xcode_id}" =~ ^[0-9A-Fa-f-]{20,}$ ]]; then
    print -u2 "CoreDevice identifier ${eval_device_coredevice_id} did not yield a valid hardware Xcode destination ID; set ALYTE_MODEL_EVAL_XCODE_DESTINATION_ID explicitly"
    exit 3
  fi
fi

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
  print -u2 "Missing externally staged ${candidate} artifact: ${model_path}"
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
if [[ "$(stat -f '%z' "${model_path}")" != "${model_bytes}" ]]; then
  print -u2 "Pinned ${candidate} artifact has the wrong byte size"
  exit 2
fi
if [[ "$(shasum -a 256 "${model_path}" | cut -d ' ' -f 1)" != "${model_sha256}" ]]; then
  print -u2 "Pinned ${candidate} artifact has the wrong SHA-256"
  exit 2
fi

if ! xcodebuild -project "${repo_root}/apps/model-evaluation/AlyteModelEvaluation.xcodeproj" -list | "${rg_bin}" -q '^        AlyteModelEvaluationTests$'; then
  print -u2 "Evaluation test target is missing"
  exit 2
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
      --device "${eval_device_coredevice_id}" \
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
  -destination "id=${eval_device_xcode_id}" \
  -derivedDataPath "${ALYTE_MODEL_EVAL_DERIVED_DATA}" \
  DEVELOPMENT_TEAM="${ALYTE_MODEL_EVAL_TEAM_ID}" \
  CODE_SIGN_IDENTITY="Apple Development" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGNING_ALLOWED=YES \
  ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" \
  ALYTE_MODEL_EVAL_DEVICE_RUN=1 \
  ALYTE_MODEL_EVAL_DEVICE_CLASS="${eval_device_class}" \
  ALYTE_MODEL_EVAL_DEVICE_MODEL="${eval_device_model}" \
  ALYTE_MODEL_EVAL_CANDIDATE="${candidate}" \
  ALYTE_MODEL_EVAL_CONTRACT_PATH="${contract_path}" \
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
  --device "${eval_device_coredevice_id}" \
  "${app_path}"
installed_app=1

xcrun devicectl device copy to \
  --device "${eval_device_coredevice_id}" \
  --source "${model_path}" \
  --destination "${device_relative_directory}/${model_filename}" \
  --domain-type appDataContainer \
  --domain-identifier "${bundle_id}"

xcodebuild \
  test-without-building \
  -xctestrun "${xctestrun_path}" \
  -destination "id=${eval_device_xcode_id}" \
  -resultBundlePath "${ALYTE_MODEL_EVAL_XCRESULT}" \
  -only-testing:AlyteModelEvaluationTests

xcrun devicectl device copy from \
  --device "${eval_device_coredevice_id}" \
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
if (serialized.includes('<|im_start|>') || serialized.includes('<|turn>') || serialized.includes('<bos>') || serialized.includes('sourceFacts') || serialized.includes('rawModelOutput')) {
  throw new Error('aggregate report contains forbidden raw evaluation content');
}
if (!report.deviceMetrics || typeof report.fixtureCount !== 'number' || typeof report.expectedRowCount !== 'number') {
  throw new Error('aggregate report is missing required evaluation metrics');
}
NODE
