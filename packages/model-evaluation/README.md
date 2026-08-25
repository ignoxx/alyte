# Qwen 3.5 0.8B evaluation harness

This package is the evaluation-only labs lane for issue #50. It does not participate in the
production Expo app, report service, model downloader, model-pack persistence, or extraction
mapper. The checked-in corpus contains only fabricated OCR-shaped observations for `en`, `de`,
`lt`, `pl`, `fr`, and `es`, with blood, serum, plasma, and urine contexts.

The generated `generated/evaluation-contract-v1.json` is the canonical versioned fixture, grammar,
catalogue-compatibility, and bound contract consumed by the native target. It contains all six
two-row locale fixtures and OCR alternatives; it contains no runtime prompt or model response.
The native runner builds bounded prompts from that contract and passes them to the pinned llama.cpp
runtime with `thinking = false`. Only `sourceObservationIds`, a bounded semantic role, a known
specimen type, and a known catalogue Biomarker ID may come back. `validateEvaluationOutput` is the
TypeScript acceptance boundary, and the native target applies the same contract-driven acceptance
rules before retaining aggregate counts. Values, units, intervals, conversions, translations, and
medical copy remain source/deterministic data.

Model weights are intentionally absent. Operators stage the exact GGUF in an external,
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
