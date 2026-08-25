#!/bin/zsh
set -euo pipefail

# Required paths are deliberately explicit and external to the repository. This script never
# downloads model weights and never writes prompts or provider output to the result bundle.
: "${ALYTE_MODEL_EVAL_CACHE:?Set ALYTE_MODEL_EVAL_CACHE to an external task-specific cache}"
: "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK:?Set ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK to the externally built llama.xcframework directory}"
: "${ALYTE_MODEL_EVAL_DERIVED_DATA:?Set ALYTE_MODEL_EVAL_DERIVED_DATA outside the repository}"
: "${ALYTE_MODEL_EVAL_XCRESULT:?Set ALYTE_MODEL_EVAL_XCRESULT outside the repository}"

eval_device_udid="${ALYTE_MODEL_EVAL_DEVICE_UDID:-9A3D3FF4-48A2-5D50-BCE4-E74E4CA018D9}"
repo_root="$(git rev-parse --show-toplevel)"
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
case "${aggregate_path}" in
  "${repo_root}"|"${repo_root}"/*)
    print -u2 "ALYTE_MODEL_EVAL_AGGREGATE_PATH must not be inside the repository"
    exit 2
    ;;
esac

if [[ ! -f "${model_path}" ]]; then
  print -u2 "Missing externally staged Qwen artifact: ${model_path}"
  print -u2 "Stage only the pinned public GGUF; this script does not download it."
  exit 2
fi
if [[ ! -d "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" ]]; then
  print -u2 "Missing externally built llama.xcframework: ${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}"
  exit 2
fi
if [[ ! -d "${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64/llama.framework" ]]; then
  print -u2 "XCFramework must contain the ios-arm64 llama.framework device slice"
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

# The app/test target is evaluation-only and has no production Alyte routes or report-service
# dependency. Its XCTest output must remain aggregate-only; inspect the resulting JSON manually
# before sharing it. Device execution is intentionally separate from simulator evidence.
xcodebuild \
  -project "${repo_root}/apps/model-evaluation/AlyteModelEvaluation.xcodeproj" \
  -scheme AlyteModelEvaluation \
  -destination "id=${eval_device_udid}" \
  -derivedDataPath "${ALYTE_MODEL_EVAL_DERIVED_DATA}" \
  -resultBundlePath "${ALYTE_MODEL_EVAL_XCRESULT}" \
  ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}" \
  ALYTE_MODEL_EVAL_MODEL_PATH="${model_path}" \
  ALYTE_MODEL_EVAL_AGGREGATE_PATH="${aggregate_path}" \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS="ALYTE_LLAMA_EVAL" \
  OTHER_CFLAGS="-DALYTE_LLAMA_EVAL" \
  HEADER_SEARCH_PATHS="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64/llama.framework/Headers" \
  FRAMEWORK_SEARCH_PATHS="${ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK}/ios-arm64" \
  OTHER_LDFLAGS="-framework llama" \
  -only-testing:AlyteModelEvaluationTests \
  test
