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
the newer Gemma 4 `<|turn>` template. Both native paths run with `thinking = false`, deterministic
greedy sampling, and only `sourceObservationIds`, a bounded semantic role, a known specimen type,
and a known catalogue Biomarker ID in model output. `validateEvaluationOutput` is the TypeScript
acceptance boundary, and the native target applies the same contract-driven acceptance rules before
retaining aggregate counts. Values, units, intervals, conversions, translations, and medical copy
remain source/deterministic data.

Model weights are intentionally absent. Operators stage the exact candidate GGUF in an external,
task-specific cache and verify its size and SHA-256 before installing the evaluation target.
Aggregate reports contain provenance and counts only; prompts and raw model responses are not
written by this package.

Focused checks:

```sh
npm run typecheck --workspace=@alyte/model-evaluation
npm run test --workspace=@alyte/model-evaluation
swift test --package-path apps/model-evaluation
```

The physical-device procedure and floor-device limitation are documented in
`docs/evidence/issue-50/README.md`.
