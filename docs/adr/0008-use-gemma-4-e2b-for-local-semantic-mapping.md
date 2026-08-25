---
status: accepted
---

# Use Gemma 4 E2B for local semantic mapping

Alyte will ship Gemma 4 E2B using the pinned Q4_0 GGUF artifact and llama.cpp runtime as its sole
first-release local semantic model pack. On the unchanged multilingual structured-OCR fixture,
Gemma referenced 10 of 12 expected rows and materially outperformed Qwen 3.5 0.8B, while its model
output still created too much review work to be authoritative. Alyte accepts that MVP trade-off:
the deterministic validator must reject malformed, duplicated, unknown, incompatible, or invented
proposals, and unresolved Measurements remain visible for focused user review. Model weights are
downloaded explicitly after installation, verified against the pinned manifest, and never bundled
in the app binary.

## Consequences

The first pack is approximately 2.84 GB and may use more than 1 GB of memory on a current iPhone.
The runtime must unload under pressure and existing history must remain usable if the pack is
missing or deleted. Improving review burden is follow-up work; it must not weaken validation or
silently accept uncertain mappings.
