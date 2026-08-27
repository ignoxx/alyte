# Issue 88 visual evidence

Captured on an iPhone 17 Pro simulator running iOS 26.5 with the existing Alyte development
client and synthetic showcase records. The Home and Labs paths were checked in light and dark
appearances, including tab switching, report-import launch, Lab Record open/back navigation, long
biomarker labels, and the native Liquid Glass tab bar.

A second acceptance pass used a clean synthetic report through Alyte's real local import path on an
iPhone 15 Pro simulator running iOS 26.5. The report was copied into protected local storage, read by
local OCR, reduced to four measurement-shaped candidates by the simulator semantic adapter, and
left unfinished at extraction review. Alyte was terminated and relaunched; Home surfaced the saved
work, and reopening it returned the same four candidates without rerunning import, OCR, or semantic
mapping. After confirmation, the imported Lab Report appeared separately from its Lab Record in
Labs, opened into its source-detail screen, and returned to the populated list.

- `home-empty-light.png` and `home-empty-dark.png`: one-action empty Home state.
- `labs-empty-light.png` and `labs-empty-dark.png`: one-action empty Labs state.
- `home-populated-light.png` and `home-populated-dark.png`: latest Lab Record, measured changes,
  and record history.
- `labs-populated-light.png` and `labs-populated-dark.png`: Lab Records and Biomarker history.
- `lab-record-detail-light.png` and `lab-record-detail-dark.png`: opened Lab Record detail before
  returning to Labs in both appearances.
- `home-to-labs.mov`: short Home-to-Labs tab switch, import-task presentation, and return recording.
- `labs-imported-report-light.png` and `labs-imported-report-dark.png`: the real imported source row
  shown separately from its confirmed Lab Record.
- `lab-report-detail-light.png` and `lab-report-detail-dark.png`: imported source integrity and local
  source actions, followed by verified back navigation.
- `unfinished-draft-home-light.png` and `unfinished-draft-home-dark.png`: relaunched Home with saved
  extraction-review work still present after terminating the app before confirmation.

All imported content used the repository's de-identified synthetic fixtures. No schema,
persistence, extraction, native-module, dependency, or clinical-content change was made for this
acceptance pass, and no physical device was accessed.

Reference patterns adopted for this pass are documented in
[`docs/design-lab-reference-study.md`](../../design-lab-reference-study.md), which covers the
pinned T3 Code revision and 13 additional first-party-quality iOS references. For T3 specifically,
the pinned `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e` source/build material was directly inspected
in a disposable checkout. The concrete patterns carried into Alyte are native stack-owned titles,
semantic system colors, compact rows with press feedback, and shaped surfaces reserved for
meaningful summaries. No direct T3 screenshot or simulator access is claimed.
