---
status: superseded
---

# Use Gemma 4 E2B for local semantic mapping

> Superseded by issue #171 for Gemma 4 E2B specifically. This historical decision explains why that
> pack was removed; it does not prohibit a smaller accepted import model from becoming a mandatory,
> lazily loaded onboarding dependency.

Alyte evaluated Gemma 4 E2B using the pinned Q4_0 GGUF artifact and llama.cpp runtime as a possible
first-release local semantic model pack. Although it improved some structured-OCR mappings, the
model's review burden, memory footprint, and multi-gigabyte download did not justify making it a
prerequisite for automated import. Issue #171 therefore restored the deterministic Vision,
locale-parser, alias, and validator path while smaller alternatives were evaluated. The Gemma
research artifact remains available for isolated evaluation only; the current MVP contract permits
a separately accepted, mandatory import pack with extraction-scoped lazy loading.

## Consequences

The Gemma model pack and its memory entitlements are no longer part of the mobile MVP. Future model
work must be separately accepted and unable to weaken validation or silently accept uncertain
mappings.

## Retired development-artifact cleanup decision

The retired module managed only its exact Gemma GGUF artifact,
`gemma-4-E2B-it-Q4_0.gguf`, and its dot-prefixed partial, verification, and previous-artifact
siblings under `Application Support/Alyte/Models`. These files are non-health development
artifacts: the MVP never reads them, includes them in an export, or uses them as a database or
report source. No released MVP build created them, so there is no health-data migration to run.

An existing developer install may reclaim that storage by deleting the Alyte app from iOS Settings
→ General → iPhone Storage → Alyte and reinstalling the current build. Because app deletion also
removes local health records, a developer or tester must first create and securely retain a Full
Export if the records matter; export restore is outside the MVP, so this is a development-only
recovery path and may require re-importing original reports or re-entering records. New MVP builds
neither create nor read this directory. Any future accepted model feature must provide an in-app,
data-preserving cleanup before reusing the path.
