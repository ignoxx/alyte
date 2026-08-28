# Alyte

Alyte is a private, local-first laboratory-history app with a later cloud-backed intake-awareness slice.

It helps adults organize measured biomarker history and, after the local journey is accepted, view logged intake beside carefully sourced general relationships. It does not diagnose, prescribe, determine what caused a result, or turn model output into medical truth.

The first public iOS release must qualify for Shipaton by September 30, 2026.

Before that date, protect the smallest complete account-free experience:

**import two reports → review and correct measurements → understand compatible measured changes → export or delete everything**

Do not expand optional cloud breadth at the expense of that journey.

## What matters most

Alyte should feel trustworthy because it is conservative about what it knows, explicit about where data came from, and calm about what the user should do next.

These are not feature priorities. They are product constraints.

### 1. Measured means measured

Never blur observed laboratory results with extraction, estimation, inference, prediction, evidence, or user-entered context.

If a value was not measured, do not make it look measured.

### 2. Uncertainty stays visible

Unknown dates, incompatible units, unsupported mappings, uncertain quantities, missing doses, mixed evidence, and model failures remain visible.

Do not improve the appearance of certainty by guessing.

### 3. Health interpretation stays general

Alyte may describe measured direction and show reviewed general relationships beside logged context.

It does not determine why a result changed, diagnose a condition, recommend treatment, alter medication, calculate a dose, or predict a current biomarker value.

### 4. Local mode is the product

The account-free laboratory journey must remain complete without network access or authentication.

Cloud features are optional extensions, not dependencies disguised as convenience.

### 5. Privacy should be understandable

Complex security machinery should resolve into a simple user answer:

- what is stored;
- where it is stored;
- what is leaving the device;
- why it is leaving;
- how long it exists;
- and how to delete it.

### 6. Simplicity wins

Prefer ambitious outcomes and small systems.

Do not preserve complexity because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint and implement the smallest model that makes the correct behavior unsurprising.

Channel both “measure twice, cut once” and YAGNI.

Fight scope creep.

## Read the right source

Do not reconstruct product intent from code when an accepted source exists.

- **Domain terms or schema:** read [`CONTEXT.md`](CONTEXT.md) before naming or changing records.
- **Product behavior, scope, pricing, language, or launch support:** read [`docs/MVP.md`](docs/MVP.md).
- **Mobile, storage, native modules, cloud jobs, encryption, or backend:** read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and applicable ADRs.
- **Sequencing or scope cuts before September 30:** read [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md).
- **CalorieMate or T3 Code inspiration:** read [`docs/REFERENCE-REPOS.md`](docs/REFERENCE-REPOS.md). Their design and complexity are references, not defaults.
- **Implementation tickets and acceptance details:** GitHub Issues are authoritative. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- **Domain-document maintenance:** see [`docs/agents/domain.md`](docs/agents/domain.md).

When an accepted source changes, update every now-inconsistent pointer or decision.

Do not duplicate durable rules across several documents. Keep one source of truth and point to it.

## A small glossary

Use the canonical terms from `CONTEXT.md`.

In particular:

- a **Lab Report** is a source document;
- a **Lab Record** is one specimen-collection event;
- a **Biomarker** is what is measured;
- a **Measurement** is one observed result;
- a **Measured Trend** contains compatible Measurements only;
- an **Intake Event** records consumption;
- an **Intake Image** is evidence about an Intake Event;
- an **Influence Candidate** is untrusted model output;
- an **Evidence Relationship** is curated reviewed content;
- a **Potential Relationship** is general education;
- **Related Wellness Context** juxtaposes records without claiming cause;
- a **Laboratory Reference Interval** comes from the laboratory;
- **General Guidance** is app-supplied educational content.

Use stable canonical IDs in persistence and contracts.

Display strings, translations, aliases, and original laboratory labels are never identifiers.

## The ways to hurt Alyte

Most serious mistakes in this repository fall into a few categories.

### 1. Inventing health facts

Never interpolate Measurements, predict current values, manufacture mappings, perform authoritative unit conversion with an LLM, infer a consumed dose, or turn a plausible relationship into causation.

### 2. Losing provenance

Never overwrite source facts with normalized or corrected values.

A user must be able to tell what the source said, what extraction produced, what they corrected, what was estimated, and what reviewed evidence supplied.

### 3. Leaking health data

Do not put personal reports, OCR text, Measurements, medication names, intake descriptions, prompts, model results, exports, images, or credentials into ordinary logs, analytics, traces, screenshots, fixtures, crash reports, agent context, or source control.

### 4. Making cloud implicit

Never silently move the local laboratory journey into cloud processing.

Before first upload, show the exact outgoing artifact and purpose. Send only what the operation requires.

### 5. Breaking reversibility

If you add a way in, account for the way out and the way to see the current state.

Import needs deletion. Extraction needs correction. Inclusion needs exclusion. Sign-in needs sign-out. Subscription needs restore. Upload needs expiry or cleanup. Retryable work needs a safe retry state.

### 6. Solving the wrong release

Do not sacrifice the complete two-report local journey for speculative architecture, optional cloud capability, broad polish, or exhaustive testing.

September 30 is a product constraint.

## Hit every affected surface

The most common class of agent defect is implementing the path that was obvious and missing its siblings.

Before calling a change complete, explicitly consider which of these apply:

- **Data provenance:** source, measured, user-entered, extracted, estimated, evidence-backed.
- **Lifecycle:** create/import, review, correct, include/exclude, retry, export, delete.
- **Storage:** SQLite rows, protected files, WAL/SHM, exports, Keychain, temporary cloud artifacts.
- **App states:** first launch, account-free, offline, authenticated, paid, expired, failed, resumed.
- **UI states:** empty, loading, success, review required, partial data, actionable failure, safe retry.
- **Accessibility:** VoiceOver, Dynamic Type, reduced motion, contrast, safe areas, dark mode.
- **Locale:** dates, decimal separators, units, translated strings.
- **Native impact:** Expo config, Swift modules, entitlements, permissions, native fingerprint, new binary requirement.
- **Evidence:** catalogue version, evidence strength, wording guardrails, unsupported candidates.
- **Privacy:** exact upload artifact, retention, logging, deletion, encryption.
- **Reverse operation:** if the user can do it, can they undo, correct, exclude, retry, export, or delete it where appropriate?

Do not mechanically change every category. Decide deliberately which apply.

## Product invariants

1. **Separate provenance.** Measured, user-entered, extracted, estimated, and evidence-backed data have distinct types, labels, and visual treatments.

2. **Measured values stay measured.** Never interpolate or predict concrete biomarker values between Lab Records.

3. **Association stays general.** Logged intake may be shown beside a Measured Trend. Alyte does not decide that it caused or probably contributed to that trend.

4. **Clinical decisions stay clinical.** Alyte does not diagnose, recommend treatment, alter medication, calculate doses, or label a person deficient or diseased.

5. **Local mode remains complete.** Lab import, Original-source review, focused extraction review, history, explanations, trends, export, and deletion do not require an account. The Sanitized Report path remains a separate future cloud artifact and is not part of account-free extraction.

6. **Cloud exposure is explicit and minimal.** Show the exact artifact and purpose before first upload. Send only what the operation requires. Keep no durable cloud health record.

7. **The user controls the record.** Corrections preserve provenance. Inclusion is reversible. Local and cloud deletion are independent. Apply the unlinkable replay-marker boundary from [ADR 0010](docs/adr/0010-account-deletion-and-auth-replay-markers.md). Full Export remains available.

8. **Ambiguity is honest.** Unsupported mapping, incompatible units, missing dates, mixed evidence, unknown amount or dose, and model failure remain visible.

9. **Health facts are reviewed content.** Runtime models may structure observations and propose candidates. Displayed explanations and health relationships resolve to the versioned Evidence Catalogue.

10. **The interface stays calm.** Privacy, parsing, evidence, and failure handling should produce understandable next actions rather than scores, warnings, or permanent usage anxiety.

## How Alyte works

The iPhone is the health-record source of truth.

Source documents and images are protected files. Structured records live in SQLite. Extraction creates provenance-linked candidates rather than rewriting source truth. Pure domain logic turns validated records into compatible trends and reviewed educational context. React Native presents view models and invokes actions. Narrow native modules expose platform capabilities that are better owned by iOS. Optional backend work receives only explicitly selected artifacts, validates provider output, returns device-encrypted results, and cleans up temporary readable data.

Keep that model small.

### Ownership

- **React Native / Expo** owns ordinary UI and application orchestration.
- **Narrow Swift Expo modules** own Vision, PDFKit, iOS Data Protection, backup exclusion, and CryptoKit.
- **SQLite repositories** own structured local persistence.
- **Protected file services** own reports, images, and exports.
- **Pure domain functions** own parsing, compatibility, unit conversion, measured trends, Nutrition Buckets, catalogue resolution, invalidation, and wording guards.
- **Provider adapters** own external model and service peculiarities.
- **Backend services** own optional request admission, entitlement and usage accounting, temporary processing, strict result validation, device-result encryption, and cleanup.

Screens compose view models and actions.

They do not contain SQL, unit-conversion logic, biomarker alias tables, evidence selection, provider-response parsing, purchase-ledger rules, or hidden health interpretation.

Complexity belongs at adapters.

Do not introduce T3 Code's Effect architecture, event sourcing, or another generalized framework without a demonstrated Alyte requirement and maintainer agreement

## Source and derived data

Preserve source truth.

- Keep the Original Report and its original label, value string, unit, range, flag, page, bounding box, and immutable hash.
- Local extracted Measurements retain provenance to the protected Original Report.
- A future sanitized cloud draft is a distinct artifact, never an implicit replacement for the local source.
- Store parsed and normalized values beside source fields, never over them.
- Corrections create explicit provenance rather than silently rewriting extraction history beyond recovery.
- Derived charts and insights must be reproducible from source IDs plus parser and catalogue versions.
- Editing, excluding, or deleting a source invalidates dependent output and recomputes current context.
- Unit conversion is deterministic and tested.
- An LLM never performs the authoritative conversion.
- Unknown results remain preserved even when they cannot be charted or explained.

## AI and evidence

Treat every provider response as untrusted input.

Decode model output with versioned runtime and semantic schemas before it enters the domain.

Raw PDF and OCR observations remain internal provenance. Only measurement-shaped candidates enter a draft.

An optional on-device model may select source IDs or propose mappings. It does not author authoritative values, units, conversions, medical explanations, or diagnoses.

Store the provider, model, prompt/schema version, parser version where relevant, and Evidence Catalogue version with derived output.

Keep user health payloads out of logs and durable backend metadata.

Recognition may identify visible components, label facts, broad amount ranges, and up to five open Influence Candidates. It does not write free-form medical copy into the product.

User-entered quantity and verified label data outrank image estimates.

Convert broad numeric nutrition ranges into versioned qualitative buckets. Photo-only output should not lead with exact calories or macros.

Estimate Quality may be `strong`, `fair`, or `weak`, with factual reasons. Estimate Quality is not extraction-review state and is not Evidence Strength.

Never expose an LLM's self-reported confidence as product accuracy.

Unmapped Influence Candidates remain unsupported and do not become health claims.

### Wording boundary

Acceptable:

- `Your measured LDL increased between these two tests.`
- `Frequently consuming foods high in saturated fat may contribute to higher LDL over time.`
- `This measured direction is compatible with some logged context, but the app cannot determine why it changed.`
- `There is not enough information to identify a clear pattern.`

Forbidden:

- `This meal raised your LDL.`
- `Your vitamin D is probably 42 ng/mL now.`
- `The prediction was 92% accurate.`
- `Stop taking this medication.`
- `You have a vitamin deficiency.`

Use fixtures and wording guards to prevent forbidden patterns from reaching user-visible content.

## Privacy and security

Use synthetic or explicitly de-identified fixtures only.

Real personal reports stay outside source control, agent context, logs, screenshots, test artifacts, and ordinary developer tooling.

Original Reports, Sanitized Reports, Intake Images, database files, WAL/SHM files, and exports must remain under verified iOS Data Protection and excluded from iCloud Backup.

Redaction creates a newly rendered artifact with no original text layer, annotations, attachments, or recoverable metadata.

Preview the exact outgoing artifact.

Keep keys and refresh tokens in Keychain/CryptoKit.

Keep documents, OCR text, Measurements, medication names, intake descriptions, prompts, and model results out of ordinary preferences, analytics, traces, and crash reports.

Use parameterized SQL, explicit forward migrations, foreign keys, and transactions for multi-row domain changes.

Cloud uploads are deleted immediately after provider use and defensively expire.

Completed readable output becomes a device-encrypted result envelope that expires within 24 hours or after retrieval.

Account deletion preserves local records unless the user separately requests local deletion.

Local deletion removes database rows and referenced files and verifies cleanup.

## UX defaults

First launch enters local mode after short onboarding.

Authentication appears only when the user reaches the first paid cloud action.

Until the local laboratory gate passes, the native tab bar contains Home, Labs, and Settings. Incomplete Snap, Log, account, and paywall surfaces stay hidden even if later implementation code exists.

Report import is a focused full-screen task above the tabs.

The privacy workspace shows one aspect-correct, zoomable page at a time.

Draft review should surface credible Measurements and genuine exceptions rather than every OCR line.

In the later cloud/intake slice, Snap persists the Intake Event and image before returning promptly. Upload and analysis continue asynchronously and resume safely after suspension or network failure.

Every durable workflow reaches an observable success, review state, actionable failure, expiry, or safe retry state.

Preserve user edits through failure.

Packaging may identify a supplement or medication and printed strength. Consumed amount or dose remains unknown until the person confirms it.

Measured charts use solid measured points and lines.

Relationship context never extends, predicts, or visually imitates a measured curve.

Respect VoiceOver, Dynamic Type, reduced motion, contrast, safe areas, dark mode, and locale-aware dates and decimals from the first component.

Put user-visible strings in localization resources even while English is the only shipped language.

## Test data

An empty or toy-only dataset is insufficient for high-risk flows.

Use synthetic fixtures that reproduce realistic structure and edge cases without reproducing real health information.

Fixtures should deliberately cover messy reports, locale differences, missing dates, incompatible units, password PDFs, OCR mistakes, duplicate-looking results, correction history, deletion, interrupted jobs, and unsupported evidence mappings where relevant.

Do not use real personal health documents as convenient test data.

## Verification

Use the smallest proof that establishes the changed behavior.

Do not optimize for a numeric coverage target.

Use risk-based verification.

A defect deserves stronger verification when it could:

- lose or corrupt health data;
- expose private information;
- charge or consume allowance incorrectly;
- misstate measured or medical context;
- break migration or deletion;
- produce an unrecoverable workflow;
- or make the UI visually imply something that is not true.

For those cases, add focused tests.

Straightforward presentation, wiring, or behavior already guaranteed by a typed framework contract may use targeted typechecking and one integrated check instead.

### High-risk verification

Focused tests are expected for applicable changes involving:

- migration from every released schema and complete deletion;
- locale dates and decimals;
- alias matching and unit compatibility;
- missing Measurements and missing dates;
- OCR-to-source provenance and user correction;
- password PDFs;
- page transforms;
- redaction flattening and metadata removal;
- exact-upload preview;
- measured-versus-contextual chart rendering;
- Evidence Catalogue decoding and versions;
- catalogue signatures where applicable;
- forbidden wording;
- cloud idempotency;
- cleanup and expiry;
- result encryption;
- exactly-once allowance consumption;
- account-free and offline launch;
- purchase, restore, and exhaustion;
- export;
- independent account and local deletion.

Run targeted formatting, type checks, tests, and native checks for the code touched.

Repository scripts are the command source of truth.

For meaningful UI work, perform one integrated simulator or device pass after integration.

Do not run broad verification merely to appear thorough when a smaller test proves the change.

## Working method

When implementing an MVP ticket, read the complete GitHub issue, `docs/MVP.md`, and [`docs/agents/SOL-LUNA-ORCHESTRATION.md`](docs/agents/SOL-LUNA-ORCHESTRATION.md).

GitHub Issues are the ticket source of truth.

Local plans, generated scratch documents, agent notes, and temporary research are not authoritative.

Sol owns dependency-frontier scheduling and integration, including the single post-implementation review and remediation brief.

Implementation subagents own the code changes delegated to them.

Delegated implementation uses GPT-5.6 Luna at xhigh reasoning in an isolated worktree when parallel, and each implementation subagent invokes Matt Pocock's `implement` skill.

Follow the review and remediation sequence in `docs/agents/SOL-LUNA-ORCHESTRATION.md`.

For Expo/EAS or mobile-app tasks, invoke the official Expo skills beginning with `expo-overview`, then load the applicable leaf skills before planning or changing code.

Apply them to Alyte's existing architecture.

A framework migration or native-fingerprint change still requires an explicit ticket need and maintainer agreement.

For mobile UI work, also invoke `appllama-app-design-skill`.

Use the pinned T3 Code mobile app as a concrete benchmark. Extract patterns rather than pixels.

Complete the skill's Simulator inspection loop before calling meaningful interface work done.

Expo's official guidance decides SDK-compatible packages and component choices when skill guidance conflicts.

### Implementation sequence

1. State the user-visible outcome.
2. Classify every affected datum as source, measured, user-entered, extracted, estimated, or evidence-backed.
3. Read the applicable source documents, feature flow, schema, migrations, adapters, and focused tests.
4. Trace forward and reverse states before editing.
5. Identify which “Hit every affected surface” categories actually apply.
6. Choose the smallest complete vertical change and name deliberate exclusions.
7. Implement domain behavior independently from presentation and platform/provider adapters where practical.
8. Add focused tests for non-trivial logic and costly failure modes.
9. Run targeted formatting, type checks, risk-focused tests, and applicable native checks.
10. Perform one integrated simulator/device pass for meaningful UI work after integration.
11. Report the outcome, verification, deliberate exclusions, remaining limitations, and any privacy, evidence, migration, or native-fingerprint impact.

Optimize in this order:

**make the smallest complete experience work → observe whether people use and pay for it → improve it**

Prefer shipping evidence over speculative abstraction, speculative polish, or exhaustive coverage.

## Plans and work artifacts

Do not turn temporary agent thinking into permanent repository truth.

Implementation plans, scratch notes, generated research, exploratory diagrams, review notes, and remediation drafts should remain ephemeral unless they contain a durable decision.

Durable information belongs in the appropriate accepted source:

- product behavior in `docs/MVP.md`;
- domain language and schema meaning in `CONTEXT.md`;
- architecture in `docs/ARCHITECTURE.md`;
- accepted architectural decisions in `docs/adr/`;
- launch sequencing in `docs/IMPLEMENTATION-PLAN.md`;
- active implementation requirements in the owning GitHub Issue.

When implementation lands, update durable documentation if reality changed.

Do not preserve a second stale checklist merely because an agent generated one during implementation.

The code, accepted docs, ADRs, and owning issue should agree.

## Change discipline

Preserve unrelated edits.

Do not hand-edit generated files when prebuild or another generator owns them.

Prefer focused modules and explicit names over generic utility folders.

Comments explain provenance, constraints, externally imposed behavior, and non-obvious platform decisions. Do not narrate obvious code.

Add a dependency only when its platform support, privacy behavior, maintenance cost, and removal path are understood.

Call out native-fingerprint changes because they require a new binary.

One owner integrates migrations, generated native projects, cross-cutting state changes, and the final simulator pass.

Bounded agents may independently inspect concerns or implement isolated pure modules.

Do not create abstractions for hypothetical future agents, cloud providers, schemas, platforms, or features.

Commit, push, and open pull requests only when explicitly requested.

When requested, keep one plain-language conventional concern per commit or PR.

When a task conflicts with a product invariant or accepted ADR, surface the conflict and obtain maintainer agreement before crossing it.

## Taste

Prefer:

- explicit data ownership over implicit magic;
- reversible state over one-way workflows;
- boring deterministic domain logic over clever model behavior;
- concrete types over strings with hidden meaning;
- small adapters around external complexity;
- source-linked derived data over cached conclusions;
- one obvious workflow over several configurable abstractions;
- calm factual language over persuasive health language;
- deletion that is demonstrably complete;
- UI that makes provenance visually obvious;
- a focused test proving the risky behavior over a large unrelated suite.

Avoid:

- generic framework layers with one implementation;
- speculative plugin/provider abstractions;
- health-domain behavior embedded in screens;
- “temporary” privacy shortcuts;
- model output that becomes authoritative through convenience;
- duplicate sources of truth;
- permanent documents describing plans that already shipped;
- features whose description contains “and while we're here.”

If a rule here fights the actual task, do not silently work around it. Surface the conflict.

## Completion bar

The September release path is complete only when a person can import two reports, correct them, and understand their compatible measured changes in under five minutes without an account.

Before calling a change complete, ask:

- Can the user tell source facts from extraction, estimation, user input, and evidence-backed context?
- Did any code invent, interpolate, normalize, upload, retain, or log more than its contract permits?
- Is the source provenance still recoverable after normalization or correction?
- Can the user review, correct, exclude, retry, export, and delete the affected data where applicable?
- Does every displayed health statement resolve to reviewed content with the correct version?
- Are missing dates, unknown doses, incompatible units, unsupported mappings, and model failures represented honestly?
- Does local mode still work without an account and without a network?
- Did the change preserve the complete two-report journey?
- Did focused verification establish the risky behavior?
- Did the relevant integrated user flow actually work?
- Did this change introduce privacy, evidence, migration, cloud-retention, payment, or native-fingerprint consequences that need to be called out?

