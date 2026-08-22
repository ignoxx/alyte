# Reference repository findings

This note records the useful engineering lessons from the two repositories selected before
implementation. It is not a dependency inventory and does not authorize copying their product
designs.

## Revisions inspected

- [ignoxx/caloriemate](https://github.com/ignoxx/caloriemate) at
  `73bc91554235c882a39fb415fd73f9add21ad31e`
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at
  `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e`

These revisions were inspected on August 21, 2026. Re-check upstream before copying a version,
build command, or platform workaround.

## CalorieMate

CalorieMate is useful as a record of the original fast meal-analysis idea, not as Alyte's
architecture or visual reference.

### Keep the underlying lessons

- A capture should become durable immediately and finish analysis asynchronously.
- A primary image and supporting evidence are different roles. Packaging, labels, ingredients,
  receipts, and scale readings should not silently become additional consumed items.
- User-provided quantities and label facts outrank visual estimates.
- Vision providers should sit behind a replaceable adapter.
- Model output needs a strict machine-readable schema, low-variance settings, and validation before
  it reaches product state.
- The person must be able to add context and correct recognition after the first result.

### Change these parts for Alyte

- Do not expose an LLM's self-reported uncertainty percentage as confidence. Alyte separates
  extraction review state, estimate quality, and scientific evidence strength.
- Do not lead with exact photo-derived calories or macros. Store broad ranges when useful and derive
  deterministic qualitative Nutrition Buckets.
- Do not automatically reuse an older analysis because two image embeddings are close. Similarity
  may offer a user-confirmed shortcut, never an automatic fact.
- Do not combine recognition, nutrition estimation, and health claims into one trusted model
  response. Recognition is untrusted input; health relationships must resolve to the curated
  Evidence Catalogue.
- Do not retain uploaded health or intake media in an ordinary server-side record store.

No CalorieMate frontend design is an Alyte reference.

## T3 Code mobile

T3 Code confirms that a polished, native-feeling iOS app can use React Native and Expo while moving
the few genuine platform boundaries into Swift modules. Alyte should borrow this operating
model without importing T3 Code's product-specific complexity.

### Adopt

- React Native, Expo development builds, TypeScript strict mode, and reproducible Expo prebuilds.
- React Navigation native stacks and sheets so UIKit owns important transitions, headers, and
  gestures.
- Tracked local Expo modules and config plugins for native capabilities.
- Small platform adapters and `.ios.tsx` files instead of platform checks scattered through screens.
- Development, preview, and production app variants with separate identifiers.
- EAS build profiles and a native-runtime fingerprint policy for safe over-the-air updates.
- A small set of UI primitives and design tokens rather than one-off screen styling.
- SQLite with explicit migrations, foreign keys, WAL where compatible, and parameterized queries.
- Secure Store/Keychain only for small secrets and keys; ordinary structured data belongs in the
  database and large assets belong in protected files.
- Typed errors at persistence, provider, and native-module boundaries.
- Feature-oriented source folders, colocated focused tests, and pure model functions for logic that
  does not require a device.
- Deterministic production-screen screenshot fixtures for App Store assets.
- Focused verification for changed code plus one integrated simulator pass for meaningful UI work.

### Do not copy by default

- T3 Code's Effect services, atom graph, WebSocket orchestration, event sourcing, projectors,
  reactors, and provider adapter fleet solve a substantially larger distributed product. They are
  not the smallest model for Alyte.
- Widgets, share extensions, push notifications, tablet split-pane behavior, Android workarounds,
  terminals, and rich markdown native modules are outside this MVP.
- T3 Code's visual identity is an inspiration for polish and native behavior, not a template for a
  health journal.

## Agent-workflow lessons

T3 Code's `AGENTS.md` works well because it records product invariants, precise domain language,
dangerous local-environment traps, architecture boundaries, and observable completion criteria. It
does not attempt to prescribe every implementation.

Alyte should follow the same pattern:

1. Put stable vocabulary in `CONTEXT.md`.
2. Put product behavior and exclusions in `docs/MVP.md`.
3. Put durable technical boundaries in `docs/ARCHITECTURE.md` and ADRs.
4. Keep the final `AGENTS.md` short enough to remain active context, with sharp pointers to those
   deeper documents.
5. Require reverse states for imports, corrections, redactions, inclusion, accounts, and deletion.
6. Require the smallest focused proof, then one integrated simulator check for a completed visual
   flow.
7. Let parallel agents inspect bounded concerns, but keep integration, migrations, generated native
   projects, and the final simulator pass under one owner.
