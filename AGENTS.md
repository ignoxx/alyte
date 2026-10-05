# Alyte

A stopped personal experiment in on-device AI and local-first laboratory history.
See [README.md](README.md) for current status. Historical plans do not authorize new work.

## Read only what the task needs

- Domain terms, canonical IDs, and schema: [CONTEXT.md](CONTEXT.md).
- Product behavior and wording: [docs/MVP.md](docs/MVP.md).
- Storage, native modules, backend, and privacy: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  and applicable [ADRs](docs/adr/).
- Historical scope and sequencing: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md).
- Reference projects: [docs/REFERENCE-REPOS.md](docs/REFERENCE-REPOS.md).
- Ticket requirements: the complete owning GitHub issue and its comments;
  see [issue-tracker.md](docs/agents/issue-tracker.md).

Keep durable decisions in their owning document. Update inconsistent pointers, avoid duplicate
rules, and keep scratch plans and review notes out of the repository.

## Product boundaries

- Preserve the account-free, offline journey: import reports, review and correct measurements,
  compare compatible measured results, export, and delete.
- Keep source, measured, extracted, user-entered, estimated, and evidence-backed data distinct.
  Preserve original fields and source links; corrections must remain traceable.
- Never invent measurements, interpolate or predict biomarker values, infer consumed doses,
  diagnose, recommend treatment, or claim that logged intake caused a measured change.
- Models produce untrusted proposals. Validate them before use; deterministic code owns parsing,
  canonical mapping, unit conversion, and comparison. Displayed health explanations resolve to
  the versioned, reviewed Evidence Catalogue.
- Keep missing dates, incompatible units, unsupported mappings, unknown amounts, and failures
  visible. Charts must distinguish measured results from contextual information.
- Preserve edits through failure. Imports need review and deletion; inclusion needs exclusion;
  retryable work needs a safe retry state. Source changes invalidate dependent output.

## Privacy and storage

- Use synthetic or explicitly de-identified fixtures. Never put personal reports, images, OCR,
  health payloads, model output, exports, or credentials in source control, agent context,
  ordinary logs, analytics, traces, crash reports, or screenshots.
- Keep private evaluation data and local checkpoints out of pushes.
- Protect reports, media, database/WAL/SHM files, and exports with verified iOS Data Protection
  and backup exclusion. Keep keys and refresh tokens in Keychain/CryptoKit.
- Cloud processing is optional and explicit: preview the exact outgoing artifact and purpose,
  send only what is required, and enforce cleanup and expiry. Redaction must remove recoverable
  source content, text layers, annotations, attachments, and metadata.
- Use parameterized SQL, forward migrations, foreign keys, and transactions. Verify deletion of
  rows and referenced files. Account deletion preserves local records; follow
  [ADR 0010](docs/adr/0010-account-deletion-and-auth-replay-markers.md).

## Implementation and verification

- Preserve unrelated edits. Make the smallest complete change; avoid speculative frameworks,
  dependencies, optional features, and broad refactors. Surface conflicts with accepted ADRs.
- Screens compose view models and actions. Keep SQL in repositories, files in file services,
  domain logic in pure functions, and native/provider details in narrow adapters.
- Respect accessibility, dark mode, safe areas, and locale-aware dates, decimals, and units.
  Put user-visible strings in localization resources.
- For Expo/mobile work, load `expo-overview` and applicable leaf skills before editing.
  Mobile UI work also uses `appllama-app-design-skill` and its simulator inspection loop.
- Do not hand-edit generated native files. Dependency or native-fingerprint changes require a
  concrete task need; report when a new binary is required.
- Use repository scripts for focused formatting, typechecking, tests, and native checks.
  Add tests for costly risks such as provenance, parsing, migration, deletion, privacy, health
  wording, billing, or interrupted workflows. Meaningful UI changes need an integrated device
  or simulator pass. Documentation-only changes need link and formatting checks.
- Delegate only when requested. If the historical ticket workflow is explicitly resumed, consult
  [SOL-LUNA-ORCHESTRATION.md](docs/agents/SOL-LUNA-ORCHESTRATION.md).
- Commit, push, and open PRs only when requested. Avoid destructive operations and history
  rewrites without explicit authorization.
- Report what changed, focused verification, remaining limitations, and any privacy, evidence,
  migration, cloud-retention, payment, or native-fingerprint impact.
