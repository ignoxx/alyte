# Alyte first-release plan

## Outcome

Submit a polished first public iOS build early enough to absorb App Review problems before the
Shipaton deadline of September 30, 2026 at 11:45 PM PDT.

The internal target is App Store submission by September 24. September 25–30 is review and emergency
fix buffer, not ordinary feature time.

## Delivery rule

Build one complete vertical path before adding breadth:

> Two real reports → local extraction → correction → comparable trend → clear explanation, with no
> account and no cloud.

That path is the release. Current implementation stays entirely on this local path until it passes
physical-device acceptance. Snap, cloud recognition, purchases, and wider catalogue coverage remain
required later slices, but none runs in parallel with a broken or visually unaccepted local journey.

Agent scheduling, worktree isolation, delegated execution, and Sol integration follow
`docs/agents/SOL-LUNA-ORCHESTRATION.md`. Planning artifacts alone do not authorize implementation.

Delivery priorities are sequential: first make the smallest complete product work; then validate
users, cloud economics, and payment; then improve breadth, polish, architecture, and coverage. Tests
are risk-based rather than exhaustive, with effort concentrated on privacy, data integrity, money,
health wording, parsing, and asynchronous recovery.

## Milestones

### August 21–24: scaffold and kill-risk spikes

Completion criteria:

- npm workspace, Expo app, Fastify API/job-runner shell, shared contracts, formatting, focused tests,
  and CI exist;
- `npm run dev` watches local source changes without requiring Docker;
- development, preview, and production iOS variants build;
- one protected sample PDF imports through Files and renders via PDFKit;
- one page runs through Vision OCR and returns bounding boxes;
- one visible redaction produces a flattened sanitized PDF whose text/metadata inspection cannot
  recover the redacted source;
- SQLite migration zero-to-one passes and the DB/WAL/SHM receive the intended Data Protection and
  backup-exclusion attributes;
- the chart spike renders ten years of synthetic points accessibly on an iPhone 15 Pro iOS 26
  simulator; and
- a written go/no-go records any native blocker and the smallest fallback.

Fallbacks:

- If reliable structured table extraction is weak, preserve the raw observations internally and
  offer guided manual mapping only for measurement-shaped candidates. Never turn every OCR line
  into mandatory review work.
- If the selected chart library fails performance or accessibility, use a simpler native or SVG
  point/line renderer behind the same chart model.
- If PDF reconstruction cannot meet the redaction verification gate, cloud report upload does not
  ship; local report storage and manual entry still can.

### August 25–September 2: account-free laboratory core

Build:

- three native iOS peer tabs—Home, Labs, and Settings—with no incomplete Snap/Log/cloud affordance;
- a reference-backed UI variant lab for Home's empty and first-populated hierarchy, followed by
  promotion of the maintainer-selected direction;
- local database schema and repositories;
- Files/Photos import, password prompt, protected storage, and a full-screen PDFKit privacy
  workspace for page selection, zoom, pan, crop, rotation, and direct redaction;
- verified Sanitized Report creation before extraction;
- Vision document/table recognition, measurement-candidate filtering, locale parsing, alias mapping,
  unit normalization, and preservation of every credible result;
- a bounded Qwen 3.5 0.8B feasibility benchmark using structured OCR fixtures, followed only by a
  post-install model-pack manager and production mapper if the evidence clears the precision,
  memory, latency, thermal, license, and download-size gates;
- section/table/row specimen context so mixed blood, serum, plasma, urine, and unknown results are
  not assigned one report-wide specimen;
- English, German, and Lithuanian fixtures first, followed by the remaining declared languages;
- compact grouped Extraction Draft review with exception-level reasons and source-page inspection;
- Lab Report library, Lab Record detail, complete Measurement list, deletion, and manual entry; and
- first comparable catalogue fixtures.

Completion criteria:

- two synthetic and two developer-held real reports can complete the success journey in under five
  minutes without an account;
- the app presents no serial review of unrelated OCR text and the common path requires decisions
  only for genuine ambiguities;
- originals remain unchanged and sanitized derivatives pass recovery checks;
- every imported value retains source provenance and can be corrected;
- unknown markers and incompatible units remain visible but cannot enter a false trend; and
- migration, parser, deletion, redaction, and provenance tests pass.

Real personal reports are used only on-device for manual acceptance testing and never enter source,
fixtures, logs, screenshots, or agent context.

### September 3–8: trends and factual understanding

Build:

- Biomarker history and measured chart model;
- missing-date, missing-test, comparator, and incompatible-unit behavior;
- Lab Record summary and two-record comparison;
- laboratory range first, versioned General Guidance fallback second;
- reviewed plain-language explanations for the initial comparable catalogue; and
- signed catalogue build/verification path.

Completion criteria:

- all 15 first comparable Biomarkers have tested aliases/units and reviewed display content;
- charts never interpolate missing Measurements or mix incompatible specimens/units;
- source range, General Guidance, and no-range states are visually distinct; and
- wording fixtures contain no diagnosis, treatment, universal-optimal-range, or causal claim.

### After local Gate A: fast intake and cloud-backed timeline

This milestone does not start until the local two-report journey is accepted. Existing intake code
and persistence remain intact while Snap and Log stay hidden from the local laboratory shell.

Build:

- Home day overview, Log timeline, center Snap camera, manual intake, and Analyze label/reference;
- protected Intake Images and immediate durable Intake Events;
- editable Intake Components, unknown dose/amount states, Log again, Check this, and reversible
  Analysis Inclusion;
- local `cloud_jobs` outbox and foreground/network resumption; and
- deterministic Nutrition Bucket and estimate-quality model.

Completion criteria:

- Snap returns the person to the day view without waiting for analysis;
- killing or suspending the app never loses the local Intake Event;
- correction and exclusion invalidate/recompute dependent local output; and
- packaging never becomes a confirmed consumed dose without user confirmation.

### After local Gate A: cloud path

Cloud remains required; it is sequenced after the local core rather than discarded. Backend-only
preparation may continue only when it cannot consume the product-application owner or destabilize
the local acceptance path.

Build:

- Sign in with Apple, backend sessions, RevenueCat products/webhooks, allowance ledger, and
  idempotent request admission;
- temporary upload, queue, model adapter, strict validators, immediate media cleanup, encrypted
  result envelope, and 24-hour TTL retrieval;
- one Railway EU West service, persistent volume, runtime SQLite migrations, graceful draining, and
  expired-lease recovery;
- intake recognition and selected-page cloud report fallback;
- exact payload disclosure and preference for quieter repeat disclosures; and
- account export and deletion independent from local data.

Completion criteria:

- provider failure and invalid output do not charge;
- one usable result charges exactly once across retries and duplicate callbacks;
- uploaded media is deleted immediately after provider use and defensively expires;
- plaintext results are not durably stored, logged, or included in traces;
- a result produced while the app is closed applies on next launch;
- Starter Pack and Cloud Plus purchase/restore/exhaustion paths work in StoreKit sandbox; and
- Cloud Max is hidden if cost evidence is not ready by the gate below.

### September 14–18: evidence-backed relationships

Build only the reviewed relationship set completed by the research workstream. Likely first
concepts include saturated fat, fiber, refined carbohydrate/added sugar, alcohol, vitamin D
supplementation, vitamin B12 supplementation, and iron intake, but no relationship ships merely
because it appears on this list.

Completion criteria for each relationship:

- sources, population, direction, time horizon, evidence strength, caveats, and review date exist;
- a model candidate maps to a stable catalogue concept;
- displayed copy is assembled from approved content rather than model medical prose;
- immediate Potential Relationship and longitudinal eligibility are tested separately; and
- feedback, exclusion, correction, invalidation, and catalogue-version behavior pass.

If fewer relationships pass review, ship fewer relationships. Catalogue breadth never blocks the
laboratory-history release.

### September 17–20: privacy, export, onboarding, and commercial polish

Build:

- short onboarding that explains local mode, measured versus estimated data, cloud consent, and
  adult-only scope without requiring login;
- privacy dashboard, app lock, exact-upload preview, support/FAQ, terms and privacy links;
- Full Export, local deletion, cloud account export/deletion, and StoreKit restore;
- paywall copy and the provisional EUR prices/allowances from `MVP.md`;
- 80/95/100 percent usage warnings without a permanent Home meter; and
- deterministic showcase fixtures and App Store screenshot automation.

Completion criteria:

- fresh install reaches local Home without authentication or network;
- local data remains after cloud sign-out/account deletion;
- export contains every selected local record and clearly warns about sensitive content;
- no support or analytics path attaches health content; and
- VoiceOver, Dynamic Type, reduced motion, dark mode, and offline states receive an integrated pass.

### September 21–24: release candidate and submission

- Freeze features on September 20.
- Run the complete two-report journey on an iPhone 15 Pro running iOS 26 and a current iOS 26
  iPhone.
- Run purchase, restore, expiry, exhaustion, account deletion, offline, password-PDF, redaction, and
  failed-provider acceptance checks.
- Verify privacy nutrition labels, age rating override, EU trader details, support URL, terms,
  privacy policy, export-compliance answers, screenshots, and review notes.
- Give App Review a synthetic account and fixture path that demonstrates optional cloud features
  without exposing real health data.
- Submit by September 24.

Only blocker fixes may enter after submission. Any native-fingerprint change produces a new binary;
JavaScript-only changes may use a compatible fingerprinted update only when App Review rules and the
release state allow it.

## Workstreams

### Product application

One owner integrates migrations, navigation, source-of-truth rules, and the final simulator. Bounded
agents may implement isolated pure functions, fixtures, content validation, or adapter tests, but
they do not concurrently edit generated native projects or operate the same simulator.

### Evidence and guidance

For every Biomarker or relationship:

1. research authoritative guidance and primary/systematic evidence;
2. record disagreement and applicability instead of selecting a universal `good zone`;
3. draft concise factual content;
4. perform medical-language and source review;
5. encode a versioned catalogue entry; and
6. add fixtures for boundaries, caveats, and forbidden wording.

This workstream may continue after release for catalogue updates. Unreviewed content stays absent.

### Cost evaluation

Before enabling Cloud Plus or Cloud Max, run a private representative fixture set through candidate
models with production image resizing/detail settings. Measure:

- useful schema-valid result rate;
- component/row recall and critical extraction error rate;
- median and tail latency;
- input/output tokens and provider cost by operation;
- retry and moderation/failure rate; and
- expected monthly cost at 300, 500, and 1,500 Snaps plus report allowances.

Pricing is a launch target, not proof of margin. Cloud Max stays hidden until the observed high-usage
cost plus infrastructure, StoreKit commission, taxes, support, and safety margin fits EUR 12.99.

## Release gates

### Gate A — local core, September 2

If the no-account two-report journey is not reliable, understandable, visually accepted, and
complete in under five minutes, do not dispatch cloud or intake implementation. Finish it first.

### Gate B — evidence, September 8

If range/explanation review is incomplete, ship only reviewed entries and show honest unsupported
states. Do not generate missing health copy at runtime.

### Gate C — cloud cost and privacy, September 16

If cleanup, idempotent charging, result encryption, or purchase restoration fails, hide cloud
features. If only Cloud Max economics fail, ship Starter Pack and Cloud Plus.

### Gate D — release candidate, September 20

Cut in this order when unfinished:

1. Cloud Max;
2. integrated lab camera scanner;
3. granular feedback categories;
4. encrypted export and restore;
5. cloud Lab Report fallback;
6. wider Evidence Relationship breadth.

Protect Files/Photos lab import, correction, measured trends, privacy/redaction, ordinary Full
Export, onboarding, and support first. Protect manual intake and Snap only after Gate A passes and
Cloud Plus passes Gate C.

## MVP backlog by vertical slice

1. **Accepted local shell** — three native tabs, variant-lab selection, neutral semantic visual
   foundation, localization resources, service container.
2. **Protected persistence** — migrations, repositories, protected files, deletion verification.
3. **Import source** — Files/Photos, password, page model, original retention.
4. **Privacy workspace** — full-screen PDFKit viewing, crop/rotation/direct redaction, exact artifact
   preview, verification.
5. **Candidate extraction** — Vision document/tables, measurement filtering, locale parsing,
   Lithuanian fixtures, per-section specimen context, deterministic validation, a provider-neutral
   semantic mapper, and structured-fixture Qwen 3.5 0.8B feasibility evaluation through #50.
6. **Required extraction model pack** — no bundled weights; explicit selection and verified Qwen
   3.5 0.8B download before onboarding completes; contextual reinstall gate after later deletion;
   direct public/ungated Hugging Face download from an immutable revision; reviewed
   manifest/license, checksum verification, and storage/load/delete lifecycle through #51; followed
   by constrained extraction integration and deterministic inference-failure fallback through #52.
7. **Laboratory history and review** — compact draft, Reports, Records, Measurements, manual entry,
   source inspection, correction, provenance.
8. **Comparison** — canonical aliases, units, trends, missing/incompatible behavior.
9. **Education** — explanations, ranges/guidance, sources, signed catalogue.
10. **Local control** — export, deletion, app lock, support, privacy dashboard.
11. **Cloud transport** — outbox, auth, consent, upload, status, result envelope.
12. **Cloud intelligence** — intake recognition, report fallback, candidate validation.
13. **Intake core** — cloud-useful capture, Log, Snap, manual entry, correction, inclusion.
14. **Commerce** — products, entitlements, usage ledger, warnings, restore.
15. **Relationships** — Potential Relationships and locally derived interval context.
16. **Release** — fixtures, screenshots, metadata, device matrix, TestFlight, submission.

Each slice is complete when its material reverse and failure states, privacy behavior, highest-risk
tests, and user-visible integrated flow are accounted for. Low-risk obvious wiring does not require
automated coverage merely to raise a coverage number.

## Deferred backlog

After the first release: Android, HealthKit/wearables, iCloud or another compliant sync design,
encrypted export/restore, custom providers/BYOK, barcode and multi-photo intake, notifications,
multi-person/caregiver features, mood/energy correlations, medication relationship analysis, broader
catalogues, and clinician sharing.
