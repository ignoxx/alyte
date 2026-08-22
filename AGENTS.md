# Alyte — AGENTS.md

## Product

Alyte is a private, local-first laboratory-history and intake-awareness app. It helps adults
organize measured biomarker history and view logged intake beside carefully sourced general
relationships. It does not diagnose, prescribe, or determine what caused a result.

The first public iOS release must qualify for Shipaton by September 30, 2026. Protect the complete
account-free two-report journey before expanding optional cloud breadth.

## Read the right source

- **Domain terms or schema:** read [`CONTEXT.md`](CONTEXT.md) before naming or changing records.
- **Product behavior, scope, pricing, language, or launch support:** read
  [`docs/MVP.md`](docs/MVP.md).
- **Mobile, storage, native modules, cloud jobs, encryption, or backend:** read
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the applicable ADRs.
- **Sequencing or scope cuts before September 30:** read
  [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).
- **CalorieMate or T3 Code inspiration:** read
  [`docs/REFERENCE-REPOS.md`](docs/REFERENCE-REPOS.md); their design and complexity are not defaults.

When one of these documents changes, update every now-inconsistent pointer or decision. Keep one
source of truth rather than repeating the same rule here.

## Product invariants

1. **Separate provenance.** Measured, user-entered, extracted, estimated, and evidence-backed data
   have distinct types, labels, and visual treatments.
2. **Measured values stay measured.** Never interpolate or predict concrete biomarker values between
   Lab Records.
3. **Association stays general.** Logged intake may be shown beside a Measured Trend; Alyte
   does not decide that it caused or probably contributed to that trend.
4. **Clinical decisions stay clinical.** The product does not diagnose, recommend treatment, alter
   medication, calculate doses, or label a person deficient or diseased.
5. **Local mode is a complete product.** Lab import, review, history, explanations, trends, manual
   intake, export, and deletion do not require an account.
6. **Cloud exposure is explicit and minimal.** Show the exact artifact and purpose before first
   upload. Send only what the selected operation requires and keep no durable cloud health record.
7. **The user controls the record.** Corrections preserve source provenance. Inclusion is reversible.
   Local and cloud deletion are independent. Full Export is available.
8. **Ambiguity is honest.** Unsupported mapping, incompatible units, missing dates, mixed evidence,
   and unknown amount/dose remain visible instead of being guessed away.
9. **Health facts are reviewed content.** Runtime models structure observations and propose
   candidates; displayed relationships and explanations resolve to the versioned Evidence
   Catalogue.
10. **The interface stays calm.** Complex privacy, parsing, and evidence machinery produces clear
    next actions rather than scores, warnings, or permanent usage anxiety.

## Domain boundaries

Use the canonical terms from `CONTEXT.md`. In particular:

- a `Lab Report` is a source document; a `Lab Record` is one specimen-collection event;
- a `Biomarker` is what is measured; a `Measurement` is one observed result;
- a `Measured Trend` contains compatible Measurements only;
- an `Intake Event` records consumption; an `Intake Image` is evidence about it;
- an `Influence Candidate` is untrusted model output; an `Evidence Relationship` is curated;
- a `Potential Relationship` is general education; `Related Wellness Context` juxtaposes records
  without claiming cause; and
- a `Laboratory Reference Interval` always remains distinct from app-supplied `General Guidance`.

Use stable canonical IDs in persistence and contracts. Display strings, translated aliases, and
original laboratory labels are never identifiers.

## Architecture boundaries

The iPhone is the health-record source of truth.

- React Native/Expo owns ordinary UI and orchestration.
- Narrow Swift Expo modules own Vision, PDFKit, iOS Data Protection, backup exclusion, and
  CryptoKit.
- SQLite repositories own structured local data; a protected file service owns documents and
  images.
- Pure domain functions own parsing, unit conversion, compatibility, trends, Nutrition Buckets,
  catalogue resolution, invalidation, and wording guards.
- The backend owns optional request admission, entitlement/usage accounting, temporary processing,
  strict result validation, device-result encryption, and cleanup.

Screens compose view models and actions. They do not contain SQL, unit conversions, biomarker alias
tables, evidence selection, provider response parsing, or purchase-ledger rules.

Complexity belongs at adapters. Keep the core model small; do not introduce T3 Code's Effect or
event-sourcing architecture without a demonstrated Alyte requirement and maintainer
agreement.

## Source and derived data

- Preserve the Original Report and its original label, value string, unit, range, flag, page, and
  bounding-box provenance.
- Store parsed/normalized values beside, never over, source fields.
- Corrections form explicit provenance instead of mutating the extraction record beyond recovery.
- Derived charts and insights remain reproducible from source IDs plus parser/catalogue versions.
- Editing, excluding, or deleting a source invalidates dependent output and recomputes current
  context.
- Unit conversion is deterministic and tested. An LLM never performs the authoritative conversion.
- Unknown results remain preserved even when they cannot be charted or explained.

## AI and evidence

- Treat every provider response as untrusted input and decode it with versioned runtime and semantic
  schemas.
- Store provider, model, prompt/schema, and catalogue versions with derived output; keep user health
  payloads out of logs and durable backend metadata.
- Recognition identifies visible components, label facts, broad amount ranges, and up to five open
  Influence Candidates. It does not write free-form medical copy into the product.
- User-entered quantity and verified label data outrank image estimates.
- Convert broad numeric nutrition ranges into versioned qualitative buckets. Photo-only output does
  not lead with exact calories or macros.
- Present `strong`, `fair`, or `weak` Estimate Quality with factual reasons. Keep it separate from
  extraction review state and Evidence Strength.
- Never publish an LLM's self-reported confidence as product accuracy.
- Unmapped Influence Candidates stay unsupported and do not become health claims.

Good wording:

- `Your measured LDL increased between these two tests.`
- `Frequently consuming foods high in saturated fat may contribute to higher LDL over time.`
- `This measured direction is compatible with some logged context, but the app cannot determine
  why it changed.`
- `There is not enough information to identify a clear pattern.`

Hard guardrails:

- `This meal raised your LDL.`
- `Your vitamin D is probably 42 ng/mL now.`
- `The prediction was 92% accurate.`
- `Stop taking this medication.`
- `You have a vitamin deficiency.`

Use fixtures and wording guards to keep the hard-guardrail patterns out of user-visible content.

## Privacy and security

- Use synthetic or explicitly de-identified fixtures. Real personal reports stay outside source,
  agent context, logs, screenshots, and test artifacts.
- Keep Original Reports, Sanitized Reports, Intake Images, database files, WAL/SHM, and exports under
  verified iOS Data Protection and excluded from iCloud Backup.
- Redaction produces a newly rendered artifact without the source text layer, annotations,
  attachments, or recoverable metadata. Preview the exact outgoing artifact.
- Keep keys and refresh tokens in Keychain/CryptoKit. Keep documents, OCR text, Measurements,
  medication names, intake descriptions, prompts, and model results out of ordinary preferences,
  analytics, traces, and crash reports.
- Use parameterized SQL, explicit forward migrations, foreign keys, and transactions for multi-row
  domain changes.
- Cloud uploads delete immediately after provider use and defensively expire. Completed readable
  output becomes a device-encrypted result envelope that expires within 24 hours or after retrieval.
- Account deletion removes cloud-controlled state and preserves local records. Local deletion
  removes database rows and referenced files and verifies cleanup.

## UX behavior

- First launch enters local mode after short onboarding; authentication appears only at the first
  paid cloud action.
- Snap saves an Intake Event and image before returning to the day view. Upload/analysis continues
  asynchronously and resumes after suspension or network failure.
- Every durable workflow reaches an observable success, review, actionable failure, expiry, or safe
  retry state. Preserve user edits through failure.
- Packaging may identify a supplement or medication and printed strength. Consumed amount/dose stays
  unknown until the person confirms it.
- Measured charts use solid measured points/lines. Relationship context never extends or imitates a
  measured curve.
- Respect VoiceOver, Dynamic Type, reduced motion, contrast, safe areas, dark mode, and locale-aware
  dates/decimals from the first component.
- Put user-facing strings in localization resources even while English is the only shipped UI.

## Working method

When implementing an MVP ticket, read its complete GitHub issue, `docs/MVP.md`, and
`docs/agents/SOL-LUNA-ORCHESTRATION.md`. GitHub Issues is the ticket source of truth; local scratch
generation artifacts are not authoritative. Sol owns dependency-frontier scheduling and
integration, including the single post-implementation review and its remediation brief; Luna owns
all code changes. Delegated implementation uses GPT-5.6 Luna at xhigh reasoning in an isolated
worktree when parallel, and every Luna invokes Matt Pocock's `implement` skill. Follow the review
and remediation sequence in `docs/agents/SOL-LUNA-ORCHESTRATION.md`.

Optimize in this order: make the smallest complete experience work, validate that people use and
pay for it, then improve it. Prefer shipping evidence over speculative abstraction, polish, or test
coverage. There is no numeric coverage target.

1. State the user-visible outcome and classify every affected datum as source, measured,
   user-entered, extracted, estimated, or evidence-backed.
2. Read the applicable source documents, feature flow, schema, migrations, adapters, and focused
   tests.
3. Trace the forward and reverse states before editing: import/delete, extract/correct,
   redact/preview, include/exclude, subscribe/restore, sign in/sign out, and retry/cancel where
   applicable.
4. Choose the smallest complete vertical change and name deliberate exclusions.
5. Implement domain logic independently from presentation and platform/provider adapters where
   practical.
6. For non-trivial logic or a costly failure mode, add a focused failing test and make it pass.
   Straightforward wiring, static presentation, and behavior already guaranteed by a typed
   framework contract may use typechecking plus an integrated check instead.
7. Run targeted formatting, type checks, risk-focused tests, and native checks for touched code. Use repository
   scripts as the command source of truth.
8. For meaningful UI work, perform one integrated simulator/device pass after integration and
   capture visual evidence when requested.
9. Report the outcome, verification, remaining limitation, and any privacy, evidence, migration, or
   native-fingerprint impact.

Bounded agents may inspect independent concerns or implement isolated pure modules. One owner
integrates migrations, generated native projects, and the final simulator pass. Keep unrelated user
changes intact and one concern per change.

## Verification bar

Use risk-based verification, not exhaustive coverage. Concentrate tests where a defect could lose
data, expose private information, charge incorrectly, misstate health context, or break complex
state recovery. Leave obvious low-risk behavior untested when typechecking and a quick integrated
check provide sufficient confidence.

High-risk behavior requires focused tests for:

- migration from every released schema and complete deletion;
- locale dates/decimals, alias matching, units, incompatible results, and missing Measurements;
- OCR-to-source provenance and user correction;
- password PDFs, page transforms, redaction flattening, metadata removal, and exact-upload preview;
- chart distinction between measured and contextual data;
- catalogue decoding, signatures, evidence versions, and forbidden wording;
- cloud idempotency, cleanup, expiry, result encryption, and exactly-once allowance consumption;
- account-free/offline launch, purchase/restore/exhaustion, export, and independent account deletion.

The release path is complete only when a person can import two reports, correct them, and understand
their compatible measured changes in under five minutes without an account.

## Change discipline

- Preserve unrelated edits and avoid generated-file hand changes when prebuild/generation owns them.
- Prefer focused modules and explicit names over generic utility folders.
- Comments explain provenance, constraints, and non-obvious platform behavior.
- Add a dependency only when its platform support, privacy behavior, maintenance cost, and removal
  path are understood.
- Call out native fingerprint changes because they require a new binary.
- Commit, push, and open pull requests only when explicitly requested. Use one plain-language
  conventional concern per requested commit/PR.
- When a task conflicts with a product invariant or accepted ADR, surface the conflict and obtain
  maintainer agreement before crossing it.

## Completion questions

- Can the user tell source facts from extraction, estimation, and evidence-backed context?
- Did any code invent, interpolate, normalize, upload, retain, or log more than its contract permits?
- Can the user review, correct, exclude, retry, export, and delete the affected data?
- Does every displayed health statement resolve to reviewed content with the correct version?
- Are missing dates, unknown doses, incompatible units, and model failures honest?
- Does local mode still work with no account and no network?
- Did focused tests and the relevant integrated flow pass?
