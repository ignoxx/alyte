# Alyte local shell design-lab reference study

Issue #28 uses public product pages and store imagery because Appllama MCP is unavailable. The study
covered fourteen relevant screen states on 23 August 2026. Patterns are extracted; no competitor
identity, copy, scores, ranges, or medical conclusions are reproduced.

| Reference screen | Pattern observed | Alyte lab use |
|---|---|---|
| Apple Health Summary | A small set of prioritized highlights precedes the full browse surface. | Quiet gives the latest report and three measured changes priority. |
| Apple Health Browse | Categories support discovery without making the dashboard equally dense. | Library separates a biomarker index from source reports. |
| Apple Health trend detail | Dates and measured values remain the visual anchors. | Timeline uses collection dates and literal before/after values. |
| Apple Files Recents | Recent source objects are immediately scannable by title and metadata. | Labs rows lead with laboratory, date, and Measurement count. |
| Apple Files Browse | Source organization is distinct from recency. | Labs is a source library while Home provides interpretation hierarchy. |
| Apple Preview document browser | Import/open is a direct document action rather than dashboard decoration. | Import is a single native task presented above tabs. |
| MyChart home | Clinical destinations are peers in native navigation. | Home, Labs, and Settings remain exactly three native peer tabs. |
| MyChart Test Results | Test groups use compact rows with dates and source context. | Populated Labs uses restrained report and collection rows. |
| Function Health results home | Latest results summarize a large body of lab data. | Library explores denser biomarker-first scanning without scores. |
| Function Health biomarker detail | Current value and dated history are visually separated. | Current and prior measured values are explicit, never interpolated. |
| InsideTracker Bloodwork | Biomarker collections support compact scanning. | Library tests a data-oriented index, excluding proprietary scoring. |
| Guava lab trend | Longitudinal results make time the primary relationship. | Timeline makes report chronology the organizing spine. |
| Ornament lab-results overview | Biomarker and report collections coexist as separate groupings. | Library shows an index and source reports as distinct sections. |
| Pinned T3 Code mobile implementation at `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e` | Direct code/build inspection of `HomeScreen.tsx`, `EmptyState.tsx`, `FileTreeBrowser.tsx`, and `Stack.tsx`: native stack titles, compact rows, semantic surfaces, and native press states. No direct screenshot access was claimed. | All variants use system titles/colors, compact rows, and reserve shaped surfaces for harness or summaries. |

Public sources: Apple Health product/support pages, Apple Files App Store and iPhone User Guide,
Johns Hopkins MyChart guidance, Function Health product/Google Play imagery, InsideTracker App Store
and Bloodwork pages, Guava product/lab-results pages, Ornament product/app pages, and the pinned T3
Code mobile implementation described in `docs/REFERENCE-REPOS.md`. T3 patterns were verified by
checking the pinned revision's source/build material in a disposable checkout; this pass did not
use or imply direct access to a T3 screenshot or simulator window.

Direction hypotheses:

- **Quiet:** best when the first question is “what is my latest report?”; whitespace and one action.
- **Timeline:** best when collection chronology is the durable mental model; explicit vertical spine.
- **Library:** best for repeated lookup; compact biomarker index and source organization.

Shared rules: one accent per direction; 4-point spacing; 10/16/22 continuous corner scale; native
large titles, native tabs, native modal motion; rows highlight/opacity rather than scale; no custom
tab animation. Every displayed value is deterministic synthetic measured data.
