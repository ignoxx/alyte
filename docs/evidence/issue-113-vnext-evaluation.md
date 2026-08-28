# Issue 113 — vNext extraction evidence

This record is intentionally limited to de-identified synthetic/reference fixtures. It does not
contain report data or claim device-model quality that was not measured.

## Contract and fixture checks

- Production contract: Vision OCR v3, row segmentation v2, parser v6, semantic schema v2,
  prompt v6, OCR chunk v4, and the checked-in Gemma runtime/model manifest.
- Synthetic checks exercised exact UTF-16 parent spans, page/table/section/specimen/date
  boundaries, bounded one-or-two-row requests, per-row malformed-output isolation, and one retry.
- Deterministic output preserves source values/units/ranges/flags and retains unresolved rows for
  review. The focused test commands and their pass/fail output are the verification record for
  these contract properties; no real health report was used.

## Inference gate

Real local Gemma inference was not run in this worktree: the isolated checkout has no installed
Node dependencies or model runtime, and no physical phone/simulator is available for the native
model path. The blocked setup check was `npm ci --ignore-scripts --offline` (EPERM creating the
isolated checkout's `node_modules`). Consequently, call counts, physical-row recall, accepted
mapping precision, malformed/retry rates, latency, memory, and review burden from real inference
are external acceptance gates, not fabricated measurements. The production v6/v2/v4 contract
remains deterministic and ready for the existing device evaluation harness after merge.
