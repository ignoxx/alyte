# Issue 88 visual evidence

Captured on an iPhone 17 Pro simulator running iOS 26.5 with the existing Alyte development
client and synthetic showcase records. The Home and Labs paths were checked in light and dark
appearances, including tab switching, report-import launch, Lab Record open/back navigation, long
biomarker labels, and the native Liquid Glass tab bar.

- `home-empty-light.png` and `home-empty-dark.png`: one-action empty Home state.
- `labs-empty-light.png` and `labs-empty-dark.png`: one-action empty Labs state.
- `home-populated-light.png` and `home-populated-dark.png`: latest Lab Record, measured changes,
  and record history.
- `labs-populated-light.png` and `labs-populated-dark.png`: Lab Records and Biomarker history.
- `lab-record-detail-light.png` and `lab-record-detail-dark.png`: opened Lab Record detail before
  returning to Labs in both appearances.
- `home-to-labs.mov`: short Home-to-Labs tab switch, import-task presentation, and return recording.

The synthetic showcase contains Lab Records but no imported source `Lab Report` or unfinished
extraction draft, so those two review states were not fabricated for the visual pass. The import
launch itself was verified and preserves the Original Report privacy copy. The source-report and
draft-resume paths remain a fixture coverage blocker, not a simulator-permission blocker; creating
fake persisted source/draft data solely for this evidence would cross the presentation-only scope.

Reference patterns adopted for this pass are documented in
[`docs/design-lab-reference-study.md`](../../design-lab-reference-study.md), which covers the
pinned T3 Code revision and 13 additional first-party-quality iOS references. For T3 specifically,
the pinned `be7d35aaeb49a04483ec5e0d2284e8b5b70a3b6e` source/build material was directly inspected
in a disposable checkout. The concrete patterns carried into Alyte are native stack-owned titles,
semantic system colors, compact rows with press feedback, and shaped surfaces reserved for
meaningful summaries. No direct T3 screenshot or simulator access is claimed.
