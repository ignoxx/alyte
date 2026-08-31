# On-device semantic-model evaluation harness

This package is the evaluation-only labs lane for issues #50 and #66. It does not participate in
the production Expo app, report service, model downloader, model-pack persistence, or extraction
mapper. The checked-in corpus contains only fabricated OCR-shaped observations for `en`, `de`,
`lt`, `pl`, `fr`, and `es`, with blood, serum, plasma, and urine contexts. Qwen remains the default
candidate; Gemma 4 E2B is selected only by the external device-runner candidate switch.

The generated `generated/evaluation-contract-v1.json` is the canonical Qwen fixture, grammar,
catalogue-compatibility, and bound contract consumed by the native target. Generate the equivalent
Gemma contract into an external cache with `--candidate gemma4 --output <external-path>`; expected
fixtures and semantic bounds are unchanged. Gemma's contract records the explicit pinned
`gemma4-v1` template because the pinned llama.cpp revision's built-in template API does not apply
the newer Gemma 4 `<|turn>` template. The Gemma contract also records the upstream source model
`google/gemma-4-E2B-it` at revision
`3e22461f65e89153144f8adb70e3b8c2cc9845a7`, distinct from the converted GGUF repository and
revision. Both native paths run with `thinking = false`, deterministic
greedy sampling, and only `sourceObservationIds`, a bounded semantic role, a known specimen type,
and a known catalogue Biomarker ID in model output. `validateEvaluationOutput` is the TypeScript
acceptance boundary, and the native target applies the same contract-driven acceptance rules before
retaining aggregate counts. Values, units, intervals, conversions, translations, and medical copy
remain source/deterministic data. Gemma attempt 2 is identified by the immutable
`alyte.gemma4-e2b-evaluation.prompt.v2` bundle in its contract and aggregate provenance; its only
instruction change requires one proposal per unambiguous physical measurement row and combines all
source cells for that row. The safe attempt-1 result and its review-burden rationale are recorded
in `docs/evidence/issue-66/README.md`.

Model weights are intentionally absent. Operators stage the exact candidate GGUF in an external,
task-specific cache and verify its size and SHA-256 before installing the evaluation target.
Aggregate reports contain provenance and counts only; prompts and raw model responses are not
written by this package.

Focused checks:

```sh
npm run typecheck --workspace=@alyte/model-evaluation
npm run test --workspace=@alyte/model-evaluation
npm run test:gate1 --workspace=@alyte/model-evaluation
node --test scripts/model-evaluation-embedding.test.mjs
swift test --package-path apps/model-evaluation
```

## Production-contract Mac baseline (Gate 1)

The evaluator-only baseline uses the production semantic schema v2, prompt-v6, OCR chunk-v4,
compact row/cell wire format, and the production validator. Its checked-in corpus is fabricated
English, German, and Lithuanian OCR-shaped data only; it is not a real-report accuracy claim.

Stage the exact Gemma artifact outside this repository, then verify and import it into a fixed local
Ollama alias (the command never downloads or copies weights into the repository):

```sh
npx tsx scripts/model-evaluation-prepare.ts \
  --model /external/cache/gemma-4-E2B-it-Q4_0.gguf \
  --cache /external/cache/alyte-ollama
```

Run only against loopback Ollama and write the scrubbed aggregate to an explicitly external path:

```sh
npx tsx scripts/model-evaluation-runner.ts \
  --output /external/results/model-evaluation-aggregate-gemma-v2.json
```

The runner uses raw generation, Ollama's JSON-Schema equivalent of the production GBNF envelope,
a 2,048-token context, 192 output tokens, greedy deterministic sampling, and thinking disabled.
The unchanged production validator remains the acceptance boundary. Before fixture inference it resolves the fixed alias through
loopback Ollama model metadata and requires the pinned artifact identity, failing closed when the
alias is missing or replaced. It retains aggregate counts, bounded failure/retry counts, and warm
latency only; it never prints the caller's output path. Ollama is a Mac evaluation transport; the
later acceptance run still uses the pinned llama.cpp runtime on a physical iPhone. The next Gate 1
step is to compare this scrubbed aggregate with the pinned-device result before any batching,
prompt, PDF/OCR, or table-context experiment.

The physical-device procedure and floor-device limitation are documented in
`docs/evidence/issue-50/README.md`.

## Compact-key prompt experiment

Issue #145 runs the unchanged production prompt-v6 baseline beside one evaluator-only wording
candidate. Both arms use the same fixed Ollama alias, JSON-Schema envelope, fabricated corpus,
serializer, validator, retry policy, and aggregate-only output. The candidate only clarifies that
`rowKey` and each compact `*Key` field contain row-local keys such as `r0` and `c0`, never source
text; it is not a production prompt change.

```sh
npx tsx scripts/model-evaluation-ab.ts \
  --output /tmp/model-evaluation-aggregate-gemma-v2-ab.json
```

The result contains separate `baseline` and `candidate` provenance, metrics, retries, and latency.
Do not promote the candidate from aggregate counts alone: accept it only if exact field selection
improves without forcing ambiguous or unsupported rows into Measurements.

## Dynamic compact-key transport experiment

Issue #146 compares the same production prompt-v6 and unchanged validator with an evaluator-only
Ollama JSON-Schema transport. The candidate schema is generated for each retry chunk: each proposal
branch is tied to its actual `rN` row and its available `cN` cells, while the proposal count is
bounded to the chunk row count. This constrains transport decoding without changing production
prompt bytes, model settings, retry policy, or semantic acceptance rules.

```sh
npx tsx scripts/model-evaluation-constrained-ab.ts \
  --output /tmp/model-evaluation-aggregate-gemma-v2-constrained.json
```

The aggregate records separate baseline and candidate transport provenance. Keep the output outside
the repository; raw prompts, OCR-shaped input, source IDs, and model responses are rejected by the
privacy scrub. Promote the transport only when exact accepted fields improve without forcing
ambiguous, unsupported, or preservation rows into Measurements. The arms always run in fixed
baseline-then-candidate order, so latency is descriptive rather than a comparative performance
measurement; quality metrics decide promotion.

## Final role-safe transport experiment

Issue #147 is the final evaluator-only Gemma transport arm. It keeps the production prompt,
fixtures, pinned model identity, deterministic settings, retry policy, and validator unchanged.
For each bounded row chunk, its Ollama JSON Schema enumerates only assignments where the required
label/value cells and every selected optional cell are distinct. It also binds `measurement` to a
known catalogue Biomarker ID and binds `preserve`/`specimen-context` to a null Biomarker ID;
`ignore` is omitted because the production validator rejects it. The schema is bounded to 5,000
branches and 2,500,000 encoded JSON bytes; oversized grammars fail closed before transport.
Ollama must accept and enforce the schema through the loopback transport; a transport or schema
failure aborts the candidate rather than relaxing the constraint.

```sh
npx tsx scripts/model-evaluation-final-ab.ts \
  --output /tmp/model-evaluation-aggregate-gemma-v2-final-ab.json
```

The report keeps baseline and candidate provenance, exact accepted/preservation metrics, rejection
and retry counts, and descriptive timings separate. A zero-result or unsafe result rejects Gemma 4
E2B for the MVP semantic mapper and ends this tuning branch. The output path must remain outside
the repository; the privacy scrub rejects source identifiers, prompts, OCR, and model output.

## Source-cell selector evaluation

Issue #149 evaluates the smallest useful local job: selecting the exact label, result, unit,
reference, and flag cells for each physical row. The evaluator-only schema contains only row/cell
keys; it cannot emit biomarker IDs, roles, specimen types, values, or other authoritative fields.
Selected cells are expanded locally and reparsed with the existing deterministic domain aliases,
unit, method, and specimen checks. Unsupported rows remain null mappings for review.

Prepare two external Ollama aliases from the exact manifests in
`packages/model-evaluation/src/manifest.ts`, then run the fixed-order comparison:

```sh
npx tsx scripts/model-evaluation-source-selector-ab.ts \
  --qwen-model alyte-qwen3.5-source-selector-v1 \
  --gemma-model alyte-gemma4-source-selector-v1 \
  --output /tmp/model-evaluation-aggregate-source-selector.json
```

The command preflights each alias through loopback Ollama and requires its exact pinned blob hash.
It uses the same fabricated English/German/Lithuanian corpus, prompt-v2, 2,048-token context,
256-token output bound, greedy settings, and one malformed-output retry per candidate. The prompt
states that cell order is arbitrary and c0/c1/c2/c3 carry no meaning; roles are inferred from
visible cell content. A conservative lexical/UTF-8 estimate reserves the output margin before
transport, without claiming tokenizer exactness. Qwen uses its raw
ChatML turn framing; Gemma uses the reviewed raw Gemma 4 turn framing. Only aggregate field
counts/accuracies, explicit full-field row accuracy, supported deterministic mapping accuracy,
unsupported exact-preservation accuracy, review burden, bounded failure/retry counts, descriptive
latency, pack bytes, and provenance are written. Keep the output outside the repository.

## Qwen3 1.7B source-cell candidate

Issue #151 evaluates the exact pinned `Qwen3-1.7B-Q4_K_M.gguf` artifact as a separate candidate
against the same selector-v2 prompt, row-local schema, fabricated fixtures, deterministic scorer,
retry policy, privacy scrub, and bounds. Its reviewed non-thinking raw ChatML template uses the
empty `<think>` block required by Qwen3's tokenizer configuration and is recorded as `qwen3-v1`;
it does not alter the existing Qwen3.5/Gemma A/B.

```sh
npx tsx scripts/model-evaluation-source-selector-qwen3.ts \
  --artifact /external/cache/Qwen3-1.7B-Q4_K_M.gguf \
  --model alyte-qwen3-1.7b-source-selector-v1 \
  --output /tmp/model-evaluation-aggregate-source-selector-qwen3.json
```

The command first verifies that this external path is a regular, non-symlink file with the exact
manifest basename, observed byte count, and streaming SHA-256, then preflights the alias against
the expected Ollama blob SHA. The Ollama metadata check observes the blob digest only; it does not
expose or independently verify the repository revision, which remains provenance encoded in the
pinned repository/revision/URL manifest. The command writes only aggregate quality, bounded
retries/failures, descriptive latency, pack bytes, and pinned provenance. Keep the output outside
the repository; Sol owns the real model run and comparison with the rejected candidates.

## LFM2 Extract source-selector comparison

Issue #153 benchmarks LiquidAI's `LFM2-350M-Extract-Q4_K_M.gguf` and
`LFM2-1.2B-Extract-Q4_K_M.gguf` with the reviewed Qwen3 1.7B control in fixed order:
Qwen3 control, LFM2 350M, then LFM2 1.2B. All three arms use the unchanged selector-v2 prompt,
schema, fixtures, deterministic reparsing, scorer, retry policy, privacy scrub, and bounds. The
comparison requires exact external artifact paths for all three arms; each artifact is checked for
basename, regular non-symlink status, bytes, and streaming SHA-256 before its Ollama alias is
preflighted.

```sh
npx tsx scripts/model-evaluation-source-selector-lfm2.ts \
  --artifact-qwen3 /external/cache/Qwen3-1.7B-Q4_K_M.gguf \
  --model-qwen3 alyte-qwen3-1.7b-source-selector-v1 \
  --artifact-350m /external/cache/LFM2-350M-Extract-Q4_K_M.gguf \
  --model-350m alyte-lfm2-350m-extract-source-selector-v1 \
  --artifact-1.2b /external/cache/LFM2-1.2B-Extract-Q4_K_M.gguf \
  --model-1.2b alyte-lfm2-1.2b-extract-source-selector-v1 \
  --output /tmp/model-evaluation-aggregate-source-selector-lfm2.json
```

LFM2 uses the pinned LiquidAI single-turn template (`lfm2-v1`) and writes only aggregate quality,
bounded failures/retries, descriptive latency, pack bytes, and selector/model/source/license
provenance. LiquidAI's official Extract language claim is exactly `en`, `ar`, `zh`, `fr`, `de`,
`ja`, `ko`, `pt`, and `es`; Lithuanian (`lt`) and Polish (`pl`) are not claimed. The frozen
benchmark deliberately includes English, German, and Lithuanian, so Lithuanian is out-of-claim and
must pass a private-language gate before any decision. The artifacts use
`LFM-Open-License-v1.0`, which does not license commercial use by legal entities at or above USD
10M annual revenue, so shipment also requires a license gate. Sol records each candidate's
keep/reject decision only after the formal three-arm aggregate and the private language/license
gates. Benchmarking does not imply shipment.
