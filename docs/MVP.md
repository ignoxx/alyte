# Alyte MVP

## Status

This is the evolving product specification for the first public release. Decisions are captured as
they are confirmed during the MVP grilling session; unresolved detail is not silently assumed.

## Release constraint

The first public App Store release must qualify for Shipaton 2026 by launching no later than
September 30, 2026 at 11:45 PM PDT. Scope is cut to protect a feature-complete build, device testing,
App Review, and submission materials before that deadline.

## Product promise

Alyte primarily helps people import their historical blood-test reports and understand how
their measured biomarkers changed over time.

Intake awareness is a supporting part of the product: people can record what they put into their
bodies and explore evidence-based ways those inputs might relate to biomarkers. It must not weaken
the completeness or reliability of the laboratory-history experience.

Delivery is sequential. Alyte first ships internally as an excellent account-free laboratory-
history product. Intake capture and optional cloud intelligence remain required product slices,
but their interface is introduced only after the complete local two-report journey passes its
device acceptance gate. The local phase does not expose incomplete Snap, Log, account, or paywall
surfaces merely to reserve their future position.

The first-release intake slice is deliberately narrow:

- quick structured logging for food, drinks, supplements, and medications;
- an Intake Event may record a name, approximate amount, unit, and time when applicable;
- optional cloud recognition of an Intake Image, with automatic editable results and targeted
  review only when recognition is uncertain;
- approximate nutrition patterns rather than calorie goals or exact photo-derived macros; and
- possible intake-to-biomarker relationships only where the first-release evidence catalogue
  explicitly supports them.

An Intake Image may depict a meal, drink, supplement, medication, package, label, or ingredient
list. Medication entries are retained in the timeline, but medication-influence analysis,
medication interactions, and dosage guidance are not part of the first release. Barcode scanning,
meal plans, streaks, and multi-photo analysis are also excluded.

An image of supplement or medication packaging may produce a probable product name and printed
strength. It never establishes the amount consumed: quantity and dose remain `unknown` until the
person enters or confirms them. Alyte does not infer consumption from visible pills or
package instructions.

## Launch audience

The first release serves:

- adults who receive occasional or recurring routine blood tests and currently have scattered lab
  reports; and
- quantified-self users who already pay attention to food, supplements, or other inputs and want
  those observations alongside measured history.

It is not initially designed for clinicians, caregiver-managed profiles, or disease-specific care.
It is intended only for adults aged 18 or older. The App Store age rating is overridden to the
applicable 18+ rating and the minimum age is stated in the terms. The first release does not add an
in-app age prompt or collect a birth date.

## Release success criterion

A person with two real Lab Reports can, without creating an account:

1. import both reports;
2. review and correct extracted Measurements; and
3. understand the important measured changes in under five minutes.

This journey is the non-negotiable release path. Other features compete for the time remaining after
it is reliable, understandable, private, and polished.

The 95 percent under-five-minute Gate 1 target remains open until private aggregate evaluation and
integrated physical-device acceptance demonstrate it. Improving one upstream extraction source does
not by itself pass the gate.

Without an account or any cloud processing, the app remains a complete local laboratory-history
tool: people can import reports, review all extracted results, read concise educational context for
supported Biomarkers, and understand Measured Trends across multiple Lab Records.

## Primary navigation and empty state

The account-free laboratory phase has three native iOS peer destinations:

- `Home` summarizes the person's laboratory history and the next useful action;
- `Labs` owns Lab Reports, Lab Records, Measurements, and Biomarker history; and
- `Settings` owns local privacy, export, deletion, protection, support, preferences, and—only after
  the cloud slice is enabled—cloud account and subscription controls.

Insights are embedded beside the records and trends that produced them rather than separated into a
fourth destination. After onboarding, an empty app contains one obvious primary action:
`Import Lab Report`. It does not advertise intake capture that cannot yet produce useful analysis.

Once reports exist, Home shows the latest report, unfinished import or review work, at most a few
important measured changes since the previous compatible record, and recent reports. It is not a
day log, global health score, warning dashboard, or predicted-biomarker surface.

The later cloud/intake slice must integrate with this accepted shell without making the local
product incomplete or unexpectedly rearranging navigation at sign-in. Its final capture placement
is decided and device-tested when that slice begins; the current phase does not reserve a dead Snap
or Log tab.

When cloud intake is enabled, a Snap means `I consumed this now`. It opens the camera immediately,
saves durably, queues analysis, and returns without forcing the person to remain on a result screen.
A separate `Analyze label/reference` action can inspect packaging without recording consumption.

The expected engaged-use case is approximately 8–10 Snaps per day: three meals, snacks, drinks,
supplements, medications, or other relevant inputs. Subscription allowances and backend capacity
must support roughly 240–300 monthly Intake Image analyses as ordinary behavior, with practical
headroom rather than treating it as abuse.

## Confirmed product boundaries

- iOS 26 or later, with an English interface that is localization-ready. The MVP deliberately
  targets the iOS 26 native component set, including UIKit's native tab-bar materials. Older iOS
  versions are not supported; the supported floor is the iOS 26-compatible iPhone lineup.
- Core laboratory-history functionality works locally without an account.
- Measured values and inferred possible influences remain visibly and conceptually distinct.
- The app does not invent or predict concrete biomarker values.
- The app does not diagnose conditions, make causal claims, or recommend treatment or dosage
  changes.
- HealthKit, wearables, Android, multi-person profiles, caregiver sharing, and cloud synchronization
  are outside the first release.
- User-configured providers, BYOK, custom OpenAI-compatible endpoints, and an open-source backend are
  post-MVP. The internal backend boundary may remain provider-neutral without exposing credentials
  or routing controls to users at launch.
- Core local functionality does not require Apple Intelligence, an account, or a network connection.
  PDFKit text-layer extraction with per-page Vision fallback, deterministic validation, privacy
  review, history, charts, reviewed content, record management, manual entry, and export remain
  account-free.
- The accepted local import pipeline uses one reviewed on-device document model. Its single
  verified Qwen3-VL 2B pack is a mandatory onboarding dependency. Onboarding downloads and verifies
  the pack without loading it; the app loads it only immediately before the import stage that needs
  it and unloads it after success, failure, cancellation, backgrounding, or memory pressure. The
  MVP exposes no model picker.
- Every report language follows that same PDFKit/Vision, layout reconstruction, document-model, and
  source-grounding pipeline. English and German are the launch accuracy benchmarks, not routing
  gates. The model transcribes source labels verbatim; reviewed catalogue aliases may resolve known
  labels to canonical English display names, while unknown labels remain preserved rather than
  being model-translated.

## Laboratory-history model

- A `Lab Report` is an imported source document or image.
- A `Lab Record` groups Measurements by specimen-collection event.
- One Lab Report may contain more than one Lab Record when it contains multiple collection dates.
- A `Measurement` is one observed value for one `Biomarker` in one Lab Record and retains its
  `Specimen Type` when known.
- A `Panel` is an optional grouping of related Measurements; it is not synonymous with a Lab
  Record.
- Trends use specimen-collection dates. Report creation and delivery dates do not substitute for a
  known collection date.

Laboratory results have three independent support levels:

1. **Preserved** — retain any result the laboratory provides.
2. **Comparable** — chart only results whose Biomarker, Specimen Type, value type, and units are
   safely compatible.
3. **Influence-linked** — relate Intake Events only to a curated subset of Biomarkers.

A result can therefore be preserved or charted without being eligible for intake-influence
insights.

The first comparable catalogue contains:

- total cholesterol, LDL-C, HDL-C, and triglycerides;
- glucose and HbA1c;
- hemoglobin, hematocrit, MCV, and ferritin;
- ALT, AST, and GGT;
- total 25-hydroxyvitamin D; and
- total serum or plasma vitamin B12.

All other extracted results are still preserved with their original label, value, unit, reference
information, Specimen Type, and source provenance. They remain outside normalized trend charts
until a later catalogue version supports them.

Each Comparable Biomarker has a reviewed local explanation covering what it measures, why it is
commonly measured, major non-diagnostic context, factors that can affect the result, and
authoritative sources. These explanations are versioned factual content; a model does not create
them on demand. Unsupported results retain their complete report context but receive no invented
local explanation.

### Reference information and general guidance

- A Measurement's laboratory-provided reference interval and flag are shown first and preserved
  exactly as report provenance.
- A separately labelled `General guidance` layer may be shown only when the evidence catalogue has
  an authoritative, versioned threshold whose applicability is known for that Measurement.
- When the report provides no reference interval, eligible General guidance may act as the
  fallback. If no applicable guidance exists, the app says that no comparison range is available;
  it does not manufacture one.
- General guidance records authority, jurisdiction, publication/version, review date, units,
  boundary semantics, and applicability requirements such as fasting status or physiological
  context. Disagreement between authorities is disclosed rather than silently resolved.
- Alyte does not label a universal range `good`, `healthy`, or `optimal`, and General
  guidance never overwrites the laboratory's own flag or becomes a personal treatment target.

The comparable catalogue is not a ceiling on educational evidence. An Influence-linked Biomarker
may appear in a verified Potential Relationship even when the app cannot yet normalize or chart it.
In that case the interface states that the relationship is general information and that the
Biomarker is not currently included in the person's comparable laboratory trends.

## Import boundary

- The required import sources are PDF documents selected through Files and images selected through
  Photos.
- An integrated camera document scanner is a stretch feature, not a launch requirement.
- A user can create a laboratory record and its Measurements manually without attaching a Lab
  Report.
- A user can correct every extracted date, name, value, unit, and reference interval before saving.
- For each PDF page, local extraction first asks the strict `alyte.pdf.text-layer.v3` PDFKit adapter
  for a complete text-layer result from the protected Original Report. A trusted page contributes
  only its PDFKit observations. An unavailable or untrusted page uses only Vision recognition; image
  imports and image-only PDF pages use Vision as well. PDFKit and Vision observations are never
  merged for the same page. Both paths preserve source text and page geometry as internal
  provenance; only table rows or other measurement-shaped candidates enter an Extraction Draft.
  Headers, addresses, licences, footers, and unrelated prose do not become user review work.
  Selectable-text pages detect English or German locally from bounded page text before deterministic
  parsing. Sparse, mixed, unsupported, or uncertain pages remain language-unknown instead of
  inheriting the phone locale; deterministic extraction and review still continue.
- On a trusted selectable-PDF page, a supported laboratory Result header may identify a repeated
  result column before candidate parsing. A physical row with exactly one result-column anchor is narrowed
  to that source-backed value; zero or multiple plausible anchors remain focused review work. A
  missing or contradictory header fails open instead of hiding candidates. This admission policy is
  not applied to Vision pages until scanned-report evaluation proves an equivalent boundary.
- The Original path and immutable hash are verified immediately before and after every native page
  read. Wrong passwords, cancellation, a missing Original, or a hash mismatch are actionable hard
  failures. An unavailable or untrusted PDF text layer is a normal per-page Vision fallback.
- Recognition of a specific Biomarker depends on the supported alias catalogue and semantic
  validators. An unknown measurement-shaped result is preserved with its original label and shown
  as unsupported; an arbitrary OCR line is not treated as a result merely to avoid dropping it.
- Specimen context is resolved per section, table, or row rather than once for an entire Lab Report.
  A mixed report may therefore keep blood, serum, and plasma Measurements separate from urine or
  other specimen results. Uncertain specimen context remains visible for review instead of being
  silently discarded.
- Launch import quality is gated on English first and German second. Checked-in extraction identity
  rules advertise only those two report languages for the MVP. A
  Lithuanian report remains a useful non-blocking stress case for locale and layout robustness, but
  its accuracy does not block release or drive architecture. Other report languages are best effort:
  Alyte preserves credible source-backed rows for review without claiming supported mapping.
  The interface itself remains English-only. When a German or other source label resolves safely
  to a Biomarker, the interface shows its reviewed canonical English name while retaining the exact
  original label beside it and in provenance. Resolution never replaces source text or imply that
  the Biomarker is comparable or evidence-backed. Fixtures still cover OCR, aliases, decimal
  formats, dates, units, bounds, and categorical results.
- The app imports and retains laboratory-provided results beyond blood-derived Measurements. The
  levels of support for storage, longitudinal comparison, and intake-influence insights remain
  intentionally separate and need to be defined precisely.
- Numeric, bounded (`<` or `>`), categorical, and free-text results can be retained. Only exact
  numeric Measurements with safely compatible units participate in ordinary numeric trend lines.
- When OCR finds no collection-date context, extraction starts each Lab Record/specimen group with
  one captured device-local calendar date. The draft labels that date as defaulted, keeps the
  Original Report date fields null, and lets the person edit the group date once before
  confirmation. Ambiguous, invalid, or multiple collection-date candidates remain missing and
  reviewable; report-issued and birth dates are never substituted.
- Local extraction always opens as an editable draft. Structurally and semantically valid
  Measurements are included by default; genuine ambiguities are highlighted individually. The
  person reviews a compact grouped table, can inspect or edit any candidate, and resolves only the
  exceptions before confirmation. Nothing becomes confirmed history until that review completes.
- When local extraction is incomplete or unusable, the person can retry the calm Import → OCR →
  Review journey, enter results manually, or explicitly request later paid cloud
  extraction. The report-keyed operation status survives suspension/relaunch as an honest
  interrupted/retry state, and the Original Report itself remains locally available even when no
  structured result can be recovered. Drafts from before the artifact-provenance contract are
  explicitly invalidated for regeneration rather than being treated as Original-derived.
- One cloud Lab Report import accepts at most 20 user-selected pages and 25 MB. A larger document
  remains intact locally but must be split into transparent cloud batches; the page selection and
  resulting usage are shown before upload.

When one Lab Record is opened, a concise summary of measured changes and laboratory-provided flags
appears above the complete Measurement list. Nothing is hidden merely because it is unchanged or
unflagged. Each Measurement can reveal its source value, reference information, explanation,
provenance, and correction controls.

## Local and cloud data boundary

- Original Reports and the structured local history remain on-device and are the source of truth.
- The app sends data to the backend only after an explicit user action for a feature that requires
  cloud processing.
- A cloud request contains only the information necessary for that operation. The backend is a
  processor, not the health-record store.
- Health payloads are not retained server-side by default. Processing results return to the device
  for local storage.
- If a document must leave the device, the app sends a Sanitized Report or a smaller extracted-data
  payload rather than the Original Report whenever the operation permits it.
- Cloud account deletion removes the account and app-controlled server data without deleting local
  records or making local mode unusable. A maximum-24-hour unlinkable HMAC credential/nonce replay
  marker may remain solely to reject captured authentication replay; it contains no account ID,
  token, response, health data, or exportable user content and then expires.
- Data export covers both the complete local dataset and any app-controlled cloud account data.

The first-release backend performs only:

- enhanced Lab Report extraction when local OCR and parsing are insufficient and the user requests
  cloud processing; and
- vision analysis of an Intake Image when recognizing or structuring its contents requires a more
  capable model.

On-device OCR, local parsing, deterministic unit conversion, charts, and local record management do
not depend on the backend.

Longitudinal matching also remains local. After a cloud result has structured an Intake Event and
resolved candidates to approved Evidence Relationships, the device compares repeated events with
compatible Lab Records and produces Related Wellness Context without uploading the person's full
intake and laboratory history.

Cloud models may recognize Intake Components, infer likely nutrition properties, select relevant
Evidence Relationships, and explain them in plain language. Every displayed Related Wellness Context
must reference approved evidence identifiers and pass deterministic validation. A model cannot
introduce a health relationship that is absent from the evidence catalogue.

The model proposes up to five Influence Candidates without receiving the list of Comparable
Biomarkers. A separate evidence-validation step determines which candidates may be displayed. The
app never fills a quota with unsupported suggestions: zero, one, or two grounded relationships are
better than five plausible inventions.

In the first release, only Evidence Relationships reviewed and shipped in the versioned catalogue
may pass validation. Runtime model research cannot approve a new health relationship. When one or
more Influence Candidates cannot be verified, the app may say that other possibilities were
considered but not supported strongly enough to show; it does not name the unsupported Biomarkers.

Each Measured Trend and Related Wellness Context explains how it was produced. Related Wellness
Context shows the relevant logged inputs, interpreted property, Evidence Relationship, time
horizon, caveats, and source material in a simple progressive-disclosure presentation.

The first release may place a person's logged interval and Measured Trend beside general research,
but it does not conclude that the intake caused or probably contributed to the change. Safe wording
is: `During this interval you logged [pattern]. [Biomarker] [changed]. Research describes a general
relationship between them. Alyte cannot determine why your result changed.`

## Snap completion and correction

- Taking a Snap saves its Intake Image locally, creates a pending Intake Event, queues the enabled
  cloud analysis, and immediately returns the person to the app.
- Without connectivity, the Snap remains a visible local pending event. If cloud auto-analysis is
  enabled, it uploads automatically when connectivity returns; the person can cancel before upload.
- A schema-valid result automatically populates the editable Intake Event; routine use does not
  require a confirmation screen after every image.
- Recognition uncertainty is attached to the relevant fields or components and presented as a
  simple `Check this` state, not as medical confidence.
- A result marked `Check this` appears in the daily timeline but is excluded from longer-term
  Related Wellness Context until the person reviews it.
- The person can change the event type, name, components, amount, unit, and time; dismiss a
  misidentified item; or delete the event and image.
- Correcting structured data and regenerating catalogue-backed context locally does not consume
  another cloud operation. Reanalyzing the image with the cloud does.
- Recent and optionally saved Intake Events expose `Log again`. It copies their structured
  components, uses the current time, saves immediately, and offers a brief Undo/Edit action. It
  consumes no cloud operation unless the person explicitly requests fresh image analysis.
- Every Intake Event can be marked `Exclude from analysis` without being deleted. This reversible
  local state keeps the event and media visible in history but prevents them from contributing to
  future Related Wellness Context. Undo, correction, exclusion, and deletion remain distinct.
- Excluding or materially correcting an event marks any affected saved insight invalid and
  regenerates current Related Wellness Context locally. An Invalidated Insight may remain visible in
  history with the reason it is no longer current; it never continues as an active conclusion.

## Redaction

- When the person explicitly prepares a future cloud upload, a focused privacy workspace opens
  above the tabs. It presents one aspect-correct full-resolution page at a time with native zoom,
  pan, page navigation, direct redaction, undo, and compact page-transform controls. It does not
  render tiny pages inside a scrolling form.
- On-device recognition may propose regions that contain names, addresses, identifiers, dates, or
  other personal information. The person reviews, adds, adjusts, or removes them.
- Sanitization is reserved for a future explicit cloud upload. Before that action exists the local
  journey does not require a derivative. When a derivative exists, the actions are
  `View Sanitized Report` and `Edit Redactions`.
- The Original Report remains immutable and separately accessible. Local OCR and extraction read
  that Original. The Sanitized Report is a separate, future cloud-submission artifact and never
  replaces local provenance.
- The app shows the exact Sanitized Report that a later export or cloud operation would use.
- Sanitization creates a newly rendered, flattened artifact with selected content, hidden text,
  annotations, and recoverable metadata removed. A removable rectangle is not a redaction.

## Portability and account independence

- Users can create a Full Export of all locally held records and all app-controlled cloud account
  data. No user-controlled record is omitted merely because it is sensitive or unsupported by the
  current catalogue.
- A Full Export contains a versioned manifest; Lab Records and Measurements as JSON and CSV; Intake
  Events and Intake Components as JSON and CSV; saved insights, evidence versions, and Insight
  Feedback as JSON; and, when selected by the user, Original Reports, Sanitized Reports, and Intake
  Images.
- The export flow makes inclusion of sensitive source media explicit and warns that the exported
  archive leaves Alyte protection.
- Users can export all app-controlled data held for their cloud account.
- Deleting a cloud account deletes its app-controlled cloud data but leaves local records intact,
  subject only to the short-lived unlinkable replay-marker boundary above.
- Signing out or deleting the cloud account returns the app to fully usable local mode.
- Personal health records, reports, Intake Images, and their encryption keys are excluded from
  iCloud storage and iCloud Backup for the first release because current App Review rules prohibit
  storing personal health information in iCloud.
- Full Export is the first-release recovery and portability mechanism. Full Export restore and live
  synchronization are outside the first release.

Normal iCloud Backup does not provide live synchronization. A future sync feature requires an
explicit CloudKit or backend data model, identity mapping, encrypted transport and storage, deletion
semantics, deterministic conflict handling, and prior confirmation that the chosen design complies
with Apple's health-data rules; it is outside the first release.

## Optional cloud account

- First launch and all local functionality work without an account.
- Sign in with Apple is requested only when a person first chooses a paid cloud operation.
- The cloud account authenticates processing and entitlements; it does not own the local dataset.
- Signing out preserves local records and immediately returns to local mode.
- Signing in on another phone can restore the paid entitlement but does not synchronize health
  records in the first release.
- Cloud-account deletion explains that App Store subscription management is a separate Apple
  action.

## Personal profile

- The first release does not require or collect age, birth date, weight, sex, or gender merely for
  possible future use.
- The app uses the reference information preserved from the Lab Report rather than recalculating a
  range from an inferred profile.
- A personal field is added later only when a defined user-visible feature requires it and its use
  can be explained precisely.

## Cloud disclosure and retention

- Before a Lab Report upload, the app previews the exact Sanitized Report and confirms every
  submission.
- Before the first Intake Image analysis, the app explains what will be sent, to whom, why, and for
  how long. Later analyses begin only through an explicitly labelled cloud-analysis action.
- After that disclosure and consent, pressing the clearly cloud-badged Snap action is the explicit
  upload action; the app does not add another confirmation after each shutter press. A persistent
  camera control can switch to local-only capture without disabling local logging.
- A presentation preference may make explanations concise or detailed, but it cannot remove the
  indication that data leaves the device, the distinction between measured and inferred content,
  or access to evidence and provenance.
- Server-side persistent data is limited to the account identifier, entitlement, consent-policy
  version, coarse usage counters, and non-sensitive operational timestamps.
- An accepted asynchronous operation returns an opaque Cloud Request ID. The app can leave the
  result screen and later fetch status or retrieve the result using that ID.
- Reports, images, Measurements, Intake Components, health prompts, and generated health
  explanations never enter application logs. Submitted media leaves cloud memory as soon as the
  provider operation no longer needs it. A schema-valid result may remain in a short-lived
  retrieval cache for at most 24 hours, then is deleted. The cached result is encrypted for the
  requesting device and is deleted earlier after successful fetch.
- Provider retention must be zero or minimal and disclosed before a request is sent.
- A paid allowance or credit is consumed only after a cloud request returns a schema-valid, usable
  result. Provider errors, timeouts, malformed responses, safety refusals, and unusable extraction
  do not consume it.
- Editing recognized components and regenerating catalogue-backed insights locally is free. A new
  image submission that requires fresh vision processing is a new paid operation.
- Cloud processing may reserve one allowance unit while an operation is running. It consumes the
  unit when the backend produces a schema-valid, usable result, even if the device never fetches it;
  the first release does not implement a post-delivery refund protocol.
- Genuine delivery or billing disputes are handled through Support.

## Local document retention

- Original Reports, Sanitized Reports, and confirmed structured results are kept on-device by
  default until the person deletes them.
- The backend holds report content only transiently while a request is active; it does not add
  report content to durable application storage or logs.
- Password-protected PDFs are detected locally and prompt for their password on-device. The
  password is never sent to the backend, persisted, logged, or included in an export. The app keeps
  the password-protected Original Report and creates a separate decrypted copy protected by the
  app's local encryption for processing. It forgets the password immediately after decryption.

## Local access protection

- People can optionally require Face ID, Touch ID, or the device passcode when opening the app.
- Sensitive content is obscured in app-switcher snapshots.
- A configurable short grace period prevents needless repeated prompts without weakening at-rest
  file protection and database encryption.

## Deletion scopes

- An Original Report can be deleted while its reviewed Measurements remain; provenance then states
  that the source was deleted by the user.
- A Lab Record and its Measurements can be deleted while its Original Report remains.
- An Intake Image can be deleted while its confirmed Intake Event remains.
- A person can delete an entire record together with its associated source media.
- Deleting all local data and deleting the optional cloud account are separate, explicit actions.

## Insight feedback

- A user can challenge a Measured Trend by reviewing its source Measurements and can challenge or
  dismiss a Potential Relationship or Related Wellness Context.
- Insight Feedback distinguishes: incorrect recognition, incorrect amount or frequency, personally
  irrelevant relationship, unclear or misleading explanation, hide this relationship, and an
  optional private note.
- Incorrect recognition or quantity routes to editing the underlying Intake Event before
  regeneration.
- A dismissed Evidence Relationship is suppressed from future highlights for that person but
  remains available in history and can be restored through `Reset insight preferences`.
- Insight Feedback is stored locally. Only the minimum relevant preference identifiers accompany a
  future cloud request.
- Feedback is not used for global model training without a separate explicit opt-in. A person's
  dismissal does not rewrite scientific evidence.

## Insight timing

- Immediately after an Intake Event, the app may show general Potential Relationships using
  wording such as `may influence when consumed regularly`.
- Related Wellness Context requires repeated Intake Events over the time horizon supported by its
  Evidence Relationships and at least two compatible Lab Records.
- It may report whether the directions align, do not align, or lack enough information, but it
  never upgrades that temporal alignment into a personal causal or contributory claim.

## Explanation presentation

People can choose a default explanation density:

- `Compact` shows the conclusion, a permanent measured-or-inferred label, and a visible `Why?`
  action.
- `Standard` adds a short reasoning chain and source count and is the default.
- `Detailed` shows relevant inputs, interpreted properties, time horizon, evidence strength,
  caveats, sources, model/provider, and catalogue version.

This preference never hides that data leaves the device, whether content is inferred, or how to
reach its evidence and provenance.

## Educational next steps

- The first release may explain general factors associated with a Biomarker, important context that
  can affect interpretation, useful questions to consider, and when professional discussion could
  help.
- It does not generate personalized diet, supplement, medication, testing, or treatment plans.
- Actions lead to reviewed educational content, sources, reviewing the underlying data, adding
  missing context, or contacting a qualified professional—not to an automated regimen.
- A disclaimer does not permit copy that otherwise functions as personalized medical instruction.

## Qualitative nutrition presentation

- Alyte does not present exact calorie, protein, carbohydrate, fat, or micronutrient totals
  as the primary output of an Intake Image.
- Individual events and the Home day view use broad, explicitly estimated buckets such as lower,
  moderate, or higher energy and likely protein-rich, fiber-containing, or saturated-fat-heavy.
- Buckets remain editable consequences of the recognized Intake Components and portion context;
  they are not measured nutritional facts.
- The cloud result contains broad internal numeric ranges plus recognition and portion context.
  Versioned deterministic rules convert those ranges into displayed Nutrition Buckets; a model does
  not freely invent the meaning of `low` or `high` for each request.
- When an ordinary photo cannot support a literal nutrition claim, the interface uses qualified
  wording such as `likely protein-rich` or `estimated lower-energy`. Verified label data may use a
  deterministic claim only when its published criteria are actually met.

## Notifications

The first release sends no notifications. Logging reminders, unfinished-draft reminders, cloud
messages, medication reminders, biomarker warnings, and inferred-health alerts are all deferred.

## Free and paid principle

- Functionality performed entirely on-device is free.
- Any operation that sends data to the Alyte backend is paid because each request creates an
  ongoing processing cost.
- Local Lab Reports, local OCR, manual Lab Records, supported Measured Trends, manual Intake Events,
  local export, and account-free use are not held behind a subscription.
- Local extraction remains available without an Alyte account, subscription, or network connection
  after the required import pack has been installed and verified.
- Cloud report extraction and Intake Image analysis require a paid entitlement.
- Launch offers one `Cloud Plus` subscription with monthly and annual billing and an included
  monthly Cloud Analysis allowance. A bounded starter purchase and a way for subscribers to obtain
  additional capacity may sit alongside it.
- Provisional launch pricing is EUR 6.99 per month or EUR 59.99 per year.
- The launch allowance must cover both frequent Intake Image analyses and rare cloud Lab Report
  extractions. The earlier provisional limit of 30 total operations is rejected as too low; the
  first pricing fixtures use separate, plainly described allowances despite presenting one simple
  subscription benefit.
- An ordinary engaged user is expected to submit approximately 240–300 Intake Images per month, so
  the base paid experience requires meaningful headroom above that range.
- The provisional `Cloud Plus` fixture is 500 Snap Analyses and 4 cloud Lab Report imports per
  month at EUR 6.99 monthly or EUR 59.99 annually.
- The provisional `Cloud Max` fixture is 1,500 Snap Analyses and 12 cloud Lab Report imports per
  month at EUR 12.99 monthly or EUR 109.99 annually.
- Both tiers reset monthly without rollover. Final prices and allowances may change after
  representative usage, cost, quality, and abuse testing; the app never silently reduces an active
  subscriber's purchased entitlement.
- Final pricing and allowance are confirmed only after representative fixture tests establish
  provider, retry, backend, Apple commission, and support cost envelopes.
- A Cloud Analysis consumes the allowance only after a schema-valid, usable result is returned.
- When the included allowance is exhausted, local mode remains fully usable and the next reset date
  is shown. A Cloud Plus subscriber may upgrade to Cloud Max for additional monthly capacity rather
  than purchasing a carryover credit balance.
- If Cloud Max is exhausted, further cloud analysis pauses until reset; the first release adds no
  third tier or boost. Exceptional legitimate cases can contact Support.
- A one-time EUR 0.99 `Starter Pack` for new cloud users provides five Snap Analyses plus one
  cloud Lab Report import after Sign in with Apple. It is paid, does not start a subscription, and
  any unused purchased contents do not expire.
- Exact allowance details are always available in the paywall and Settings. Home shows no permanent
  counter; the app gives clear notices at approximately 80%, 95%, and exhaustion.
- The product must maintain a positive margin at the tested high-usage boundary; a cheap price is
  not allowed to create an uncapped loss.
- Shipaton judges receive access through an offer or promotional code.

## Evidence publishing

- Research agents may find candidate authoritative sources and draft explanations.
- A human publisher approves every Biomarker explanation and Evidence Relationship before it enters
  the versioned catalogue; agents cannot self-publish factual health content.
- Every entry records its sources, content version, review date, evidence strength, time horizon,
  and caveats.
- The launch catalogue remains narrow enough to review thoroughly. Qualified clinical or
  dietetic review is preferred for all influence content before public release.
- A reviewed baseline catalogue ships inside the app. Free, signed catalogue updates may download
  without an account because they contain no personal data and perform no user-specific cloud
  analysis.
- Saved insights retain the exact catalogue version that produced them. A catalogue update may
  trigger local revalidation, but it never silently rewrites historical provenance.

## Diagnostics and product analytics

- The first release relies on Apple's privacy-preserving aggregate App Store analytics and scrubbed
  MetricKit crash and performance diagnostics.
- Reports, biomarker values, Intake Events, images, prompts, extracted text, and generated health
  explanations are never analytics properties or diagnostic attachments.
- Optional first-party product-event analytics require explicit opt-in and use coarse events such
  as onboarding completion, import success/failure class, or paywall conversion without health
  payloads.
- The first release includes no default-on third-party behavioral analytics SDK.

## Onboarding and support

- First launch uses a concise sequence covering the product promise; local-first/no-account privacy;
  the need to verify imports and distinguish measured results from general research; the required
  import-pack download and verification; and a Ready handoff. Model setup never activates or loads
  the runtime. Onboarding never forces account creation or a paywall.
- Detailed teaching is contextual and appears when the person first imports, verifies, analyzes,
  or explores evidence rather than lengthening the opening tour.
- Settings provides clear Contact, Feedback, and Billing Help actions for complaints or assistance.
- Those actions open a dedicated support/FAQ page or a mail composer with a scrubbed template; the
  first release does not operate an in-app ticket database.
- Support messages never automatically attach reports, Measurements, Intake Images, prompts, or
  health explanations. Any sensitive attachment requires a separate, explicit user action.
- Optional diagnostics are scrubbed of health payloads and shown before sending.

## Publisher assumption

The first release will first be submitted by a solo developer resident in Germany using an
individual Apple Developer membership. This knowingly accepts the App Review risk created by
Apple's recommendation that healthcare or sensitive-information apps be submitted by a legal
entity. Forming a company or seeking advance Apple confirmation is not a launch prerequisite; an
organization conversion remains a fallback if review requires it.

## Measurement comparison

- Measurements share a Measured Trend only when canonical Biomarker, Specimen Type, value type, and
  tested unit-conversion rules are compatible.
- Bounded values such as `<5` or `>200` are preserved but do not become ordinary numeric points.
- Method, assay, direct-versus-calculated status, and fasting context remain attached when present
  and are disclosed when they change within a series.
- Original values and units remain available after normalization.
- When compatibility is uncertain, the app separates the series or declines to connect the points.
- User-facing trend summaries primarily say `increased`, `decreased`, `stable`, or `not comparable`.
  They do not convert direction into `improved` or `worsened`. Laboratory-provided flags and
  applicable General Guidance remain separate, and charts avoid universal red/green good-versus-bad
  encoding.
- If a Biomarker is absent from an intervening Lab Record, its chart plots only the dates on which
  it was actually measured and marks the intervening record as `not measured`. Straight connections
  may relate observed points, but the chart never creates a smooth inferred value between them.

## Open validation work

The product decisions are settled, but implementation must still validate:

- exact normalization factors and fixtures for the initial Biomarker catalogue;
- cost validation of the provisional subscription price and allowance;
- German trader, business-registration, tax, and public-contact implementation requirements.

## Deadline cut order

The first release first protects local laboratory history, Files/Photos import, compact extraction
review and correction, Measured Trends, irreversible redaction, ordinary Full Export, onboarding,
and support. Cloud Plus, enhanced report extraction, Snaps, and intake-to-biomarker relationships
remain planned launch slices only after the local acceptance gate stays green.

If schedule risk requires cuts, remove or defer in this order:

1. Cloud Max launch support;
2. wider intake relationship breadth;
3. integrated camera scanning for Lab Reports;
4. granular Insight Feedback categories while retaining basic correction and dismissal; and
5. password-encrypted Full Export while retaining the complete ordinary export and its warning.
