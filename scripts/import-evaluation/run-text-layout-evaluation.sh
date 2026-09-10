#!/bin/zsh
# Run one local plaintext-layout adapter and score its private result.
#
# All runner and scorer output is kept under --private-root. The command emits only a structural
# success/failure marker so model output and source text cannot reach an ordinary terminal log.
set -euo pipefail
umask 077

typeset report=''
typeset report_id=''
typeset expected=''
typeset private_root=''
typeset output=''
typeset adapter='qwen35'
typeset input_mode='poppler-layout'
typeset pages=''
typeset vision=''
typeset binding=''
typeset model=''
typeset model_id=''
typeset model_sha256=''
typeset model_binary=''

usage() {
  print -u2 'usage: run-text-layout-evaluation.sh --report path --report-id id --expected path --private-root root --output path [--adapter qwen35|nuextract] [--input-mode poppler-layout|native-layout] [--pages 3[,4,...]] [--vision bound-native.json --binding bound-native.binding.json] [--model path --model-id id --model-sha256 sha256 --model-binary path]'
}

while (( $# > 0 )); do
  case "$1" in
    --report) report=${2:-}; shift 2 ;;
    --report-id) report_id=${2:-}; shift 2 ;;
    --expected) expected=${2:-}; shift 2 ;;
    --private-root) private_root=${2:-}; shift 2 ;;
    --output) output=${2:-}; shift 2 ;;
    --adapter) adapter=${2:-}; shift 2 ;;
    --input-mode) input_mode=${2:-}; shift 2 ;;
    --pages) pages=${2:-}; shift 2 ;;
    --vision) vision=${2:-}; shift 2 ;;
    --binding) binding=${2:-}; shift 2 ;;
    --model) model=${2:-}; shift 2 ;;
    --model-id) model_id=${2:-}; shift 2 ;;
    --model-sha256) model_sha256=${2:-}; shift 2 ;;
    --model-binary) model_binary=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ -z "$report" || -z "$report_id" || -z "$expected" || -z "$private_root" || -z "$output" ]]; then
  usage
  exit 2
fi
if [[ "$adapter" != 'qwen35' && "$adapter" != 'nuextract' ]]; then
  print -u2 'import-evaluation-invalid-adapter'
  exit 2
fi
if [[ "$input_mode" != 'poppler-layout' && "$input_mode" != 'native-layout' ]]; then
  print -u2 'import-evaluation-invalid-input-mode'
  exit 2
fi
if [[ -z "$vision" || -z "$binding" ]]; then
  print -u2 'import-evaluation-bound-source-required'
  exit 2
fi

typeset script_dir=${0:A:h}
typeset repo_root=${script_dir:h:h}
cd "$repo_root"

typeset runner='text-layout-fullpage.ts'
if [[ "$input_mode" == 'native-layout' ]]; then
  runner='text-layout-fullpage-vision.ts'
fi

typeset output_stem=${output%.json}
typeset raw_output="${output_stem}.model.json"
typeset grounded_output="${output_stem}.grounded.json"
typeset grounded_stem=${grounded_output%.json}
typeset excluded_output="${output_stem}.excluded.json"
typeset model_proposals_output="${grounded_stem}.model-proposals.json"
typeset metadata_output="${grounded_stem}.collection-date-metadata.json"
typeset score_output="${output_stem}.score.json"
typeset aggregate_output="${output_stem}.aggregate.json"
typeset runner_log="${output_stem}.runner.log"
typeset grounding_log="${output_stem}.grounding.log"
typeset score_log="${output_stem}.score.log"

typeset -a preflight_args
preflight_args=(
  --private-root "$private_root"
  --report "$report"
  --report-id "$report_id"
  --expected "$expected"
  --vision "$vision"
  --binding "$binding"
  --output "$output"
  --raw-output "$raw_output"
  --grounded-output "$grounded_output"
  --excluded-output "$excluded_output"
  --model-proposals-output "$model_proposals_output"
  --metadata-output "$metadata_output"
  --score-output "$score_output"
  --aggregate-output "$aggregate_output"
  --runner-log "$runner_log"
  --grounding-log "$grounding_log"
  --score-log "$score_log"
)
if ! node --import tsx "$script_dir/evaluation-preflight.ts" "${preflight_args[@]}" >/dev/null 2>&1; then
  print -u2 'import-evaluation-preflight-failed'
  exit 1
fi

typeset log_dir=${runner_log:h}
mkdir -p "$log_dir"
chmod 700 "$log_dir"

typeset -a runner_args
runner_args=(
  --report "$report"
  --report-id "$report_id"
  --private-root "$private_root"
  --output "$raw_output"
  --adapter "$adapter"
)
if [[ -n "$pages" ]]; then runner_args+=(--pages "$pages"); fi
if [[ -n "$vision" ]]; then runner_args+=(--vision "$vision"); fi
if [[ -n "$binding" ]]; then runner_args+=(--binding "$binding"); fi
if [[ -n "$model" ]]; then runner_args+=(--model "$model"); fi
if [[ -n "$model_id" ]]; then runner_args+=(--model-id "$model_id"); fi
if [[ -n "$model_sha256" ]]; then runner_args+=(--model-sha256 "$model_sha256"); fi
if [[ -n "$model_binary" ]]; then runner_args+=(--model-binary "$model_binary"); fi

if ! node --import tsx "$script_dir/$runner" "${runner_args[@]}" >"$runner_log" 2>&1; then
  print -u2 'import-evaluation-runner-failed'
  exit 1
fi

typeset -a postprocess_args
postprocess_args=(
  --pipeline "$raw_output"
  --source "$vision"
  --binding "$binding"
  --output "$grounded_output"
  --private-root "$private_root"
)
if ! node --import tsx "$script_dir/source-grounding-postprocess.ts" "${postprocess_args[@]}" >"$grounding_log" 2>&1; then
  print -u2 'import-evaluation-grounding-replay-failed'
  exit 1
fi

typeset -a admission_args
admission_args=(
  --report "$report"
  --pipeline "$grounded_output"
  --source "$vision"
  --binding "$binding"
  --output "$output"
  --private-root "$private_root"
)
if ! node --import tsx "$script_dir/source-context-admission.ts" "${admission_args[@]}" >>"$grounding_log" 2>&1; then
  print -u2 'import-evaluation-source-context-admission-failed'
  exit 1
fi

typeset -a score_args
score_args=(
  --report "$report"
  --report-id "$report_id"
  --expected "$expected"
  --pipeline "$output"
  --private-root "$private_root"
  --output "$score_output"
  --aggregate-output "$aggregate_output"
)
if [[ -n "$pages" ]]; then score_args+=(--pages "$pages"); fi
if ! node --import tsx "$script_dir/score.ts" "${score_args[@]}" >"$score_log" 2>&1; then
  print -u2 'import-evaluation-score-failed'
  exit 1
fi

print "import-evaluation-complete report=${report_id} adapter=${adapter} inputMode=${input_mode} output=${output} score=${score_output} aggregate=${aggregate_output}"
