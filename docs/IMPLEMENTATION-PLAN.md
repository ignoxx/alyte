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
physical-device acceptance. Import is the immediate priority, followed by clear measured-history
presentation. Snap and cloud are one optional later extension, not required launch slices; neither
starts until the on-device product works well and provides meaningful value. The proposed one-time
history unlock and unsettled limits are specified in `MVP.md`.

Agent scheduling, worktree isolation, delegated execution, and Sol integration follow
`docs/agents/SOL-LUNA-ORCHESTRATION.md`. Planning artifacts alone do not authorize implementation.

Delivery priorities are sequential: first make the smallest complete product work; then validate
usefulness and payment; then improve breadth, polish, architecture, and coverage. Tests
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
- Files/Photos import, password prompt, protected storage, and the future cloud-upload PDFKit
  privacy workspace for page selection, zoom, pan, crop, rotation, and direct redaction;
- direct Original Report extraction with hash/password verification immediately before and after
  every native page read; trusted selectable PDF pages use the strict PDFKit text-layer adapter,
  while unavailable or untrusted pages and image imports use Vision as their native reader;
  the calm Import → OCR → Review journey and independent source provenance remain
  intact; Sanitized Report creation remains reserved for a future explicit cloud upload. This
  native adapter changes the native fingerprint and requires a new development/TestFlight binary,
  but adds no dependency, entitlement, permission, or database migration;
- Vision document/table recognition, measurement-candidate filtering, locale parsing, alias mapping,
  unit normalization, and preservation of every credible result;
- integrate the selected trusted-PDF header parser and bounded local PaddleOCR fallback, preserving
  Qwen3-VL 2B as an evaluation baseline. Keep native source observations distinct from additional
  model transcriptions requiring review. Follow the device and speed/recall priorities in `MVP.md`;
  desktop extraction results do not close the physical-device acceptance gate;
- section/table/row specimen context so mixed blood, serum, plasma, urine, and unknown results are
  not assigned one report-wide specimen;
- English fixtures and real-report evaluation first, German fixtures and de-identified evaluation
  second; every language uses the same production pipeline, while Lithuanian remains a non-blocking
  stress case rather than a launch gate and other report languages receive no MVP accuracy promise;
- compact grouped Extraction Draft review with exception-level reasons and source-page inspection;
- Lab Report library, Lab Record detail, complete Measurement list, deletion, and manual entry; and
- first comparable catalogue fixtures.

Completion criteria:

- two synthetic and two developer-held real reports can complete the success journey in under five
  minutes without an account;
- the 95 percent under-five-minute Gate 1 target is evaluated separately from upstream candidate
  recovery and remains open until private aggregate results and physical-device acceptance pass;
- selectable PDF pages retain trusted PDFKit provenance, while unavailable or image-only pages
  use Vision; additional PaddleOCR candidates retain their separate recognition provenance;
- the app presents no serial review of unrelated OCR text and the common path requires decisions
  only for genuine ambiguities;
- originals remain unchanged and sanitized derivatives pass recovery checks;
- every imported value retains source provenance and can be corrected;
- unknown markers and incompatible units remain visible but cannot enter a false trend; and
- migration, parser, deletion, redaction, and provenance tests pass.

Private report evaluation requires explicit permission for the intended processing and inspection.
Approved reports, source renders, extraction output, and hash-bound ground truth stay in a designated
private, git-ignored evaluation location. Evaluation permission does not authorize redistribution.
Synthetic fixtures alone belong in source control.

### September 3–8: trends and factual understanding

Build:

- Biomarker history and measured chart model;
- missing-date behavior, including a single device-local fallback only when OCR finds no date
  context, group-level date correction, missing-test, comparator, and incompatible-unit behavior;
- Lab Record summary and two-record comparison;
- laboratory range first, versioned General Guidance fallback second;
- reviewed plain-language explanations for the initial comparable catalogue; and
- signed catalogue build/verification path.

Completion criteria:

- all 15 first comparable Biomarkers have tested aliases/units and reviewed display content;
- charts never interpolate missing Measurements or mix incompatible specimens/units;
- source range, General Guidance, and no-range states are visually distinct; and
- wording fixtures contain no diagnosis, treatment, universal-optimal-range, or causal claim.

### Deferred optional extension: intake and cloud-backed timeline

This milestone is not required for launch and does not start until the local two-report journey is
accepted and the on-device product demonstrates meaningful value. Existing intake code
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

### Deferred optional extension: cloud path

Cloud and Snap are considered together after the useful on-device core is accepted. No cloud or
intake implementation is dispatched during the import investigation. Existing designs below are
constraints for a possible later extension, not launch requirements or authorization to build it.

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
- any separately accepted cloud purchase/restore/exhaustion paths work in StoreKit sandbox; and
- cloud products stay hidden until cost and privacy evidence is accepted.

### Deferred optional extension: evidence-backed relationships

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

- concise onboarding that explains local mode and measured versus estimated data,
  adult-only scope, and the required import-pack download/verification without loading the model;
- privacy dashboard, app lock, support/FAQ, terms and privacy links;
- Full Export and local deletion;
- the proposed history unlock only after its limits and price are decided, including restore and
  continued access to existing records as specified in `MVP.md`; and
- deterministic showcase fixtures and App Store screenshot automation.

Completion criteria:

- fresh install completes onboarding without authentication; the verified import pack is downloaded
  through explicit setup and recognition then works offline. Setup remains reachable for existing
  installations, while viewing, correction, export, and deletion do not depend on pack availability;
- existing records remain viewable, correctable, exportable, and deletable in every purchase state;
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

Before enabling any later cloud products, run a separately authorized private fixture set through candidate
models with production image resizing/detail settings. Measure:

- useful schema-valid result rate;
- component/row recall and critical extraction error rate;
- median and tail latency;
- input/output tokens and provider cost by operation;
- retry and moderation/failure rate; and
- expected monthly cost at 300, 500, and 1,500 Snaps plus report allowances.

These historical cloud workload sizes are evaluation examples only. Earlier cloud prices and tiers
are retired launch proposals; `MVP.md` owns the current commercial direction.

## Release gates

### Gate A — local core, September 2

If the no-account two-report journey is not reliable, understandable, visually accepted, and
complete in under five minutes, do not dispatch cloud or intake implementation. The 95 percent
under-five-minute target is not yet passed; a PDFKit upstream improvement does not close Gate A
without the private aggregate and integrated physical-device evidence. Finish it first.

### Gate B — evidence, September 8

If range/explanation review is incomplete, ship only reviewed entries and show honest unsupported
states. Do not generate missing health copy at runtime.

### Gate C — later cloud cost and privacy (not a launch gate)

Before any future cloud launch, establish cleanup, idempotent charging, result encryption, purchase
restoration, and viable economics. Passing the local gate does not automatically authorize cloud work.

### Gate D — release candidate, September 20

Snap, cloud processing, cloud commerce, and intake relationships are already outside required launch
scope. Defer camera scanning, wider catalogue coverage, granular feedback, and encrypted restore
before compromising Files/Photos import, review/correction, clear measured history, ordinary Full
Export, deletion, onboarding, and support.

## Local release and deferred extension slices

1. **Accepted local shell** — three native tabs, variant-lab selection, neutral semantic visual
   foundation, localization resources, service container.
2. **Protected persistence** — migrations, repositories, protected files, deletion verification.
3. **Import source** — Files/Photos, password, page model, original retention.
4. **Privacy workspace** — full-screen PDFKit viewing, crop/rotation/direct redaction, exact artifact
   preview, verification.
5. **Candidate extraction** — strict PDFKit text-layer pages with per-page Vision fallback, Vision
   document/tables, measurement filtering, English/German locale parsing and fixtures, non-blocking
   Lithuanian stress coverage, per-section
   specimen context, deterministic validation, and structured-fixture candidate evaluation through
   #50 and #66. The selected PaddleOCR adapter uses the existing native runtime boundary; other
   model experiments remain isolated from the production dependency graph.
7. **Laboratory history and review** — compact draft, Reports, Records, Measurements, manual entry,
   source inspection, correction, provenance.
8. **Comparison** — canonical aliases, units, trends, missing/incompatible behavior.
9. **Education** — explanations, ranges/guidance, sources, signed catalogue.
10. **Local control** — export, deletion, app lock, support, privacy dashboard.
11. **Release** — fixtures, screenshots, metadata, device matrix, TestFlight, submission.

The remaining cloud/intake slices are deferred optional work, not release blockers:

12. **Cloud transport** — outbox, auth, consent, upload, status, result envelope.
13. **Cloud intelligence** — intake recognition, report fallback, candidate validation.
14. **Intake core** — cloud-useful capture, Log, Snap, manual entry, correction, inclusion.
15. **Commerce** — products, entitlements, usage ledger, warnings, restore.
16. **Relationships** — Potential Relationships and locally derived interval context.

Each slice is complete when its material reverse and failure states, privacy behavior, highest-risk
tests, and user-visible integrated flow are accounted for. Low-risk obvious wiring does not require
automated coverage merely to raise a coverage number.

## Deferred backlog

After the first release: Android, HealthKit/wearables, iCloud or another compliant sync design,
encrypted export/restore, custom providers/BYOK, barcode and multi-photo intake, notifications,
multi-person/caregiver features, mood/energy correlations, medication relationship analysis, broader
catalogues, and clinician sharing.
